# main.py

import os
import time
import asyncio
import base64
from dotenv import load_dotenv

import numpy as np
import joblib
import whisper
import openai
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from utils import RollingWindow

# ——— CONFIGURATION ——————————————————————————————————————————————
load_dotenv()
TFIDF_PATH   = "models/tfidf.joblib"
MODEL_PATH   = "models/scam_clf.joblib"
THRESHOLD    = 0.675      # 1 – P(Legit)

SAMPLE_RATE  = 16_000
CHUNK_SECS   = 10         # process every 5 s of audio
WINDOW_SECS  = 20        # keep last 10 s of history

CHUNK_SIZE   = SAMPLE_RATE * CHUNK_SECS

FIRST_MODEL   = "gpt-4o-mini-2024-07-18"
SECOND_MODEL  = "gpt-4o-2024-08-06"

# ——— SET UP OPENAI KEY —————————————————————————————————————————————————
openai.api_key = os.getenv("OPENAI_API_KEY")
if not openai.api_key:
    raise RuntimeError("Set OPENAI_API_KEY in your environment")

# ——— APP SETUP ——————————————————————————————————————————————————————
app = FastAPI(title="Scam‑Call Guard")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ——— LOAD ML ASSETS ONCE ————————————————————————————————————————————
tfidf     = joblib.load(TFIDF_PATH)
clf       = joblib.load(MODEL_PATH)
legit_idx = list(clf.classes_).index("Legit")

text_window = RollingWindow(max_seconds=WINDOW_SECS)
model       = whisper.load_model("large")  # or "tiny" for sub‑500 ms

def score(text: str) -> float:
    proba      = clf.predict_proba(tfidf.transform([text]))[0]
    return float(1.0 - proba[legit_idx])

def pcm16le_from_base64(b64: str) -> np.ndarray:
    raw = base64.b64decode(b64)
    return np.frombuffer(raw, dtype=np.int16)

async def first_pass_cleanup(raw: str) -> str:
    """First GPT pass to fix Whisper typos."""
    resp = await asyncio.to_thread(
        openai.ChatCompletion.create,
        model=FIRST_MODEL,
        messages=[
            {"role":"system","content":(
                "You are an expert Arabic transcription editor. "
                "Given one Arabic sentence, correct typos and mis‑heard words only; "
                "return exactly the corrected sentence."
            )},
            {"role":"user","content": raw}
        ],
        temperature=0.0,
        max_tokens=200
    )
    return resp.choices[0].message.content.strip()

async def second_pass_scam_refine(cleaned: str) -> str:
    """Second GPT pass to rewrite any odd phrasing as a clear scam utterance."""
    resp = await asyncio.to_thread(
        openai.ChatCompletion.create,
        model=SECOND_MODEL,
        messages=[
            {"role":"system","content":(
                "You are an expert Arabic transcription editor. "
                "Given one Arabic sentence, correct typos and mis‑heard words only; "
                "return exactly the corrected sentence."
            )},
            {"role":"user","content": cleaned}
        ],
        temperature=0.0,
        max_tokens=200
    )
    return resp.choices[0].message.content.strip()

# ——— WEBSOCKET ENDPOINT —————————————————————————————————————————————
@app.websocket("/ws/audio")
async def websocket_audio(ws: WebSocket):
    await ws.accept()
    print("🟢  /ws/audio connected")

    buf = np.zeros(0, dtype=np.float32)

    try:
        while True:
            msg = await ws.receive_json()
            pcm = (pcm16le_from_base64(msg["payload"])
                   .astype(np.float32)/32768.0)
            ts  = msg["ts"]

            buf = np.concatenate([buf, pcm])
            if len(buf) < CHUNK_SIZE:
                continue

            chunk = buf[:CHUNK_SIZE]
            buf   = buf[CHUNK_SIZE:]

            # 1) Whisper
            result = await asyncio.to_thread(
                model.transcribe,
                chunk,
                language="ar",
                beam_size=1, best_of=1, temperature=0.0
            )

            now = time.strftime("%H:%M:%S")
            for seg in result["segments"]:
                raw = seg["text"].strip()
                if not raw:
                    continue

                # 2) first GPT cleanup
                cleaned = await first_pass_cleanup(raw)

                # 3) second GPT scam‑aware refine
                refined = await second_pass_scam_refine(cleaned)

                # 4) score ONLY the second pass
                window_txt = text_window.add(refined, ts)
                scam_score = score(window_txt)

                print(f"[{now}] ⟨{refined}⟩   score={scam_score:.3f}")

                await ws.send_json({
                    "type":      "score",
                    "raw_text":  raw,
                    "cleaned":   cleaned,
                    "refined":   refined,
                    "window":    window_txt,
                    "score":     scam_score,
                    "ts":        ts,
                })

                if scam_score >= THRESHOLD:
                    await ws.send_json({
                        "type":  "scam_detected",
                        "score": scam_score,
                    })
                    return

    except WebSocketDisconnect:
        print("Client disconnected")
