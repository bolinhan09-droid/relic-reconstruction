"""Separate immutable application assets from portable user data."""
from __future__ import annotations

import os
import sys
import json
import uuid
from pathlib import Path
from urllib.parse import urlparse


def asset_root() -> Path:
    if getattr(sys, "frozen", False) and getattr(sys, "_MEIPASS", None):
        return Path(sys._MEIPASS).resolve()
    return Path(__file__).resolve().parent


def data_root() -> Path:
    explicit = os.environ.get("RELIC_DATA_DIR", "").strip()
    if explicit:
        chosen = Path(explicit).expanduser()
        if not chosen.is_absolute():
            raise ValueError("RELIC_DATA_DIR must be an absolute writable workspace directory")
        return chosen.resolve()
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "workspace"
    return asset_root() / "data"


def loopback_url(value: object, *, api: bool = True) -> str:
    """Allow a literal loopback only, never arbitrary local/private network URLs."""
    if not isinstance(value, str) or len(value) > 300:
        raise ValueError("请填写本机 HTTP 地址，例如 http://127.0.0.1:1234/v1")
    value = value.strip().rstrip("/")
    try:
        parsed = urlparse(value)
        host = parsed.hostname
        if (parsed.scheme != "http" or host not in {"127.0.0.1", "localhost", "::1"}
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in (("", "/v1") if api else ("",))
                or any(ord(char) < 33 for char in value) or "\\" in value
                or (parsed.port is not None and not 1 <= parsed.port <= 65535)):
            raise ValueError()
        # localhost is normalized to an IP to prevent a custom DNS/proxy route.
        authority = "[::1]" if host == "::1" else "127.0.0.1"
        if parsed.port is not None:
            authority += ":" + str(parsed.port)
        return parsed._replace(netloc=authority, path="/v1" if api else "").geturl()
    except (ValueError, TypeError):
        raise ValueError("本机服务仅接受 HTTP loopback 地址，不能含账号、参数、路径穿越或具体请求路径") from None


_OPTIONS = {
    "local-image.json": {"baseUrl", "model", "quality", "selected"},
    "local-assistant.json": {"baseUrl", "model", "vision", "selected"},
}


def read_local_options(name: str) -> dict:
    if name not in _OPTIONS:
        raise ValueError("Unknown non-secret option file")
    try:
        path = data_root() / "runtime" / name
        if not path.is_file() or path.stat().st_size > 16384:
            return {}
        value = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(value, dict) or set(value) - _OPTIONS[name]:
            return {}
        return value
    except (OSError, ValueError, TypeError):
        return {}


def write_local_options(name: str, value: dict) -> None:
    if name not in _OPTIONS or not isinstance(value, dict) or set(value) - _OPTIONS[name]:
        raise ValueError("Only allowlisted non-secret local model settings may be saved")
    path = data_root() / "runtime" / name
    temporary = None
    try:
        content = json.dumps(value, ensure_ascii=False, allow_nan=False)
        if len(content.encode("utf-8")) > 16384:
            raise ValueError()
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
        temporary.write_text(content, encoding="utf-8")
        os.replace(temporary, path)
    except (OSError, ValueError):
        raise ValueError("无法保存本机模型设置，请检查工作目录是否可写；密钥没有写入文件") from None
    finally:
        if temporary is not None and temporary.exists():
            try:
                temporary.unlink()
            except OSError:
                pass
