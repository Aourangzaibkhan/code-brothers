# Code Brothers AI media sidecar (Whisper / TTS / OCR / FFmpeg, shell=False only).
# Endpoints land in the AI build phase.
from fastapi import FastAPI

app = FastAPI(title="Code Brothers AI Media Worker")


@app.get("/health")
def health():
    return {"status": "ok"}
