"""Optional local face-box sessions; no frames, tokens, or facial data are persisted."""
from __future__ import annotations

import atexit
import base64
import io
import json
import os
import queue
import re
import secrets
import subprocess
import sys
import threading
import time
from pathlib import Path

from fastapi import HTTPException, Request
from starlette.concurrency import run_in_threadpool
from PIL import Image

MAX_BODY = 220_000
MAX_FRAME = 150_000
FRAME_INTERVAL = .32
IDLE_SECONDS = 15
SESSION_SECONDS = 20 * 60
MAX_SESSIONS = 2


def _runtimes() -> list[Path]:
    """Only process-owner configuration can choose a runtime; never HTTP parameters."""
    candidates = [os.environ.get("RELIC_INTERACTION_PYTHON"), os.environ.get("RELIC_AI_PYTHON"),
                  "E:/lora-platform/.venv/Scripts/python.exe"]
    # Non-frozen developer Python is another existing optional runtime, not an installer.
    if not getattr(sys, "frozen", False):
        candidates.append(sys.executable)
    result = []
    for value in candidates:
        if value:
            path = Path(value).expanduser()
            if path.is_absolute() and path.is_file():
                resolved = path.resolve()
                if resolved not in result:
                    result.append(resolved)
    return result


def _runtime() -> Path | None:
    return next(iter(_runtimes()), None)


def _frame_image(value):
    if not isinstance(value, str) or len(value) > 205_000:
        raise HTTPException(413, "本机分析帧过大。请使用低分辨率预览。")
    match = re.fullmatch(r"data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)", value)
    if not match:
        raise HTTPException(422, "请提交有效的本机 JPEG、PNG 或 WebP 帧。")
    try:
        raw = base64.b64decode(match.group(2), validate=True)
        if not 32 <= len(raw) <= MAX_FRAME:
            raise ValueError("size")
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in {"JPEG", "PNG", "WEBP"} or not (64 <= image.width <= 640 and 64 <= image.height <= 480):
                raise ValueError("dimensions")
            image.verify()
    except Exception:
        raise HTTPException(422, "分析帧须为 64–640 × 64–480 像素，且不超过 150 KB。") from None
    return match.group(2)


async def _json(request):
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > MAX_BODY:
            raise HTTPException(413, "本机分析请求过大。")
        raw.extend(chunk)
    try:
        payload = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (ValueError, TypeError, UnicodeDecodeError):
        raise HTTPException(422, "分析请求须为有效 JSON。") from None
    if not isinstance(payload, dict):
        raise HTTPException(422, "分析请求须为 JSON 对象。")
    return payload


class FaceSession:
    def __init__(self, python: Path, worker: Path):
        self.id, self.token = secrets.token_hex(12), secrets.token_urlsafe(32)
        self.created = self.last_seen = time.monotonic()
        self.last_frame = 0.0
        self.sequence = 0
        self.closed = False
        self.lock = threading.Lock()
        self.responses = queue.Queue(maxsize=4)
        self.process = subprocess.Popen([str(python), "-B", "-X", "utf8", "-u", str(worker)], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), close_fds=True)
        self.reader = threading.Thread(target=self._read, daemon=True, name="relic-proximity-boxes")
        self.reader.start()
        try:
            message = self.responses.get(timeout=12)
            if message.get("type") != "ready":
                raise RuntimeError("unavailable")
        except Exception:
            self.stop()
            raise HTTPException(503, "本机人脸框检测未能启动。可继续使用 M 键放大镜。") from None

    def _read(self):
        try:
            while not self.closed:
                line = self.process.stdout.readline(16_384)
                if not line:
                    break
                value = json.loads(line)
                if not isinstance(value, dict):
                    break
                self.responses.put_nowait(value)
        except Exception:
            pass
        finally:
            try:
                self.responses.put_nowait({"type": "closed"})
            except queue.Full:
                pass

    def frame(self, encoded):
        if not self.lock.acquire(blocking=False):
            raise HTTPException(429, "上一帧还在处理，已跳过本帧。")
        try:
            if self.closed or self.process.poll() is not None:
                raise HTTPException(410, "本机检测已经停止，请重新开启。")
            current = time.monotonic()
            if current - self.last_frame < FRAME_INTERVAL:
                raise HTTPException(429, "采样过快，已跳过本帧。")
            self.last_frame = self.last_seen = current
            self.sequence += 1
            self.process.stdin.write(json.dumps({"op": "frame", "id": self.sequence, "image": encoded}) + "\n")
            self.process.stdin.flush()
            result = self.responses.get(timeout=4)
            if result.get("type") != "result" or result.get("id") != self.sequence:
                self.stop()
                raise HTTPException(503, "本机检测返回无效，已停止。可使用 M 键放大镜。")
            # Do not return worker internals, process IDs, paths, tokens, or any frame data.
            return {key: result[key] for key in ("faces", "faceCount", "width", "height", "elapsedMs")}
        except HTTPException:
            raise
        except Exception:
            self.stop()
            raise HTTPException(503, "本机检测响应超时，已停止。可使用 M 键放大镜。") from None
        finally:
            self.lock.release()

    def stop(self):
        if self.closed:
            return
        self.closed = True
        try:
            if self.process.stdin:
                self.process.stdin.close()  # EOF is the worker's normal exit signal.
        except OSError:
            pass
        try:
            self.process.wait(timeout=.5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=1)
        for pipe in (self.process.stdout, self.process.stderr):
            try:
                if pipe:
                    pipe.close()
            except OSError:
                pass


class ProximitySessions:
    def __init__(self, root):
        self.worker = Path(root) / "tools" / "face_proximity_worker.py"
        self.sessions = {}
        self.lock = threading.RLock()
        self.shutdown = threading.Event()
        self.reaper = None

    def capabilities(self):
        return {"available": bool(_runtime() and self.worker.is_file()), "provider": "local_opencv_haar",
            "requiresCameraConsent": True, "storesFrames": False, "cloudRequests": False,
            "reason": "使用现有本机 OpenCV 环境；启用后才验证检测器。" if _runtime() else "未找到可选本机检测环境。可使用 M 键放大镜。",
            "measures": "relative_face_box_size_only", "idleTimeoutSeconds": IDLE_SECONDS}

    def create(self):
        with self.lock:
            self.cleanup()
            if len(self.sessions) >= MAX_SESSIONS:
                raise HTTPException(429, "本机已有靠近感知工作区，请先关闭其他感知开关。")
            runtimes = _runtimes()
            if not runtimes or not self.worker.is_file():
                raise HTTPException(503, "未找到可选本机检测环境。可使用 M 键放大镜。")
            session = None
            for python in runtimes:
                try:
                    session = FaceSession(python, self.worker)
                    break
                except (HTTPException, OSError):
                    continue
            if session is None:
                raise HTTPException(503, "现有本机 Python 环境未提供可用的 OpenCV 检测器。可继续使用 M 键放大镜。")
            self.sessions[session.id] = session
            if self.reaper is None:
                self.reaper = threading.Thread(target=self._reap, daemon=True, name="relic-proximity-cleanup")
                self.reaper.start()
            return {"sessionId": session.id, "token": session.token, "expiresInSeconds": SESSION_SECONDS,
                    "idleTimeoutSeconds": IDLE_SECONDS, "maxFramesPerSecond": 3, "storesFrames": False}

    def get(self, identifier, token):
        with self.lock:
            self.cleanup()
            session = self.sessions.get(identifier)
            if session is None or not isinstance(token, str) or not token.isascii() or len(token) != 43 or not secrets.compare_digest(session.token, token):
                raise HTTPException(401, "感知会话无效或已过期，请重新开启。")
            return session

    def remove(self, identifier, token):
        with self.lock:
            session = self.get(identifier, token)
            self.sessions.pop(identifier, None)
        session.stop()
        return {"stopped": True, "storesFrames": False}

    def cleanup(self):
        current = time.monotonic()
        expired = [key for key, session in self.sessions.items() if session.closed
            or current - session.last_seen > IDLE_SECONDS or current - session.created > SESSION_SECONDS]
        for key in expired:
            self.sessions.pop(key).stop()

    def _reap(self):
        while not self.shutdown.wait(2):
            with self.lock:
                self.cleanup()

    def close(self):
        self.shutdown.set()
        with self.lock:
            sessions = list(self.sessions.values())
            self.sessions.clear()
        for session in sessions:
            session.stop()


def register_proximity_routes(app, core):
    sessions = ProximitySessions(core.ROOT)
    app.state.proximity_sessions = sessions
    atexit.register(sessions.close)
    app.router.add_event_handler("shutdown", sessions.close)

    @app.get("/api/proximity/capabilities")
    def proximity_capabilities(request: Request):
        core.require_local_origin(request, require_json=False)
        return sessions.capabilities()

    @app.post("/api/proximity/sessions")
    async def proximity_start(request: Request):
        core.require_local_origin(request)
        payload = await _json(request)
        if set(payload) != {"confirmed"} or payload["confirmed"] is not True:
            raise HTTPException(422, "请先明确开启靠近感知。")
        return await run_in_threadpool(sessions.create)

    @app.post("/api/proximity/sessions/{session_id}/frames")
    async def proximity_frame(session_id: str, request: Request):
        core.require_local_origin(request)
        session = sessions.get(session_id, request.headers.get("x-proximity-token"))
        payload = await _json(request)
        if set(payload) != {"image"}:
            raise HTTPException(422, "分析请求只能包含当前内存帧。")
        encoded = _frame_image(payload["image"])
        return await run_in_threadpool(session.frame, encoded)

    @app.delete("/api/proximity/sessions/{session_id}")
    def proximity_stop(session_id: str, request: Request):
        core.require_local_origin(request, require_json=False)
        return sessions.remove(session_id, request.headers.get("x-proximity-token"))

    @app.post("/api/proximity/sessions/{session_id}/stop")
    async def proximity_stop_keepalive(session_id: str, request: Request):
        core.require_local_origin(request)
        payload = await _json(request)
        if set(payload) != {"token"}:
            raise HTTPException(422, "停止请求格式不正确。")
        return await run_in_threadpool(sessions.remove, session_id, payload["token"])

    return sessions
