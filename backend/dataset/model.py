# ──────────────────────────────────────────────────────────────
#  waai_call_scam_detector.py
#  End-to-end training + real-time inference pipeline
#  (Python 3.10, pip install pandas scikit-learn joblib fastapi uvicorn
#   faster-whisper == 0.10.0 or openai-whisper, pydub, sounddevice)
# ──────────────────────────────────────────────────────────────
import os, time, queue, threading, joblib, argparse, warnings
import numpy as np, pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model       import LogisticRegression
from sklearn.metrics            import classification_report
from faster_whisper             import WhisperModel          # fallback: use openai_whisper
# ──────────────────────────────────────────────────────────────
#  1) TRAINING SECTION  – run once offline
# ──────────────────────────────────────────────────────────────
def train_and_save(
        data_path        : str = "output.xlsx",
        model_out        : str = "scam_clf.joblib",
        vectorizer_out   : str = "tfidf.joblib",
        test_size        : float = 0.15,
        random_state     : int = 42,
        ngram_range      : tuple = (3,6),        # char-level n-grams handle Arabic well
        max_features     : int = 120000,
        C                : float = 4.0
):
    """Train a multi-class scam-category classifier and persist artefacts."""
    df = pd.read_excel(data_path)[["Data","Label"]].rename(
        columns={"Data":"text","Label":"label"})
    X_train, X_test, y_train, y_test = train_test_split(
        df.text, df.label, test_size=test_size, stratify=df.label,
        random_state=random_state)

    tfidf = TfidfVectorizer(analyzer="char",
                            ngram_range=ngram_range,
                            max_features=max_features,
                            lowercase=False)
    Xtr = tfidf.fit_transform(X_train)
    clf  = LogisticRegression(max_iter=4000, C=C, n_jobs=-1,
                              multi_class="ovr", solver="liblinear")
    clf.fit(Xtr, y_train)

    # quick sanity check
    y_pred = clf.predict(tfidf.transform(X_test))
    print(classification_report(y_test, y_pred, digits=3))

    joblib.dump(clf,        model_out)
    joblib.dump(tfidf,      vectorizer_out)
    print(f"[✓] Saved model to {model_out} and vectorizer to {vectorizer_out}")

# ──────────────────────────────────────────────────────────────
#  2) REAL-TIME INFERENCE SECTION  – used inside the call app
# ──────────────────────────────────────────────────────────────
class CallScamMonitor:
    """
    • listens to incoming audio frames
    • streams them through Whisper for ASR
    • feeds rolling transcript windows into the scam classifier
    • raises alert (call_terminate_callback) once score ≥ THRESH
    """
    THRESH         = 0.60          # configurable risk threshold
    WINDOW_SECONDS = 6             # text window fed to classifier
    LANG           = "ar"          # pass "auto" if multilingual

    def __init__(self,
                 model_path="scam_clf.joblib",
                 vec_path  ="tfidf.joblib",
                 whisper_size="small",
                 compute_type="int8",
                 device="cpu",
                 call_terminate_callback=lambda:print("[!] Scam detected – terminate!")):

        self.clf   = joblib.load(model_path)
        self.vec   = joblib.load(vec_path)
        self.asr   = WhisperModel(whisper_size,
                                  device=device,
                                  compute_type=compute_type)
        self.seg_q = queue.Queue()     # holds (text, ts) tuples
        self._stop = False
        self.on_scam = call_terminate_callback

    # ---------- audio ingest ----------
    def _pcm_stream(self, samplerate=16000, blocksize=32000):
        import sounddevice as sd
        for raw in sd.InputStream(samplerate=samplerate,
                                  channels=1,
                                  blocksize=blocksize, dtype='int16'):
            if self._stop: break
            yield np.frombuffer(raw, np.int16).flatten()

    # ---------- ASR thread ----------
    def _asr_loop(self):
        # continuous buffer processed in 2-second chunks
        buffer = b''
        for pcm in self._pcm_stream():
            buffer += pcm.tobytes()
            if len(buffer) / 32000 >= 2:                       # 2 sec
                segments, _ = self.asr.transcribe(
                    buffer,
                    language=self.LANG,
                    vad_filter=True,
                    vad_parameters={"threshold":0.5})
                tstamp = time.time()
                for seg in segments:
                    if seg.text.strip():
                        self.seg_q.put((seg.text.strip(), tstamp))
                buffer = b''

    # ---------- classification loop ----------
    def _clf_loop(self):
        history = []
        while not self._stop:
            try:
                txt, ts = self.seg_q.get(timeout=0.5)
                history.append((txt, ts))
                # drop old segments
                history = [(t, s) for t,s in history
                           if ts - s <= self.WINDOW_SECONDS]
                window_txt = " ".join([h[0] for h in history])
                vect = self.vec.transform([window_txt])
                probs = self.clf.predict_proba(vect)[0]
                scam_prob = probs.max()            # highest category probability
                if scam_prob >= self.THRESH:
                    self.on_scam()
                    self._stop = True
            except queue.Empty:
                continue

    def run(self):
        thr_asr = threading.Thread(target=self._asr_loop, daemon=True)
        thr_clf = threading.Thread(target=self._clf_loop, daemon=True)
        thr_asr.start(); thr_clf.start()
        thr_asr.join();  thr_clf.join()

# ──────────────────────────────────────────────────────────────
#  3) CLI entry
# ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", action="store_true",
                        help="run training then exit")
    args = parser.parse_args()

    if args.train:
        train_and_save()                                # adjust hyper-params inside if needed
    else:
        def kill_call():
            print("\n[⚠] احتمالية احتيال مرتفعة – سيتم إنهاء الاتصال الآن.")
            # << place here logic to hang up SIP / Twilio / VoIP session >>

        monitor = CallScamMonitor(call_terminate_callback=kill_call)
        monitor.run()
