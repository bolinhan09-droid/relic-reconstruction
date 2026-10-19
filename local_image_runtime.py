"""Optional project-owned Qwen Image research runtime on loopback 8190.

This controls a pinned sd-server binary; image requests use its real OpenAI
compatible /v1/images/edits route through the existing image service client.
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
from local_ai_runtime import model_home, _inside

BASE_URL = "http://127.0.0.1:8190/v1"
MODEL_NAME = "sd-cpp-local"  # Upstream API identifier; capabilities identifies actual weights.
MODEL_RELATIVE = Path("models/qwen-image-2.1-research")
RUNTIME_RELATIVE = Path("tools/runtime/sd-95b3090-cuda12")
FILES = {
    "qwen_image_2.1-Q4_K.gguf": 4197494816,
    "Qwen3VL-8B-Instruct-Q4_K_M.gguf": 5027784800,
    "mmproj-Qwen3VL-8B-Instruct-F16.gguf": 1159029824,
    "qwen_image_2.1_vae_bf16.safetensors": 675509688,
}
_LOCK = threading.RLock()
_process: subprocess.Popen | None = None


def arguments(home: Path, *, server: bool = True) -> list[str]:
    model = _inside(home, MODEL_RELATIVE)
    executable = _inside(home, RUNTIME_RELATIVE / ("sd-server.exe" if server else "sd-cli.exe"))
    result = [str(executable), "--diffusion-model", str(model / "qwen_image_2.1-Q4_K.gguf"),
              "--llm", str(model / "Qwen3VL-8B-Instruct-Q4_K_M.gguf"),
              "--llm_vision", str(model / "mmproj-Qwen3VL-8B-Instruct-F16.gguf"),
              "--vae", str(model / "qwen_image_2.1_vae_bf16.safetensors"),
              "--backend", "cuda0", "--max-vram", "5.5", "--flash-attn", "on",
              "--model-args", "qwen_image_2_1_prefix_cache=false", "--vae-tiling",
              "--steps", "20", "--cfg-scale", "6.0", "--sampling-method", "euler",
              "--width", "512", "--height", "512"]
    if server:
        result += ["--listen-ip", "127.0.0.1", "--listen-port", "8190"]
    return result


def _probe() -> tuple[str, bool]:
    try:
        with httpx.Client(timeout=1.5, trust_env=False, follow_redirects=False) as client:
            response = client.get(BASE_URL + "/models")
            if response.status_code != 200 or len(response.content) > 65536:
                return "port_conflict", False
            models = response.json().get("data", [])
            if not any(isinstance(row, dict) and row.get("id") == MODEL_NAME for row in models):
                return "port_conflict", False
            response = client.get("http://127.0.0.1:8190/sdcpp/v1/capabilities")
            if response.status_code != 200 or len(response.content) > 262144:
                return "port_conflict", False
            capabilities = response.json()
            identity = capabilities.get("model", {})
            actual = identity.get("name", "") or identity.get("stem", "")
            if "qwen_image_2.1-Q4_K" not in actual or "img_gen" not in capabilities.get("supported_modes", []):
                return "port_conflict", False
            return "ready", True
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        return "stopped", False


def status(data: Path | None = None) -> dict:
    result = {"baseUrl": BASE_URL, "model": MODEL_NAME, "displayName": "Qwen-Image-2.1 Q4 · 本机研究版",
              "license": "Qwen RESEARCH LICENSE AGREEMENT", "researchOnly": True,
              "ready": False, "available": False, "installed": False, "imageEditingVerified": False,
              "downloadTotalBytes": sum(FILES.values()), "canStop": _process is not None and _process.poll() is None}
    try:
        home = model_home(data)
        missing, downloaded = [], 0
        for name, size in FILES.items():
            path = _inside(home, MODEL_RELATIVE / name)
            if path.is_file() and path.stat().st_size == size:
                downloaded += size
            else:
                missing.append(str(MODEL_RELATIVE / name))
                parts = path.parent / (name + ".parts")
                partial = sum(p.stat().st_size for p in parts.glob("*.part")) if parts.is_dir() else 0
                one_part = path.with_name(path.name + ".part")
                downloaded += min(size, max(partial, one_part.stat().st_size if one_part.is_file() else 0))
        for name in ("sd-server.exe", "stable-diffusion.dll", "ggml-cuda.dll", "ggml-base.dll", "cublas64_12.dll", "cublasLt64_12.dll", "cudart64_12.dll"):
            if not _inside(home, RUNTIME_RELATIVE / name).is_file():
                missing.append(str(RUNTIME_RELATIVE / name))
        manifest = _inside(home, MODEL_RELATIVE / "download-manifest.json")
        if manifest.is_file():
            record = json.loads(manifest.read_text(encoding="utf-8"))
            if record.get("model") != "Qwen/Qwen-Image-2.1" or record.get("totalWeightBytes") != sum(FILES.values()):
                missing.append("verified model manifest")
            validation = record.get("validation", {})
            result["imageEditingVerified"] = isinstance(validation, dict) and validation.get("status") == "passed" and validation.get("imageEdits") is True
        else:
            missing.append("verified model manifest")
        result.update(modelHome=str(home), installed=not missing, missingFiles=missing, downloadedBytes=downloaded)
    except (OSError, ValueError) as exc:
        return {**result, "status": "error", "reason": str(exc)}
    state, ready = _probe()
    if ready:
        return {**result, "status": "ready", "ready": True, "available": True, "reason": "本机生图模型已加载；仅用于研究与评估"}
    if state == "port_conflict":
        return {**result, "status": state, "reason": "8190 端口上的服务不匹配此模型，未操作其他进程"}
    with _LOCK:
        if _process is not None and _process.poll() is None:
            return {**result, "status": "starting", "reason": "正在加载本机生图组件，首次加载可能较慢"}
        if _process is not None and _process.returncode is not None:
            return {**result, "status": "error", "reason": "本机生图进程已退出，查看模型包 work/local-qwen-image/server.stderr.log", "exitCode": _process.returncode}
    return {**result, "status": "stopped" if result["installed"] else "not_installed", "reason": "模型已安装，按需启动研究版生图" if result["installed"] else "可选生图组件还未完整下载并校验"}


def start(data: Path | None = None) -> dict:
    global _process
    with _LOCK:
        current = status(data)
        if current["status"] in {"ready", "starting", "port_conflict"} or not current["installed"]:
            return current
        from local_ai_runtime import status as assistant_status
        if assistant_status(data)["status"] in {"ready", "starting"}:
            return {**current, "status": "gpu_in_use", "reason": "请先停止本机千问视觉助手，释放显存后启动生图"}
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as check:
            check.settimeout(0.2)
            if check.connect_ex(("127.0.0.1", 8190)) == 0:
                return {**current, "status": "port_conflict", "reason": "8190 端口已有服务，未启动或停止其他进程"}
        home = model_home(data)
        logs = _inside(home, Path("work/local-qwen-image"))
        logs.mkdir(parents=True, exist_ok=True)
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        with (logs / "server.stdout.log").open("ab") as stdout, (logs / "server.stderr.log").open("ab") as stderr:
            _process = subprocess.Popen(arguments(home), cwd=_inside(home, RUNTIME_RELATIVE), stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, shell=False, creationflags=flags)
        return {**current, "status": "starting", "ready": False, "available": False, "canStop": True, "reason": "正在启动本机生图研究组件"}


def stop(data: Path | None = None) -> dict:
    global _process
    with _LOCK:
        child = _process
        if child is None or child.poll() is not None:
            return {**status(data), "reason": "本窗口没有可停止的生图进程，未操作其他服务"}
        child.terminate()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            return {**status(data), "status": "stopping", "ready": False, "reason": "正在等待本窗口启动的生图进程退出"}
        _process = None
        return {**status(data), "reason": "本机生图已停止并释放模型内存"}


def register_local_image_routes(app, core):
    @app.get("/api/local-image/status")
    def image_status():
        return status(core.DATA)

    @app.post("/api/local-image/start")
    def image_start(request: Request, payload: dict | None = None):
        core.require_local_origin(request)
        if payload:
            raise HTTPException(422, "启动接口不接受命令、参数或可执行路径")
        try:
            return start(core.DATA)
        except (OSError, ValueError) as exc:
            raise HTTPException(503, "无法启动本机生图：" + str(exc)) from None

    @app.post("/api/local-image/stop")
    def image_stop(request: Request, payload: dict | None = None):
        core.require_local_origin(request)
        if payload:
            raise HTTPException(422, "停止接口不接受进程号、端口或命令")
        try:
            return stop(core.DATA)
        except (OSError, ValueError) as exc:
            raise HTTPException(503, "无法停止本机生图：" + str(exc)) from None
