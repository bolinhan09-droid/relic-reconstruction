"""Non-executing local model manifests and optional loopback runtime status."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import httpx
from fastapi import HTTPException, Request

from runtime_paths import loopback_url

MAX_MANIFEST = 128 * 1024
MAX_MODELS = 100


def get_settings(data: Path) -> dict:
    default = {"comfyUrl": "http://127.0.0.1:8189", "modelDir": str(data / "models")}
    path = data / "runtime" / "local-models.json"
    try:
        if path.is_file() and path.stat().st_size <= 16384:
            saved = json.loads(path.read_text(encoding="utf-8-sig"))
            default["comfyUrl"] = loopback_url(saved.get("comfyUrl", default["comfyUrl"]), api=False)
            folder = saved.get("modelDir", default["modelDir"])
            if isinstance(folder, str) and Path(folder).is_absolute():
                default["modelDir"] = str(Path(folder).resolve())
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return {**default, "storage": "local_non_secret_settings"}


def configure(core, payload) -> dict:
    if not isinstance(payload, dict) or set(payload) - {"comfyUrl", "modelDir"}:
        raise HTTPException(422, "本机模型配置只接受服务地址和模型目录，不接受密钥或启动命令")
    current = get_settings(core.DATA)
    try:
        url = loopback_url(payload.get("comfyUrl", current["comfyUrl"]), api=False)
        folder = payload.get("modelDir", current["modelDir"])
        if not isinstance(folder, str) or len(folder) > 2000 or any(ord(char) < 32 for char in folder):
            raise ValueError("模型目录格式不正确")
        chosen = Path(folder) if folder.strip() else core.DATA / "models"
        if not chosen.is_absolute():
            raise ValueError("请选择模型包的绝对目录")
        chosen = chosen.resolve()
        if chosen.exists() and not chosen.is_dir():
            raise ValueError("请选择目录，不能选择模型文件或可执行程序")
        # Do not create an arbitrary selected directory, launch commands, import
        # Python from it or deserialize model weights.
    except (OSError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from None
    saved = {"comfyUrl": url, "modelDir": str(chosen)}
    with core.LOCK:
        core.write_json(core.DATA / "runtime" / "local-models.json", saved)
        core.COMFY_URL = url
    return {**saved, "storage": "local_non_secret_settings"}


def _manifest(root: Path) -> tuple[list[dict], str, list[str]]:
    path = root / "manifest.json"
    try:
        if not path.is_file():
            return [], "missing", []
        if path.stat().st_size > MAX_MANIFEST or not path.resolve().is_relative_to(root):
            return [], "invalid", ["模型清单过大或越出选定目录，未读取。"]
        value = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(value, dict) or value.get("schemaVersion") != 1 or not isinstance(value.get("models"), list) or len(value["models"]) > MAX_MODELS:
            raise ValueError()
    except (OSError, ValueError):
        return [], "invalid", ["manifest.json 格式不正确，应为 schemaVersion:1 与 models 列表；未执行包内代码。"]
    result, warnings, seen = [], [], set()
    for row in value["models"]:
        if not isinstance(row, dict) or set(row) - {"id", "kind", "architecture", "file", "checkpointName", "damageType", "title"}:
            warnings.append("忽略包含非清单字段的模型条目。"); continue
        identifier, relative = row.get("id"), row.get("file")
        kind, architecture = row.get("kind"), row.get("architecture", "unknown")
        if (not isinstance(identifier, str) or not identifier or len(identifier) > 100 or identifier in seen
                or not isinstance(relative, str) or len(relative) > 500 or Path(relative).is_absolute()
                or ":" in relative or "\\" in relative or ".." in Path(relative).parts
                or not isinstance(kind, str) or kind not in {"checkpoint", "base", "lora"}
                or not isinstance(architecture, str) or architecture not in {"sd15", "sdxl", "flux", "unknown"}):
            warnings.append("忽略编号、架构或相对路径不正确的条目。"); continue
        try:
            candidate = (root / relative).resolve()
        except (OSError, ValueError):
            warnings.append("忽略无法解析的模型文件路径。")
            continue
        if not candidate.is_relative_to(root) or candidate.suffix.lower() != ".safetensors":
            warnings.append("只登记包内 safetensors，不加载 Python、pickle、可执行文件或目录外模型。"); continue
        seen.add(identifier)
        name = row.get("checkpointName", candidate.name)
        if not isinstance(name, str) or len(name) > 500 or ".." in name or name.startswith(("/", "\\")) or ":" in name:
            warnings.append("忽略 ComfyUI 模型名称不正确的条目。"); continue
        exists = candidate.is_file()
        entry = {"id": identifier, "kind": kind, "architecture": architecture, "file": str(candidate), "checkpointName": name,
                 "exists": exists, "status": "ready" if exists and architecture == "sd15" else "unavailable" if not exists else "discovered",
                 "source": "package_manifest", "compatibilityVerified": False}
        if kind == "lora":
            effect = row.get("damageType")
            if not isinstance(effect, str) or effect not in {"blood", "slash", "burn", "wear"}:
                warnings.append("LoRA 未声明有效痕迹类型，保留为未兼容。")
                entry["status"] = "discovered"
            else:
                entry["damageType"] = effect
        result.append(entry)
    return result, "read", warnings


def scan(data: Path, resources: Path | None = None) -> dict:
    settings = get_settings(data)
    root = Path(settings["modelDir"]).resolve()
    models, state, warnings = _manifest(root) if root.is_dir() else ([], "directory_missing", ["本机模型目录尚不存在，软件没有附带或下载模型。"])
    known = {entry["file"] for entry in models}
    if root.is_dir():
        count = 0
        try:
            for candidate in root.rglob("*.safetensors"):
                count += 1
                if count > 500 or len(models) >= MAX_MODELS:
                    warnings.append("扫描达到数量上限；请使用一个较小的专用模型目录。"); break
                path = candidate.resolve()
                if not path.is_relative_to(root) or not path.is_file() or str(path) in known:
                    continue
                models.append({"id": "discovered-" + hashlib.sha256(str(path.relative_to(root)).encode()).hexdigest()[:12],
                               "kind": "unknown", "architecture": "unknown", "file": str(path), "checkpointName": path.name,
                               "exists": True, "status": "discovered", "source": "discovered_safetensors", "compatibilityVerified": False})
        except OSError:
            warnings.append("部分模型目录不可读取；没有加载权重或运行包内代码。")
    if resources is not None:
        path = resources / "models.json"
        try:
            if path.is_file() and path.stat().st_size <= MAX_MANIFEST:
                value = json.loads(path.read_text(encoding="utf-8-sig"))
                rows = value if isinstance(value, list) else value.get("models", [])
                for row in rows[:MAX_MODELS]:
                    if not isinstance(row, dict) or row.get("id") in {entry["id"] for entry in models}:
                        continue
                    entry = dict(row)
                    file = entry.get("file") or entry.get("path")
                    candidate = Path(file).resolve() if isinstance(file, str) and file else None
                    exists = bool(candidate and candidate.suffix.lower() == ".safetensors" and candidate.is_file())
                    entry.update(exists=exists, source="bundled_registry", compatibilityVerified=False)
                    if not exists and entry.get("status") in {"ready", "trained", "available"}:
                        entry["status"] = "unavailable"
                    models.append(entry)
        except (OSError, ValueError, TypeError, AttributeError):
            warnings.append("随软件的模型登记表不可读取；未将其当作模型已安装。")
    return {"settings": settings, "models": models, "manifestStatus": state, "warnings": warnings,
            "modelFilesLoaded": False, "automaticDownload": False,
            "service": {"comfy": {"available": None, "url": settings["comfyUrl"], "reason": "尚未探测本机服务"}}}


def registered_models(resources: Path, data: Path) -> list[dict]:
    return scan(data, resources)["models"]


def probe_comfy(url: str) -> dict:
    url = loopback_url(url, api=False)
    try:
        with httpx.Client(timeout=2, trust_env=False, follow_redirects=False) as client:
            response = client.get(url + "/system_stats")
            if response.status_code != 200 or len(response.content) > 128 * 1024:
                raise ValueError()
            value = response.json()
            if not isinstance(value, dict) or not isinstance(value.get("system"), dict):
                raise ValueError()
        return {"available": True, "url": url, "reason": "ComfyUI 状态端点可读取；不代表底模、LoRA 或最终效果已验证"}
    except (httpx.HTTPError, ValueError):
        return {"available": False, "url": url, "reason": "未连接到有效的本机 ComfyUI 状态端点；没有启动、安装或下载模型"}


def register_local_model_routes(app, core):
    @app.get("/api/settings/local-models")
    def settings():
        return get_settings(core.DATA)

    @app.post("/api/settings/local-models")
    def save(payload: dict, request: Request):
        core.require_local_origin(request)
        return configure(core, payload)

    @app.get("/api/local-models")
    def models(probe: bool = False):
        result = scan(core.DATA, core.RESOURCES)
        if probe:
            result["service"]["comfy"] = probe_comfy(result["settings"]["comfyUrl"])
        return result
