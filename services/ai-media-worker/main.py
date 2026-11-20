"""Code Brothers AI media sidecar (spec Sections 4E, 7F, 11 Step 5).

Isolated FastAPI service for the heavy / ML media work the Node platform
must never do in-process:

  GET  /health        Liveness + capability report (never fails on missing models)
  POST /transcribe    Speech-to-text for an uploaded audio/video file (Faster-Whisper)
  POST /ocr           OCR for an uploaded image (PaddleOCR) — payment screenshots etc.
  POST /tts           Text-to-speech to a WAV file (Piper)
  POST /video/clip    Crop/scale a video to 9:16 1080x1920 with optional burned
                      SRT captions, via ffmpeg (Media Factory, spec Section 7F)

Security rules (spec Section 8):
  * ffmpeg is ONLY ever invoked as an argument list with shell=False — no
    user input is ever interpolated into a shell string.
  * /video/clip paths are resolved and must stay inside CB_MEDIA_DIR
    (path-traversal is rejected with 400).
  * Uploads are verified by magic bytes, never by filename or Content-Type,
    and are size-capped (CB_MAX_UPLOAD_MB).
  * Model packages (faster-whisper, paddleocr, piper) are LAZY imports: the
    app starts and every other endpoint works without them; an endpoint
    whose model is missing returns 503 with an install hint.
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import shutil
import subprocess
import uuid
import wave
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

# --------------------------------------------------------------------------
# Configuration (environment)
# --------------------------------------------------------------------------

MEDIA_DIR = Path(os.environ.get("CB_MEDIA_DIR", "./media")).resolve()
UPLOAD_DIR = MEDIA_DIR / "uploads"
CLIP_DIR = MEDIA_DIR / "clips"
TTS_DIR = MEDIA_DIR / "tts"
PIPER_VOICES_DIR = Path(
    os.environ.get("CB_PIPER_VOICES_DIR", str(MEDIA_DIR / "voices"))
).resolve()

MAX_UPLOAD_BYTES = int(os.environ.get("CB_MAX_UPLOAD_MB", "25")) * 1024 * 1024
WHISPER_MODEL = os.environ.get("CB_WHISPER_MODEL", "small")
FFMPEG_BIN = os.environ.get("CB_FFMPEG_BIN", "ffmpeg")
CLIP_TIMEOUT_SECONDS = int(os.environ.get("CB_CLIP_TIMEOUT_SECONDS", "600"))

#: Languages POST /tts accepts (platform locales with Piper voice coverage).
SUPPORTED_TTS_LANGS = [
    "en", "ur", "hi", "ar", "es", "pt", "id", "bn", "tr", "fr", "de",
]

app = FastAPI(title="Code Brothers AI Media Worker", version="1.0.0")


# --------------------------------------------------------------------------
# Lazy model loading
# --------------------------------------------------------------------------

class ModelNotInstalled(RuntimeError):
    """Raised when an optional model package (or voice/model file) is absent."""

    def __init__(self, package: str, hint: str):
        super().__init__(hint)
        self.package = package
        self.hint = hint


def _load_module(module_name: str, package: str, hint: str):
    """Import an optional model package or raise ModelNotInstalled."""
    try:
        return importlib.import_module(module_name)
    except ImportError as exc:
        raise ModelNotInstalled(package, hint) from exc


def _module_available(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except Exception:
        return False


def _not_installed(exc: ModelNotInstalled) -> HTTPException:
    return HTTPException(
        status_code=503,
        detail=f"Model not installed: {exc.package}. {exc.hint}",
    )


# --------------------------------------------------------------------------
# Magic-byte verification (never trust filename / Content-Type)
# --------------------------------------------------------------------------

def detect_audio_kind(header: bytes) -> Optional[str]:
    """Return 'wav' | 'mp3' | 'mp4' | 'ogg' from magic bytes, else None."""
    if len(header) >= 12 and header[0:4] == b"RIFF" and header[8:12] == b"WAVE":
        return "wav"
    if header.startswith(b"OggS"):
        return "ogg"
    if len(header) >= 8 and header[4:8] == b"ftyp":  # mp4 / m4a family
        return "mp4"
    if header.startswith(b"ID3"):
        return "mp3"
    if len(header) >= 2 and header[0] == 0xFF and (header[1] & 0xE0) == 0xE0:
        return "mp3"  # MPEG audio frame sync
    return None


def detect_image_kind(header: bytes) -> Optional[str]:
    """Return 'png' | 'jpg' | 'webp' from magic bytes, else None."""
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if header.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if len(header) >= 12 and header[0:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "webp"
    return None


async def _save_upload(file: UploadFile, media_kind: str) -> tuple[Path, str]:
    """Read an upload (size-capped), verify magic bytes, store under MEDIA_DIR.

    Returns (path, detected_kind). Raises 400 on bad magic bytes, 413 if the
    upload exceeds CB_MAX_UPLOAD_MB.
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Upload exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit",
            )
        chunks.append(chunk)
    data = b"".join(chunks)
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")

    header = data[:64]
    kind = (
        detect_audio_kind(header)
        if media_kind == "audio"
        else detect_image_kind(header)
    )
    if kind is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"File content is not a supported {media_kind} format "
                "(magic-byte check failed)"
            ),
        )
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dest = UPLOAD_DIR / f"{uuid.uuid4().hex}.{kind}"
    dest.write_bytes(data)
    return dest, kind


# --------------------------------------------------------------------------
# Health
# --------------------------------------------------------------------------

@app.get("/health")
def health():
    return {
        "status": "ok",
        "mediaDir": str(MEDIA_DIR),
        "ffmpeg": shutil.which(FFMPEG_BIN) is not None,
        "models": {
            "fasterWhisper": _module_available("faster_whisper"),
            "paddleocr": _module_available("paddleocr"),
            "piper": _module_available("piper"),
        },
    }


# --------------------------------------------------------------------------
# POST /transcribe — Faster-Whisper speech-to-text
# --------------------------------------------------------------------------

@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
    model: Optional[str] = Form(None),
):
    path, kind = await _save_upload(file, "audio")
    try:
        faster_whisper = _load_module(
            "faster_whisper",
            "faster-whisper",
            "Install it with: pip install faster-whisper",
        )
    except ModelNotInstalled as exc:
        raise _not_installed(exc)
    try:
        whisper = faster_whisper.WhisperModel(
            model or WHISPER_MODEL, device="cpu", compute_type="int8"
        )
        segments_iter, info = whisper.transcribe(
            str(path), language=language or None
        )
        segments = [
            {"start": seg.start, "end": seg.end, "text": seg.text.strip()}
            for seg in segments_iter
        ]
    except Exception as exc:  # model download / decode failure
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}")
    return {
        "text": " ".join(seg["text"] for seg in segments).strip(),
        "language": getattr(info, "language", language),
        "duration": getattr(info, "duration", None),
        "segments": segments,
        "kind": kind,
    }


# --------------------------------------------------------------------------
# POST /ocr — PaddleOCR for images / payment screenshots
# --------------------------------------------------------------------------

@app.post("/ocr")
async def ocr(file: UploadFile = File(...), lang: str = Form("en")):
    path, kind = await _save_upload(file, "image")
    try:
        paddleocr = _load_module(
            "paddleocr",
            "paddleocr",
            "Install it with: pip install paddleocr paddlepaddle",
        )
    except ModelNotInstalled as exc:
        raise _not_installed(exc)
    try:
        try:
            engine = paddleocr.PaddleOCR(use_angle_cls=True, lang=lang, show_log=False)
        except TypeError:
            engine = paddleocr.PaddleOCR(lang=lang)
        result = engine.ocr(str(path))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"OCR failed: {exc}")

    lines: list[dict] = []
    # PaddleOCR returns a list of pages; each page is a list of
    # [box, (text, confidence)] entries (newer versions nest differently,
    # so walk defensively).
    def _walk(node):
        if isinstance(node, (list, tuple)):
            if (
                len(node) == 2
                and isinstance(node[1], (list, tuple))
                and len(node[1]) == 2
                and isinstance(node[1][0], str)
            ):
                lines.append({"text": node[1][0], "confidence": float(node[1][1])})
                return
            for child in node:
                _walk(child)

    _walk(result)
    return {"lines": lines, "text": "\n".join(l["text"] for l in lines), "kind": kind}


# --------------------------------------------------------------------------
# POST /tts — Piper text-to-speech
# --------------------------------------------------------------------------

class TtsRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    lang: str = "en"
    voice: Optional[str] = None


def _find_piper_voice(lang: str, voice: Optional[str]) -> Path:
    candidates: list[Path] = []
    if voice:
        candidates.append(PIPER_VOICES_DIR / f"{Path(voice).name}.onnx")
    if PIPER_VOICES_DIR.is_dir():
        candidates.extend(sorted(PIPER_VOICES_DIR.glob(f"*{lang}*.onnx")))
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise ModelNotInstalled(
        "piper voice model",
        f"No Piper voice (.onnx) for language '{lang}' found in "
        f"{PIPER_VOICES_DIR}. Download a free voice from "
        "https://huggingface.co/rhasspy/piper-voices",
    )


@app.post("/tts")
def tts(req: TtsRequest):
    if req.lang not in SUPPORTED_TTS_LANGS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported language '{req.lang}'. "
                f"Supported: {', '.join(SUPPORTED_TTS_LANGS)}"
            ),
        )
    try:
        piper = _load_module(
            "piper", "piper-tts", "Install it with: pip install piper-tts"
        )
        voice_path = _find_piper_voice(req.lang, req.voice)
    except ModelNotInstalled as exc:
        raise _not_installed(exc)
    try:
        voice = piper.PiperVoice.load(str(voice_path))
        TTS_DIR.mkdir(parents=True, exist_ok=True)
        out_path = TTS_DIR / f"{uuid.uuid4().hex}.wav"
        with wave.open(str(out_path), "wb") as wav_file:
            voice.synthesize(req.text, wav_file)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"TTS failed: {exc}")
    return FileResponse(
        str(out_path), media_type="audio/wav", filename=out_path.name
    )


# --------------------------------------------------------------------------
# POST /video/clip — ffmpeg 9:16 Media Factory (shell=False, arg lists only)
# --------------------------------------------------------------------------

class ClipRequest(BaseModel):
    inputPath: str
    start: float = Field(ge=0)
    duration: float = Field(gt=0, le=7200)
    captions: Optional[str] = None
    outputName: Optional[str] = None
    dryRun: bool = False


def _resolve_media_path(raw: str) -> Path:
    """Resolve a user-supplied path and confine it to MEDIA_DIR."""
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = MEDIA_DIR / candidate
    resolved = candidate.resolve()
    if not resolved.is_relative_to(MEDIA_DIR):
        raise HTTPException(
            status_code=400,
            detail="Path is outside the allowed media directory",
        )
    return resolved


def _escape_filter_path(path: Path) -> str:
    """Escape a path for use inside an ffmpeg filter argument value."""
    text = str(path)
    return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def _build_clip_command(req: ClipRequest, input_path: Path, output_path: Path) -> list[str]:
    # Centre-crop to 9:16 whatever the source aspect, then scale to 1080x1920.
    filter_graph = "crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',scale=1080:1920"
    if req.captions:
        captions_path = _resolve_media_path(req.captions)
        filter_graph += f",subtitles='{_escape_filter_path(captions_path)}'"
    return [
        FFMPEG_BIN,
        "-y",
        "-ss", str(req.start),
        "-i", str(input_path),
        "-t", str(req.duration),
        "-vf", filter_graph,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-c:a", "aac",
        "-movflags", "+faststart",
        str(output_path),
    ]


@app.post("/video/clip")
def video_clip(req: ClipRequest):
    input_path = _resolve_media_path(req.inputPath)
    if req.outputName:
        # Basename only — an output name can never escape CLIP_DIR.
        out_name = Path(req.outputName).name
        if not out_name.lower().endswith(".mp4"):
            out_name += ".mp4"
    else:
        out_name = f"{input_path.stem}-clip.mp4"
    output_path = CLIP_DIR / out_name
    command = _build_clip_command(req, input_path, output_path)

    if req.dryRun:
        return {
            "dryRun": True,
            "command": command,
            "outputPath": str(output_path),
        }

    if shutil.which(FFMPEG_BIN) is None:
        raise HTTPException(
            status_code=503,
            detail="ffmpeg is not installed on this worker",
        )
    if not input_path.is_file():
        raise HTTPException(status_code=404, detail="Input file not found")
    CLIP_DIR.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(
            command,
            shell=False,
            capture_output=True,
            text=True,
            timeout=CLIP_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="ffmpeg timed out")
    if proc.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"ffmpeg failed: {proc.stderr[-1000:]}",
        )
    return {
        "dryRun": False,
        "command": command,
        "outputPath": str(output_path),
        "sizeBytes": output_path.stat().st_size,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("CB_WORKER_HOST", "127.0.0.1"),
        port=int(os.environ.get("CB_WORKER_PORT", "8000")),
    )
