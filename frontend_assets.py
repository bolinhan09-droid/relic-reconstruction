"""Serve each frontend build under its own URL without changing the app origin.

The desktop browser retains its profile across upgrades. A new HTML document
alone is not enough: cached ES modules, CSS and the embedded legacy editor must
also receive new URLs. User storage and /api, /data and /resources stay intact.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException


NO_STORE_HEADERS = {
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}
_TEXT_TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css"}
_URL_ATTRIBUTE = re.compile(r"(\b(?:src|href|poster)\s*=\s*)(['\"])(.*?)\2", re.I)
_ROOT_LITERAL = re.compile(r"(['\"`])(/[^'\"`\r\n]*)\1")
_CSS_URL = re.compile(r"(url\(\s*)([^'\"\s)][^)]*?)(\s*\))", re.I)
_CONDITIONAL = {b"if-none-match", b"if-modified-since"}


class NoStoreStaticFiles(StaticFiles):
    """Compatibility URLs must not keep a second, stale copy of the UI."""

    async def get_response(self, path: str, scope: dict):
        fresh = dict(scope, headers=[(key, value) for key, value in scope.get("headers", [])
                                     if key.lower() not in _CONDITIONAL])
        response = await super().get_response(path, fresh)
        response.headers.update(NO_STORE_HEADERS)
        return response


class FrontendAssets:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        digest = hashlib.sha256(b"relic-frontend-transform-v1\0")
        for path in sorted(self.root.rglob("*")):
            if path.is_file() and path.resolve().is_relative_to(self.root):
                digest.update(path.relative_to(self.root).as_posix().encode("utf-8") + b"\0")
                with path.open("rb") as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(block)
                digest.update(b"\0")
        self.fingerprint = digest.hexdigest()[:20]
        self.mount_path = "/ui/" + self.fingerprint
        self.headers = {**NO_STORE_HEADERS, "X-Relic-UI-Build": self.fingerprint}
        self.static = _FrontendStatic(self)

    def _file(self, relative: str) -> Path:
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root) or not path.is_file():
            raise HTTPException(404, "Frontend asset not found")
        return path

    def _url(self, value: str, relative: str = "", *, navigation: bool = False) -> str:
        if not value or value.startswith(("#", "//")):
            return value
        parsed = urlsplit(value)
        if parsed.scheme or parsed.netloc:
            return value
        path = unquote(parsed.path)
        suffix = value[len(parsed.path):]
        if path == "/legacy":
            return self.mount_path + "/index.html" + suffix
        if path == "/" and navigation:
            return self.mount_path + "/node-studio/index.html" + suffix
        if path.startswith("/web/"):
            target = path[5:]
        elif path.startswith(("/api/", "/data/", "/resources/", "/ui/")):
            return value
        elif path.startswith("/"):
            target = path[1:]
        elif relative:
            target = (Path(relative).parent / path).as_posix()
        else:
            return value
        # Only known bundled files may be changed; API and user asset URLs are
        # never reinterpreted as frontend files.
        candidate = (self.root / target).resolve()
        if candidate.is_relative_to(self.root) and candidate.is_file():
            return self.mount_path + "/" + candidate.relative_to(self.root).as_posix() + suffix
        return value

    def transform(self, text: str, relative: str) -> str:
        if Path(relative).suffix.lower() == ".html":
            text = _URL_ATTRIBUTE.sub(
                lambda match: match[1] + match[2]
                + self._url(match[3], relative, navigation=True) + match[2], text)
            metadata = f'<meta name="relic-ui-build" content="{self.fingerprint}">'
            return re.sub(r"(<head\b[^>]*>)", lambda match: match[1] + metadata,
                          text, count=1, flags=re.I)
        text = _ROOT_LITERAL.sub(
            lambda match: match[1] + self._url(match[2]) + match[1], text)
        if Path(relative).suffix.lower() == ".css":
            text = _CSS_URL.sub(lambda match: match[1] + self._url(match[2]) + match[3], text)
        return text

    def entry_html(self, relative: str = "node-studio/index.html") -> HTMLResponse:
        text = self._file(relative).read_text(encoding="utf-8")
        return HTMLResponse(self.transform(text, relative), headers=self.headers)


class _FrontendStatic(NoStoreStaticFiles):
    def __init__(self, assets: FrontendAssets):
        super().__init__(directory=assets.root, html=True, follow_symlink=False)
        self.assets = assets

    async def get_response(self, path: str, scope: dict):
        response = await super().get_response(path, scope)
        response.headers.update(self.assets.headers)
        if response.status_code != 200 or not getattr(response, "path", None):
            return response
        source = Path(response.path).resolve()
        if not source.is_relative_to(self.assets.root):
            raise HTTPException(404, "Frontend asset not found")
        relative = source.relative_to(self.assets.root).as_posix()
        if source.suffix.lower() == ".html":
            return self.assets.entry_html(relative)
        media_type = _TEXT_TYPES.get(source.suffix.lower())
        if media_type:
            return Response(self.assets.transform(source.read_text(encoding="utf-8"), relative),
                            media_type=media_type, headers=self.assets.headers)
        return response
