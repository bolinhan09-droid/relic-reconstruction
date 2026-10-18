"""Ephemeral stdin/stdout face-box detector. Never opens a camera or writes frames."""
from __future__ import annotations

import base64
import io
import json
import sys
import time
from pathlib import Path

MAX_FRAME_BYTES = 150_000
MAX_LINE_BYTES = 220_000
MAX_WIDTH, MAX_HEIGHT = 640, 480


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
    sys.stdout.flush()


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    try:
        import cv2
        import numpy as np
        from PIL import Image

        cv2.setNumThreads(1)
        # The classifier belongs to the installed cv2 package; requests cannot supply paths.
        # Read the fixed installed XML in memory: OpenCV's file API may reject Unicode paths.
        xml = (Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml").read_text(encoding="utf-8")
        storage = cv2.FileStorage(xml, cv2.FILE_STORAGE_READ | cv2.FILE_STORAGE_MEMORY)
        classifier = cv2.CascadeClassifier()
        classifier.read(storage.getFirstTopLevelNode())
        storage.release()
        if classifier.empty():
            raise RuntimeError("classifier unavailable")
    except Exception:
        emit({"type": "unavailable", "message": "本机未找到可用的 OpenCV 人脸框检测环境。可继续使用 M 键放大镜。"})
        return 2
    emit({"type": "ready", "provider": "opencv_haar_frontalface", "storesFrames": False, "opensCamera": False})
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
        if not line:
            break  # Parent closes stdin or exits: release all memory and terminate.
        if len(line) > MAX_LINE_BYTES:
            emit({"type": "error", "code": "frame_too_large"})
            break
        identifier = None
        try:
            payload = json.loads(line)
            if not isinstance(payload, dict) or set(payload) - {"op", "id", "image"}:
                raise ValueError("invalid message")
            if payload.get("op") == "stop":
                break
            identifier = payload.get("id")
            if payload.get("op") != "frame" or type(identifier) is not int or not 0 <= identifier <= 2**31:
                raise ValueError("invalid operation")
            encoded = payload.get("image")
            if not isinstance(encoded, str) or len(encoded) > 205_000:
                raise ValueError("invalid frame")
            raw = base64.b64decode(encoded, validate=True)
            if not 32 <= len(raw) <= MAX_FRAME_BYTES:
                raise ValueError("invalid frame bytes")
            with Image.open(io.BytesIO(raw)) as header:
                if header.format not in {"JPEG", "PNG", "WEBP"}:
                    raise ValueError("unsupported image")
                width, height = header.size
                if not 64 <= width <= MAX_WIDTH or not 64 <= height <= MAX_HEIGHT:
                    raise ValueError("invalid dimensions")
                header.verify()
            start = time.monotonic()
            gray = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
            if gray is None or gray.shape != (height, width):
                raise ValueError("invalid decoded image")
            gray = cv2.equalizeHist(gray)
            boxes = classifier.detectMultiScale(gray, scaleFactor=1.12, minNeighbors=5, minSize=(32, 32))
            faces = [{"x": round(int(x) / width, 6), "y": round(int(y) / height, 6),
                      "w": round(int(w) / width, 6), "h": round(int(h) / height, 6)} for x, y, w, h in boxes]
            faces.sort(key=lambda face: face["w"] * face["h"], reverse=True)
            emit({"type": "result", "id": identifier, "faces": faces[:5], "faceCount": len(faces),
                  "width": width, "height": height, "elapsedMs": round((time.monotonic() - start) * 1000, 2)})
            # No image bytes, pixels, identity, or gaze leave this worker.
            del raw, gray, faces, encoded, payload, line
        except Exception:
            emit({"type": "error", "id": identifier, "code": "invalid_frame", "message": "帧格式或尺寸无效。"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
