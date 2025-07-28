import io, time, asyncio, wave, base64
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

import numpy as np
import joblib
from utils import RollingWindow
from faster_whisper import WhisperModel

TFIDF_PATH   = "models/tfidf.joblib"
MODEL_PATH   = "models/scam_clf.joblib"
THRESH       = 0.60          # 1 – P(Legit)

app = FastAPI(title="Scam‑Call Guard")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],     # dev only – tighten in prod
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---- load ML assets once ----
tfidf = joblib.load(TFIDF_PATH)
clf   = joblib.load(MODEL_PATH)
legit_idx = list(clf.classes_).index("Legit")

whisper = WhisperModel("small", device="cpu", compute_type="int8")

# ---- helpers --------------------------------------------------
win = RollingWindow(max_seconds=6.0)

def score(text: str) -> float:
    proba = clf.predict_proba(tfidf.transform([text]))[0]
    scam_score = 1.0 - proba[legit_idx]
    return float(scam_score)

def pcm16le_from_base64(b64: str) -> np.ndarray:
    raw = base64.b64decode(b64)
    return np.frombuffer(raw, dtype=np.int16)

# ---- WebSocket endpoint --------------------------------------
@app.websocket("/ws/audio")
async def websocket_audio(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            #  client sends JSON: {"payload": "<base64‑pcm16le>", "ts": 1712345678.9}
            msg = await ws.receive_json()
            pcm  = pcm16le_from_base64(msg["payload"]).astype(np.float32) / 32768.0
            ts   = msg["ts"]

            segments, _ = whisper.transcribe(pcm, language="ar", vad_filter=True)
            for seg in segments:
                if seg.text.strip():
                    window_txt = win.add(seg.text.strip(), ts)
                    scam_score = score(window_txt)
                     # --- DEBUG LOGGING ---
                    print(f"[{time.strftime('%H:%M:%S')}] "
                        f"⟨{seg.text.strip()}⟩   score={scam_score:.3f}")
                    # ----------------------
                    scam_score = score(window_txt)
                    await ws.send_json({
                        "type": "score",
                        "text": seg.text.strip(),
                        "window": window_txt,
                        "score": scam_score,
                        "ts": ts
                    })
                    if scam_score >= THRESH:
                        await ws.send_json({"type": "scam_detected", "score": scam_score})
                        return
    except WebSocketDisconnect:
        print("Client disconnected")
