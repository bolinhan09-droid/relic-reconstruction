"""Project-owned Qwen service: fixed binary, fixed loopback API, no shell commands.

For a packaged app, explicitly set RELIC_LOCAL_AI_HOME to the model package
root, or put {"modelHome": "E:/.../model-package"} in the app data directory's
runtime/local-ai.json. This setting contains no credential or command.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import threading

import httpx
from fastapi import HTTPException, Request

BASE_URL = "http://127.0.0.1:8188/v1"
MODEL_NAME = "qwen3.5-4b-local"
RUNTIME_RELATIVE = Path("tools/runtime/llama-b11669-cuda12")
MODEL_RELATIVE = Path("models/qwen3.5-4b")
FILES = {"qwen3.5-4b-q4_k_m.gguf": 2648593216, "mmproj-qwen3.5-4b-bf16.gguf": 675569120}
_LOCK = threading.RLock()
_process: subprocess.Popen | None = None


def model_home(data: Path | None = None) -> Path:
    explicit = os.environ.get("RELIC_LOCAL_AI_HOME", "").strip()
    if not explicit and data is not None:
        path = Path(data) / "runtime/local-ai.json"
        try:
            if path.is_file() and path.stat().st_size < 16384:
                settings = json.loads(path.read_text(encoding="utf-8-sig"))
                if isinstance(settings, dict) and set(settings) <= {"modelHome"}:
                    explicit = settings.get("modelHome", "")
        except (ValueError, OSError):
            pass
    if explicit:
        if not isinstance(explicit, str) or len(explicit) > 2000 or any(ord(char) < 32 for char in explicit):
            raise ValueError("本机模型包目录格式不正确")
        chosen = Path(explicit)
        if not chosen.is_absolute():
            raise ValueError("本机模型包目录必须是绝对路径")
        return chosen.resolve()
    return Path(__file__).resolve().parent


def _inside(home: Path, relative: Path) -> Path:
    resolved = (home / relative).resolve()
    if not resolved.is_relative_to(home):
        raise ValueError("本机模型文件不能通过链接指向模型包目录外")
    return resolved


def _inventory(home: Path) -> tuple[bool, list[str], int]:
    missing, downloaded = [], 0
    for name, size in FILES.items():
        path = _inside(home, MODEL_RELATIVE / name)
        if path.is_file() and path.stat().st_size == size:
            downloaded += size
        else:
            missing.append(str(MODEL_RELATIVE / name))
            part = path.with_name(path.name + ".part")
            parts = path.parent / (path.name + ".parts")
            partial_bytes = sum(p.stat().st_size for p in parts.glob("*.part") if p.is_file()) if parts.is_dir() else 0
            downloaded += min(size, max(partial_bytes, part.stat().st_size if part.is_file() else 0))
    for name in ("llama-server.exe", "llama-server-impl.dll", "ggml-cuda.dll", "cublas64_12.dll", "cublasLt64_12.dll", "cudart64_12.dll"):
        if not _inside(home, RUNTIME_RELATIVE / name).is_file():
            missing.append(str(RUNTIME_RELATIVE / name))
    manifest = _inside(home, MODEL_RELATIVE / "download-manifest.json")
    try:
        record = json.loads(manifest.read_text(encoding="utf-8"))
        if record.get("model") != "Qwen/Qwen3.5-4B" or record.get("quantization") != "Q4_K_M":
            missing.append("verified download manifest")
    except (ValueError, OSError):
        missing.append("verified download manifest")
    return not missing, missing, downloaded


def _probe() -> tuple[str, bool]:
    try:
        with httpx.Client(timeout=1.2, trust_env=False, follow_redirects=False) as client:
            response = client.get("http://127.0.0.1:8188/health")
            if response.status_code == 503:
                return "starting", False
            if response.status_code != 200 or len(response.content) > 65536 or response.json().get("status") != "ok":
                return "port_conflict", False
            models = client.get(BASE_URL + "/models")
            if models.status_code == 200 and len(models.content) <= 65536:
                value = models.json()
                if isinstance(value, dict) and any(isinstance(row, dict) and row.get("id") == MODEL_NAME for row in value.get("data", [])):
                    return "ready", True
            return "port_conflict", False
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        return "stopped", False


def status(data: Path | None = None) -> dict:
    result = {"baseUrl": BASE_URL, "model": MODEL_NAME, "vision": True, "available": False, "ready": False, "installed": False, "status": "not_installed", "downloadTotalBytes": sum(FILES.values()), "externalNetworkRequired": False, "automaticStartup": False, "canStop": _process is not None and _process.poll() is None}
    try:
        home = model_home(data)
        installed, missing, downloaded = _inventory(home)
        result.update(modelHome=str(home), installed=installed, missingFiles=missing, downloadedBytes=downloaded)
    except (ValueError, OSError) as exc:
        return {**result, "status": "error", "reason": str(exc)}
    state, ready = _probe()
    if ready:
        return {**result, "status": "ready", "ready": True, "available": True, "reason": "本机千问已加载，健康检查与模型名匹配"}
    if state in {"starting", "port_conflict"}:
        return {**result, "status": state, "reason": "本机模型正在加载" if state == "starting" else "8188 端口被其他服务占用，未启动或停止任何进程"}
    with _LOCK:
        if _process is not None and _process.poll() is None:
            return {**result, "status": "starting", "reason": "本机模型进程已启动，正在等待模型加载"}
        if _process is not None and _process.returncode is not None:
            return {**result, "status": "error", "reason": "本机模型进程已退出，请检查模型包 work/local-qwen/server.stderr.log", "exitCode": _process.returncode}
    return {**result, "status": "stopped" if installed else "not_installed", "reason": "模型已安装，点击启动即可加载" if installed else "本机模型包尚未完整安装，下载和校验完成后可启动"}


def start(data: Path | None = None) -> dict:
    """Start only the bundled, allowlisted llama-server; never wait for inference."""
    global _process
    with _LOCK:
        current = status(data)
        if current["status"] in {"ready", "starting", "port_conflict"} or not current["installed"]:
            return current
        try:
            from local_image_runtime import status as image_status
            if image_status(data)["status"] in {"ready", "starting"}:
                return {**current, "status": "gpu_in_use", "reason": "请先停止本机生图，释放显存后启动千问视觉助手"}
        except ImportError:
            pass
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as check:
            check.settimeout(0.2)
            if check.connect_ex(("127.0.0.1", 8188)) == 0:
                return {**current, "status": "port_conflict", "reason": "8188 端口已被占用；没有启动或停止其他服务"}
        home = model_home(data)
        runtime = _inside(home, RUNTIME_RELATIVE)
        executable = _inside(home, RUNTIME_RELATIVE / "llama-server.exe")
        logs = _inside(home, Path("work/local-qwen"))
        logs.mkdir(parents=True, exist_ok=True)
        arguments = [str(executable), "-m", str(_inside(home, MODEL_RELATIVE / "qwen3.5-4b-q4_k_m.gguf")), "--mmproj", str(_inside(home, MODEL_RELATIVE / "mmproj-qwen3.5-4b-bf16.gguf")), "--host", "127.0.0.1", "--port", "8188", "--alias", MODEL_NAME, "--ctx-size", "4096", "--parallel", "1", "--n-gpu-layers", "99", "--flash-attn", "on", "--batch-size", "512", "--ubatch-size", "128", "--image-min-tokens", "256", "--image-max-tokens", "1024", "--jinja", "--reasoning", "off", "--no-webui", "--no-agent", "--no-ui-mcp-proxy", "--timeout", "180"]
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        environment = {key: value for key, value in os.environ.items() if not key.startswith("LLAMA_ARG_")}
        with (logs / "server.stdout.log").open("ab") as stdout, (logs / "server.stderr.log").open("ab") as stderr:
            _process = subprocess.Popen(arguments, cwd=runtime, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, creationflags=flags, shell=False, env=environment)
        (logs / "api-runtime.json").write_text(json.dumps({"pid": _process.pid, "executable": str(executable), "baseUrl": BASE_URL, "model": MODEL_NAME, "launchedBy": "local_ai_runtime"}, ensure_ascii=False, indent=2), encoding="utf-8")
        return {**current, "status": "starting", "ready": False, "available": False, "canStop": True, "reason": "本机千问正在加载，稍后自动检查就绪状态"}


def stop(data: Path | None = None) -> dict:
    """Only terminate the child this application instance actually created."""
    global _process
    with _LOCK:
        child = _process
        if child is None or child.poll() is not None:
            return {**status(data), "reason": "本窗口没有可停止的千问进程；未触碰其他服务"}
        child.terminate()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            return {**status(data), "status": "stopping", "ready": False, "available": False, "reason": "正在等待本窗口启动的千问进程退出"}
        _process = None
        return {**status(data), "reason": "本窗口启动的千问已停止，显存已释放，模型文件保留"}


def register_local_ai_routes(app, core):
    @app.get("/api/local-ai/status")
    def runtime_status():
        return status(core.DATA)

    @app.post("/api/local-ai/start")
    def runtime_start(request: Request, payload: dict | None = None):
        core.require_local_origin(request)
        if payload:
            raise HTTPException(422, "启动接口不接受命令、地址或任意可执行路径")
        try:
            return start(core.DATA)
        except (OSError, ValueError) as exc:
            raise HTTPException(503, "无法启动本机千问：" + str(exc)) from None

    @app.post("/api/local-ai/stop")
    def runtime_stop(request: Request, payload: dict | None = None):
        core.require_local_origin(request)
        if payload:
            raise HTTPException(422, "停止接口不接受进程号、端口或命令")
        try:
            return stop(core.DATA)
        except (OSError, ValueError) as exc:
            raise HTTPException(503, "无法停止本窗口启动的千问：" + str(exc)) from None
