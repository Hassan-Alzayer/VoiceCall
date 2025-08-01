# Scam-Call Guard


**Scam-Call Guard** is a **Real-time Arabic scam-call detection micro-service and client UI**.
This repository contains everything you need to reproduce our latest prototype:

## 📖 Overview

**Scam-Call Guard** is a two-part application for detecting phone scams in real time:

1. **Backend** (FastAPI + Whisper + OpenAI + SVM)

   * Exposes a WebSocket endpoint at `/ws/audio`.
   * Receives base64-encoded 16 kHz PCM audio.
   * Runs a 5-stage pipeline:

     1. Whisper ASR (local)
     2. GPT first-pass typo cleanup
     3. GPT second-pass refine
     4. TF-IDF + Linear SVM scoring
     5. If P(scam) ≥ threshold, emits a `scam_detected` event.

2. **Frontend** (React + TypeScript + Vite + Daily.co)

   * Simple audio-only calling UI.
   * Streams all audio in/out to the backend.
   * Automatically hangs up on scam detection.

## 🚀 Features

* **Live transcription & scoring**: Whisper + GPT + SVM pipeline emits intermediate `score` messages
* **Automatic call termination** on high scam probability
* **Mic & speaker tests** in UI before joining
* **Daily.co integration** for peer-to-peer audio rooms
* **Flexible CORS** setup for easy local development

## 🛠️ Tech Stack

* **Backend**: Python 3.10+, FastAPI, `whisper` (OpenAI or faster-whisper), OpenAI ChatCompletion, scikit-learn, joblib
* **Frontend**: React, TypeScript, Vite, Daily.co JS SDK, lucide-react icons
* **Model training**: pandas, scikit-learn (LogisticRegression), TfidfVectorizer

## 📋 Repository Structure

```
.
├── backend/
│   ├── main.py            # FastAPI WebSocket server
│   ├── utils.py           # RollingWindow helper
│   ├── requirements.txt
│   └── models/
│       ├── tfidf.joblib
│       └── scam_clf.joblib
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   └── scamSocket.ts
│   ├── package.json
│   └── vite.config.ts
├── model.py               # Offline training & CLI entry
└── README.md
```

## ⚙️ Prerequisites

* **Python** 3.10+
* **Node.js** 16+ / npm or yarn
* **Daily.co** account & API key
* **OpenAI** API key

## Configure environment

### Backend

```bash
# Clone & install
git clone <repo-url>
cd backend
pip install -r requirements.txt

# Create .env and set your OpenAI key
echo "OPENAI_API_KEY=your_openai_api_key" > .env

# Run the FastAPI server
python uvicorn main:app --reload
```

### Frontend

```bash
# Install dependencies
cd frontend
npm install

# Create .env and set Daily.co keys
echo "VITE_DAILY_API_KEY=your_daily_api_key" > .env
echo "VITE_DAILY_API_BASE_URL=https://api.daily.co/v1" >> .env

# Run dev server
npm run dev
# Open http://localhost:5173 in your browser
```

---

Feel free to clone, configure, and run both services to test the end‑to‑end scam‑call guard pipeline locally. Let me know if you need anything else!
