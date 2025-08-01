"""
main.py
========
Real-time Arabic scam-call detection micro-service
--------------------------------------------------

This FastAPI application exposes a single WebSocket endpoint (`/ws/audio`)
that receives **base64-encoded PCM 16-bit mono audio** streamed from the
browser, runs a lightweight end-to-end pipeline, and streams back a live
“scam score”.

Pipeline
~~~~~~~~
1. **Whisper ASR** (local) – transcribes the incoming audio chunk.
2. **GPT first-pass cleanup** – fixes ASR typos.
3. **GPT second-pass refine** – rewrites odd phrases into a canonical form.
4. **TF-IDF + Linear SVM** – classifies the last *N* seconds of text.
5. If *P(scam) ≥ THRESHOLD*, a ``"scam_detected"`` message is emitted.

"""

# ──────────────────────────────────────────────────────────────────────────────
# Standard library
import os
import time
import asyncio
import base64
from dotenv import load_dotenv  # type: ignore – loaded at runtime

# Third-party
import numpy as np
import joblib
import whisper
import openai
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

# Local
from utils import RollingWindow

# ─── CONFIGURATION ────────────────────────────────────────────────────────────
load_dotenv()

TFIDF_PATH   = "models/tfidf.joblib"     # Path to the TF-IDF vectorizer
MODEL_PATH   = "models/scam_clf.joblib"  # Path to the SVM classifier
THRESHOLD    = 0.75                      # Trigger when P(scam) ≥ 0.75

SAMPLE_RATE  = 16_000                    # Expected audio sample-rate (Hz)
CHUNK_SECS   = 10                        # Process every 10 s of audio
WINDOW_SECS  = 20                        # Keep 20 s of text history

CHUNK_SIZE   = SAMPLE_RATE * CHUNK_SECS  # Frames per processing step

# OpenAI model versions (decoupled for A/B testing or fallback)
FIRST_MODEL   = "gpt-4o-mini-2024-07-18"
SECOND_MODEL  = "gpt-4o-2024-08-06"

# ─── OPENAI API KEY ───────────────────────────────────────────────────────────
openai.api_key = os.getenv("OPENAI_API_KEY")
if not openai.api_key:
    raise RuntimeError("Set OPENAI_API_KEY in your environment")

# ─── FASTAPI APP SETUP ────────────────────────────────────────────────────────
app = FastAPI(title="Scam-Call Guard")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # In production, replace with allowed origins
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── LOAD ML ASSETS (Cold-start, once per process) ───────────────────────────
tfidf     = joblib.load(TFIDF_PATH)
clf       = joblib.load(MODEL_PATH)
legit_idx = list(clf.classes_).index("Legit")  # Column index for the “Legit” class

text_window = RollingWindow(max_seconds=WINDOW_SECS)
model       = whisper.load_model("large")      # Use “tiny” for < 500 ms latency

# ──────────────────────────────────────────────────────────────────────────────
# Helper functions
# ──────────────────────────────────────────────────────────────────────────────
def score(text: str) -> float:
    """
    Compute *P(scam)* for a single Arabic sentence.

    Args:
        text: Normalised Arabic text.

    Returns:
        float: Probability that the text belongs to the **Scam** class.
    """
    proba = clf.predict_proba(tfidf.transform([text]))[0]
    return float(1.0 - proba[legit_idx])  # 1 – P(Legit)


def pcm16le_from_base64(b64: str) -> np.ndarray:
    """
    Decode base64-encoded **little-endian 16-bit PCM** audio.

    Args:
        b64: Base64 string of raw PCM bytes.

    Returns:
        np.ndarray: 1-D NumPy array of ``int16`` audio samples.
    """
    raw = base64.b64decode(b64)
    return np.frombuffer(raw, dtype=np.int16)


async def first_pass_cleanup(raw: str) -> str:
    """
    First GPT pass – correct Whisper typos **without altering meaning**.

    Args:
        raw: Raw ASR output (one Arabic sentence).

    Returns:
        str: Cleaned sentence with minimal corrections.
    """
    resp = await asyncio.to_thread(
        openai.ChatCompletion.create,
        model=FIRST_MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are an expert Arabic transcription editor. "
                    "Given one Arabic sentence, correct typos and mis-heard words only; "
                    "return exactly the corrected sentence."
                ),
            },
            {"role": "user", "content": raw},
        ],
        temperature=0.0,
        max_tokens=200,
    )
    return resp.choices[0].message.content.strip()


async def second_pass_scam_refine(cleaned: str) -> str:
    """
    Second GPT pass – *optionally* rewrite phrasing into a clearer form
    (still preserving semantics) to improve downstream classification.

    Args:
        cleaned: Output from :func:`first_pass_cleanup`.

    Returns:
        str: Refined sentence ready for scoring.
    """
    resp = await asyncio.to_thread(
        openai.ChatCompletion.create,
        model=SECOND_MODEL,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are an expert Arabic transcription editor. "
                    "Given one Arabic sentence, correct typos and mis-heard words only; "
                    "return exactly the corrected sentence."
                ),
            },
            {"role": "user", "content": cleaned},
        ],
        temperature=0.0,
        max_tokens=200,
    )
    return resp.choices[0].message.content.strip()

# ──────────────────────────────────────────────────────────────────────────────
# WebSocket endpoint
# ──────────────────────────────────────────────────────────────────────────────
@app.websocket("/ws/audio")
async def websocket_audio(ws: WebSocket):
    """
    Streamed audio handler.

    Workflow
    --------
    1. **Receive** base64-encoded PCM frames from the browser.
    2. **Buffer** until `CHUNK_SIZE` samples are accumulated.
    3. Run **ASR → GPT cleanup ×2 → SVM score**.
    4. Send incremental JSON events back to the client.

    Outgoing event types
    ~~~~~~~~~~~~~~~~~~~~
    * ``"score"`` – intermediary scores for each sentence.
    * ``"scam_detected"`` – final alarm when score ≥ *THRESHOLD*.

    Args:
        ws: FastAPI WebSocket connection.
    """
    await ws.accept()
    print("🟢  /ws/audio connected")

    buf = np.zeros(0, dtype=np.float32)  # Rolling audio buffer

    try:
        while True:
            # ─── 0) Receive audio chunk ────────────────────────────────────────
            msg = await ws.receive_json()
            pcm = pcm16le_from_base64(msg["payload"]).astype(np.float32) / 32768.0
            ts  = msg["ts"]  # Client-side timestamp (ms)

            # ─── 1) Accumulate until CHUNK_SIZE ───────────────────────────────
            buf = np.concatenate([buf, pcm])
            if len(buf) < CHUNK_SIZE:
                continue

            chunk = buf[:CHUNK_SIZE]
            buf   = buf[CHUNK_SIZE:]  # Preserve remainder

            # ─── 2) Whisper ASR ───────────────────────────────────────────────
            result = await asyncio.to_thread(
                model.transcribe,
                chunk,
                language="ar",
                beam_size=1,
                best_of=1,
                temperature=0.0,
            )

            now = time.strftime("%H:%M:%S")

            # ─── 3) Process each ASR segment ─────────────────────────────────
            for seg in result["segments"]:
                raw = seg["text"].strip()
                if not raw:
                    continue

                # 3-a) GPT cleanup pass #1
                cleaned = await first_pass_cleanup(raw)

                # 3-b) GPT cleanup pass #2 (scam-aware)
                refined = await second_pass_scam_refine(cleaned)

                # 3-c) Update rolling window & score
                window_txt = text_window.add(refined, ts)
                scam_score = score(window_txt)

                print(f"[{now}] ⟨{refined}⟩   score={scam_score:.3f}")

                # 3-d) Emit live score
                await ws.send_json(
                    {
                        "type":     "score",
                        "raw_text": raw,
                        "cleaned":  cleaned,
                        "refined":  refined,
                        "window":   window_txt,
                        "score":    scam_score,
                        "ts":       ts,
                    }
                )

                # 3-e) Final alarm
                if scam_score >= THRESHOLD:
                    await ws.send_json(
                        {
                            "type":  "scam_detected",
                            "score": scam_score,
                        }
                    )
                    return

    except WebSocketDisconnect:
        print("Client disconnected")
