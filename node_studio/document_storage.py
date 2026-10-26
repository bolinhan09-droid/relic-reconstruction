"""Transparent, content-addressed storage for editable workflow documents.

The HTTP/UI document stays ordinary JSON. Large subtrees are written once per
workflow and shared by snapshots and revision history. Chunks remain plain JSON
so the existing asset-reference collector can inspect them conservatively.
"""
from __future__ import annotations

import hashlib
import json
import re
import stat
from pathlib import Path

MAX_DOCUMENT_BYTES = 64 * 1024 * 1024
CHUNK_THRESHOLD = 32 * 1024
STORAGE_KEY = "_relicStorage"
REFERENCE_KEY = "$relicData"
_DIGEST = re.compile(r"[0-9a-f]{64}")


class DocumentStorageError(ValueError):
    pass


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                      sort_keys=True, allow_nan=False).encode("utf-8")


def _load(raw):
    def invalid_constant(_value):
        raise DocumentStorageError("non-finite JSON number")
    return json.loads(raw, parse_constant=invalid_constant)


def workflow_folder(path):
    path = Path(path)
    return path.parent.parent if path.parent.name == "history" else path.parent


class DocumentStorage:
    def __init__(self, folder, atomic_write):
        self.folder = Path(folder)
        self.chunks = self.folder / "chunks"
        self.atomic_write = atomic_write

    def _chunk_path(self, digest):
        if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
            raise DocumentStorageError("invalid chunk reference")
        path = self.chunks / (digest + ".json")
        for target in (self.folder, self.chunks, path):
            if target.exists() or target.is_symlink():
                info = target.lstat()
                if stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400):
                    raise DocumentStorageError("linked chunk paths are not supported")
        return path

    def pack(self, document):
        """Write immutable chunks before making a manifest reference them."""
        seen = set()

        def visit(value, root=False):
            if isinstance(value, dict):
                packed = {key: visit(item) for key, item in value.items()}
            elif isinstance(value, list):
                packed = [visit(item) for item in value]
            else:
                return value
            raw = encode(packed)
            if root or len(raw) < CHUNK_THRESHOLD:
                return packed
            digest = hashlib.sha256(raw).hexdigest()
            if digest not in seen:
                path = self._chunk_path(digest)
                if path.exists():
                    if path.stat().st_size != len(raw) or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                        raise DocumentStorageError("existing chunk failed integrity check")
                else:
                    self.atomic_write(path, raw)
                seen.add(digest)
            return {REFERENCE_KEY: digest}

        result = visit(document, root=True)
        result[STORAGE_KEY] = 1
        return result

    def unpack(self, stored):
        if not isinstance(stored, dict) or STORAGE_KEY not in stored:
            return stored  # Original inline workflows remain readable.
        if stored.get(STORAGE_KEY) != 1:
            raise DocumentStorageError("unsupported workflow storage format")
        # Start with the serialized manifest, then replace each reference's byte
        # cost by the actual chunk byte cost. This bounds expansion without
        # serializing every coordinate/colour scalar during each autosave.
        root = {key: value for key, value in stored.items() if key != STORAGE_KEY}
        remaining = MAX_DOCUMENT_BYTES - len(encode(root))
        cache, active = {}, set()

        def visit(value, depth=0):
            nonlocal remaining
            if depth > 40:
                raise DocumentStorageError("chunk nesting exceeds limit")
            if isinstance(value, dict) and REFERENCE_KEY in value:
                if len(value) != 1:
                    raise DocumentStorageError("mixed chunk reference")
                digest = value[REFERENCE_KEY]
                path = self._chunk_path(digest)
                if digest in active:
                    raise DocumentStorageError("cyclic chunk reference")
                if digest not in cache:
                    if not path.is_file() or path.stat().st_size > MAX_DOCUMENT_BYTES:
                        raise DocumentStorageError("workflow data chunk is missing or too large")
                    raw = path.read_bytes()
                    if hashlib.sha256(raw).hexdigest() != digest:
                        raise DocumentStorageError("workflow data chunk failed integrity check")
                    cache[digest] = (_load(raw), len(raw))
                remaining -= cache[digest][1] - len(encode(value))
                if remaining < 0:
                    raise DocumentStorageError("expanded workflow exceeds limit")
                active.add(digest)
                try:
                    return visit(cache[digest][0], depth)
                finally:
                    active.remove(digest)
            if isinstance(value, dict):
                result = {key: visit(item, depth + 1) for key, item in value.items()}
            elif isinstance(value, list):
                result = [visit(item, depth + 1) for item in value]
            else:
                result = value
            if remaining < 0:
                raise DocumentStorageError("expanded workflow exceeds limit")
            return result

        return visit(root)

    def collect_orphans(self):
        """Remove only unreferenced hash chunks after every manifest is readable.

        All historic revisions are roots. A missing, corrupt, linked or unknown
        manifest disables collection; ordinary save never sacrifices history.
        """
        if not self.chunks.is_dir() or self.chunks.is_symlink():
            return
        live, pending = set(), []

        def references(value):
            if isinstance(value, dict):
                if REFERENCE_KEY in value:
                    if len(value) != 1 or not isinstance(value[REFERENCE_KEY], str) or not _DIGEST.fullmatch(value[REFERENCE_KEY]):
                        raise DocumentStorageError("invalid garbage-collection reference")
                    pending.append(value[REFERENCE_KEY])
                else:
                    for item in value.values():
                        references(item)
            elif isinstance(value, list):
                for item in value:
                    references(item)

        try:
            manifests = [self.folder / "workflow.json", *(self.folder / "history").glob("revision-*.json")]
            for path in manifests:
                if not path.is_file() or path.is_symlink() or path.stat().st_size > MAX_DOCUMENT_BYTES:
                    return
                references(_load(path.read_bytes()))
            while pending:
                digest = pending.pop()
                if digest in live:
                    continue
                path = self._chunk_path(digest)
                if not path.is_file() or path.stat().st_size > MAX_DOCUMENT_BYTES:
                    return
                raw = path.read_bytes()
                if hashlib.sha256(raw).hexdigest() != digest:
                    return
                references(_load(raw))
                live.add(digest)
            for path in self.chunks.glob("*.json"):
                if _DIGEST.fullmatch(path.stem) and path.stem not in live and path.is_file() and not path.is_symlink():
                    self._chunk_path(path.stem).unlink()
        except (OSError, ValueError, RecursionError):
            return  # Collection is optional; a saved work must remain saved.
