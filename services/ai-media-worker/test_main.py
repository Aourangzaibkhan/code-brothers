"""Tests for the Code Brothers AI media worker.

The optional model packages (faster-whisper, paddleocr, piper) are NOT
installed in the test venv; absence is additionally simulated by putting
``None`` in ``sys.modules`` so the 503 behaviour is deterministic even on a
machine where a model happens to be installed.
"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

MEDIA_DIR = Path(tempfile.mkdtemp(prefix="cb-media-test-"))
os.environ["CB_MEDIA_DIR"] = str(MEDIA_DIR)

sys.path.insert(0, str(Path(__file__).parent))

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(main.app)

WAV_BYTES = (
    b"RIFF" + (36).to_bytes(4, "little") + b"WAVE"
    b"fmt " + (16).to_bytes(4, "little")
    + (1).to_bytes(2, "little") + (1).to_bytes(2, "little")
    + (8000).to_bytes(4, "little") + (8000).to_bytes(4, "little")
    + (1).to_bytes(2, "little") + (8).to_bytes(2, "little")
    + b"data" + (0).to_bytes(4, "little")
)
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
TEXT_BYTES = b"This is plain text pretending to be media. Definitely not audio."


# ---------------------------------------------------------------- health

def test_health():
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["mediaDir"] == str(MEDIA_DIR)
    assert "models" in body


# ------------------------------------------------------- magic-byte checks

def test_transcribe_rejects_text_file_named_mp3():
    resp = client.post(
        "/transcribe",
        files={"file": ("receipt.mp3", TEXT_BYTES, "audio/mpeg")},
    )
    assert resp.status_code == 400
    assert "magic" in resp.json()["detail"].lower()


def test_ocr_rejects_text_file_named_png():
    resp = client.post(
        "/ocr",
        files={"file": ("receipt.png", TEXT_BYTES, "image/png")},
    )
    assert resp.status_code == 400


def test_upload_size_limit(monkeypatch):
    monkeypatch.setattr(main, "MAX_UPLOAD_BYTES", 16)
    resp = client.post(
        "/transcribe",
        files={"file": ("voice.wav", WAV_BYTES, "audio/wav")},
    )
    assert resp.status_code == 413


# ------------------------------------------- 503 when model is not installed

def test_transcribe_503_without_whisper(monkeypatch):
    monkeypatch.setitem(sys.modules, "faster_whisper", None)
    resp = client.post(
        "/transcribe",
        files={"file": ("voice.wav", WAV_BYTES, "audio/wav")},
    )
    assert resp.status_code == 503
    assert "faster-whisper" in resp.json()["detail"]


def test_ocr_503_without_paddleocr(monkeypatch):
    monkeypatch.setitem(sys.modules, "paddleocr", None)
    resp = client.post(
        "/ocr",
        files={"file": ("receipt.png", PNG_BYTES, "image/png")},
    )
    assert resp.status_code == 503
    assert "paddleocr" in resp.json()["detail"]


def test_tts_503_without_piper(monkeypatch):
    monkeypatch.setitem(sys.modules, "piper", None)
    resp = client.post("/tts", json={"text": "Assalam o alaikum", "lang": "ur"})
    assert resp.status_code == 503
    assert "piper" in resp.json()["detail"]


def test_tts_rejects_unsupported_language():
    resp = client.post("/tts", json={"text": "hello", "lang": "xx"})
    assert resp.status_code == 400
    assert "Unsupported language" in resp.json()["detail"]


# ---------------------------------------------------------------- video clip

def _touch_input(name="input.mp4"):
    path = MEDIA_DIR / name
    path.write_bytes(b"\x00" * 128)
    return path


def test_clip_dry_run_command():
    _touch_input()
    resp = client.post(
        "/video/clip",
        json={"inputPath": "input.mp4", "start": 5, "duration": 30, "dryRun": True},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["dryRun"] is True
    cmd = body["command"]
    # Command is an argument LIST (shell=False construction), never a string.
    assert isinstance(cmd, list)
    assert all(isinstance(part, str) for part in cmd)
    assert cmd[0].endswith("ffmpeg")
    assert "-i" in cmd and str(MEDIA_DIR / "input.mp4") in cmd
    vf_index = cmd.index("-vf")
    vf = cmd[vf_index + 1]
    assert "crop=" in vf
    assert "scale=1080:1920" in vf
    # No shell metacharacter smuggling: separators never appear as own args.
    assert ";" not in cmd and "&&" not in cmd and "|" not in cmd


def test_clip_dry_run_with_captions_burns_subtitles():
    _touch_input()
    (MEDIA_DIR / "caps.srt").write_text(
        "1\n00:00:00,000 --> 00:00:02,000\nHello\n", encoding="utf-8"
    )
    resp = client.post(
        "/video/clip",
        json={
            "inputPath": "input.mp4",
            "start": 0,
            "duration": 10,
            "captions": "caps.srt",
            "dryRun": True,
        },
    )
    assert resp.status_code == 200
    vf = resp.json()["command"]
    vf = vf[vf.index("-vf") + 1]
    assert "subtitles=" in vf


def test_clip_rejects_path_traversal():
    resp = client.post(
        "/video/clip",
        json={"inputPath": "../secret.mp4", "start": 0, "duration": 5, "dryRun": True},
    )
    assert resp.status_code == 400


def test_clip_rejects_absolute_path_outside_media_dir():
    resp = client.post(
        "/video/clip",
        json={"inputPath": "/etc/passwd", "start": 0, "duration": 5, "dryRun": True},
    )
    assert resp.status_code == 400


def test_clip_rejects_traversal_in_captions():
    _touch_input()
    resp = client.post(
        "/video/clip",
        json={
            "inputPath": "input.mp4",
            "start": 0,
            "duration": 5,
            "captions": "../../etc/evil.srt",
            "dryRun": True,
        },
    )
    assert resp.status_code == 400


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_clip_real_run_produces_1080x1920():
    src = MEDIA_DIR / "real-input.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
            "-shortest", "-c:v", "libx264", "-c:a", "aac", str(src),
        ],
        check=True, capture_output=True, timeout=120,
    )
    resp = client.post(
        "/video/clip",
        json={"inputPath": "real-input.mp4", "start": 0, "duration": 1},
    )
    assert resp.status_code == 200
    body = resp.json()
    out = Path(body["outputPath"])
    assert out.is_file() and body["sizeBytes"] > 0
    if shutil.which("ffprobe"):
        probe = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
                "-of", "csv=p=0", str(out),
            ],
            capture_output=True, text=True, timeout=60,
        )
        assert probe.stdout.strip() == "1080,1920"
