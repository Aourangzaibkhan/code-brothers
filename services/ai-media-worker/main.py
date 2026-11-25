"""Code Brothers AI media sidecar (spec Sections 4E, 7F, 11 Step 5).

Isolated FastAPI service for the heavy / ML media work the Node platform
must never do in-process:

  GET  /health        Liveness + capability report (never fails on missing models)
  POST /transcribe    Speech-to-text for an uploaded audio/video file (Faster-Whisper)
                      — also accepts JSON {"mediaUrl": ...} or {"filePath": ...}
                      (paths confined to CB_MEDIA_DIR), so a workflow can call
                      it with an httpRequest node after resolving a media URL.
  POST /ocr           OCR for an uploaded image (PaddleOCR) — payment screenshots etc.
                      — also accepts JSON {"mediaUrl": ...} / {"filePath": ...};
                      the response adds "extracted": {"tid", "amount"} parsed
                      from the recognised text (JazzCash/Easypaisa receipts).
  POST /tts           Text-to-speech to a WAV file (Piper)
  POST /video/clip    Crop/scale a video to 9:16 1080x1920 with optional burned
                      SRT captions, via ffmpeg (Media Factory, spec Section 7F).
                      The response includes "contentBase64" (base64 of the clip,
                      capped at CB_CLIP_BASE64_MAX_MB) so a workflow can upload
                      it straight to YouTube/Instagram.

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

import base64
import importlib
import importlib.util
import os
import re
import shutil
import subprocess
import urllib.request
import uuid
import wave
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
# NOTE: UploadFile must come from starlette.datastructures, NOT fastapi.
# request.form() returns starlette UploadFile instances; FastAPI >= 0.115
# defines its own fastapi.datastructures.UploadFile, a DIFFERENT class —
# isinstance() against the fastapi one is always False, so every multipart
# upload used to fail with 422 "file upload is required".
from starlette.datastructures import UploadFile
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
#: Largest clip (bytes) whose base64 is returned by /video/clip.
CLIP_BASE64_MAX_BYTES = int(os.environ.get("CB_CLIP_BASE64_MAX_MB", "20")) * 1024 * 1024
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


async def _resolve_media_source(request: Request, media_kind: str) -> tuple[Path, str]:
    """Resolve the media for /transcribe or /ocr from any accepted input.

    Accepts, in order:
      * multipart form file upload (the original contract),
      * JSON {"mediaUrl": "..."} — the file is downloaded (size-capped),
      * JSON {"filePath": "..."} — a path inside CB_MEDIA_DIR.
    Returns (path, detected_kind). The caller still verifies magic bytes
    via _save_upload for uploads; downloaded/local files are checked the
    same way by re-reading their header here.
    """
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        upload = form.get("file")
        if not isinstance(upload, UploadFile):
            raise HTTPException(status_code=422, detail="file upload is required")
        return await _save_upload(upload, media_kind)
    if "application/json" in content_type:
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(status_code=422, detail="JSON object expected")
        media_url = body.get("mediaUrl")
        file_path = body.get("filePath")
        if isinstance(media_url, str) and media_url:
            try:
                req = urllib.request.Request(media_url, headers={"User-Agent": "code-brothers-media-worker/1.0"})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    data = resp.read(MAX_UPLOAD_BYTES + 1)
            except Exception as exc:  # noqa: BLE001 — network failure is a 502
                raise HTTPException(status_code=502, detail=f"Could not download mediaUrl: {exc}")
            if len(data) > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="Downloaded media exceeds the size limit")
            header = data[:64]
            kind = (
                detect_audio_kind(header)
                if media_kind == "audio"
                else detect_image_kind(header)
            )
            if kind is None:
                raise HTTPException(status_code=400, detail="Downloaded file is not a supported media format")
            UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
            dest = UPLOAD_DIR / f"{uuid.uuid4().hex}.{kind}"
            dest.write_bytes(data)
            return dest, kind
        if isinstance(file_path, str) and file_path:
            path = _resolve_media_path(file_path)
            if not path.is_file():
                raise HTTPException(status_code=404, detail="Input file not found")
            header = path.read_bytes()[:64]
            kind = (
                detect_audio_kind(header)
                if media_kind == "audio"
                else detect_image_kind(header)
            )
            if kind is None:
                raise HTTPException(status_code=400, detail="File is not a supported media format")
            return path, kind
        raise HTTPException(
            status_code=422,
            detail="Provide a file upload, mediaUrl, or filePath",
        )
    raise HTTPException(
        status_code=415,
        detail="Send multipart/form-data with a file, or application/json with mediaUrl/filePath",
    )


def _extract_payment_fields(text: str) -> dict:
    """Pull a transaction id + amount out of OCR text (JazzCash/Easypaisa).

    Best-effort: returns {"tid": str|None, "amount": float|None}. A workflow
    that needs certainty should confirm the values with the customer.
    """
    tid: Optional[str] = None
    tid_match = re.search(
        r"(?:TID|Transaction\s*ID|Txn\s*ID|Trx\s*ID)\s*[:#-]?\s*([A-Za-z0-9]{6,})",
        text,
        re.IGNORECASE,
    )
    if tid_match:
        tid = tid_match.group(1)
    amount: Optional[float] = None
    amount_match = re.search(
        r"(?:Rs\.?|PKR|Amount)\s*[:#-]?\s*([0-9][0-9,]*\.?[0-9]{0,2})",
        text,
        re.IGNORECASE,
    )
    if amount_match:
        try:
            amount = float(amount_match.group(1).replace(",", ""))
        except ValueError:
            amount = None
    return {"tid": tid, "amount": amount}


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
async def transcribe(request: Request):
    content_type = request.headers.get("content-type", "")
    language: Optional[str] = None
    model: Optional[str] = None
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        language = form.get("language") if isinstance(form.get("language"), str) else None
        model = form.get("model") if isinstance(form.get("model"), str) else None
    elif "application/json" in content_type:
        body = await request.json()
        if isinstance(body, dict):
            language = body.get("language") if isinstance(body.get("language"), str) else None
            model = body.get("model") if isinstance(body.get("model"), str) else None
    path, kind = await _resolve_media_source(request, "audio")
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
async def ocr(request: Request):
    content_type = request.headers.get("content-type", "")
    lang = "en"
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        lang = form.get("lang") if isinstance(form.get("lang"), str) else "en"
    elif "application/json" in content_type:
        body = await request.json()
        if isinstance(body, dict) and isinstance(body.get("lang"), str):
            lang = body["lang"]
    path, kind = await _resolve_media_source(request, "image")
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
    text = "\n".join(l["text"] for l in lines)
    return {
        "lines": lines,
        "text": text,
        "kind": kind,
        "extracted": _extract_payment_fields(text),
    }


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
        # Base64 of the clip so a workflow can upload it straight to
        # YouTube/Instagram; null when the clip is over the cap (the file
        # stays on disk at outputPath for a download step instead).
        "contentBase64": (
            base64.b64encode(output_path.read_bytes()).decode("ascii")
            if output_path.stat().st_size <= CLIP_BASE64_MAX_BYTES
            else None
        ),
        # Public URL for the clip when the deployment serves MEDIA_DIR
        # publicly (CB_PUBLIC_MEDIA_BASE_URL, e.g. https://media.example.com);
        # null otherwise — Instagram Reels needs a public URL, so that step
        # stays unconfigured until one is set.
        "publicUrl": (
            f"{os.environ.get('CB_PUBLIC_MEDIA_BASE_URL', '').rstrip('/')}/clips/{out_name}"
            if os.environ.get("CB_PUBLIC_MEDIA_BASE_URL")
            else None
        ),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("CB_WORKER_HOST", "127.0.0.1"),
        port=int(os.environ.get("CB_WORKER_PORT", "8000")),
    )
