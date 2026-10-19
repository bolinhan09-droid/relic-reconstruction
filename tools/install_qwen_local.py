"""Install pinned public Qwen weights and llama.cpp locally, without global changes.

Run with a Python environment containing requests. Downloads are resumable;
Qwen files are SHA256-checked against the official Ollama registry manifest.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import time
import zipfile

import requests

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "models/qwen3.5-4b"
RUNTIME = ROOT / "tools/runtime/llama-b11669-cuda12"
BUILD = "b11669"  # Official binary build linked from llama.cpp v0.7.0.
REGISTRY = "https://registry.ollama.ai/v2/library/qwen3.5/blobs/sha256:"
WEIGHTS = [
    ("qwen3.5-4b-q4_k_m.gguf", "a9d0a3e1d8c91732a3812becd31f8d4a8ff57414903f226306069f0437e2ac50", 2648593216),
    ("mmproj-qwen3.5-4b-bf16.gguf", "e56a899b1540860385465756dd308c84417410b94dbc1c380adffd20a921ca60", 675569120),
    ("LICENSE.txt", "50cbab8a892c5f2993b8c7351a99182507472def3b1374558308605d99b86b32", 11343),
]


def segmented_download(url: str, path: Path, expected_hash: str, expected_size: int) -> dict:
    """Fetch large registry blobs in verified HTTP ranges, retaining interrupted work."""
    if path.is_file() and path.stat().st_size == expected_size and sha256(path) == expected_hash:
        return {"file": str(path.relative_to(ROOT)), "url": url, "bytes": expected_size, "sha256": expected_hash}
    path.parent.mkdir(parents=True, exist_ok=True)
    parts_dir = path.parent / (path.name + ".parts")
    parts_dir.mkdir(exist_ok=True)
    chunk_size = (expected_size + 5) // 6
    ranges = [(start, min(start + chunk_size, expected_size) - 1) for start in range(0, expected_size, chunk_size)]
    previous = path.with_name(path.name + ".part")
    if previous.is_file() and not any(parts_dir.iterdir()):
        with previous.open("rb") as source:
            for index, (start, end) in enumerate(ranges):
                remaining = min(end - start + 1, max(0, previous.stat().st_size - start))
                if not remaining:
                    break
                with (parts_dir / f"{index}.part").open("wb") as target:
                    while remaining:
                        block = source.read(min(remaining, 8 * 1024 * 1024))
                        target.write(block)
                        remaining -= len(block)

    def fetch(index_and_range):
        index, (start, end) = index_and_range
        part = parts_dir / f"{index}.part"
        for attempt in range(8):
            offset = part.stat().st_size if part.exists() else 0
            if offset == end - start + 1:
                return part
            try:
                headers = {"Range": f"bytes={start + offset}-{end}", "Accept-Encoding": "identity"}
                with requests.get(url, headers=headers, timeout=(30, 90), stream=True) as response:
                    response.raise_for_status()
                    if response.status_code != 206 or response.headers.get("Content-Range") != f"bytes {start + offset}-{end}/{expected_size}":
                        raise ValueError("Server did not honor exact model range")
                    last_log = time.monotonic()
                    with part.open("ab") as handle:
                        for block in response.iter_content(1024 * 1024):
                            if block:
                                handle.write(block)
                                offset += len(block)
                                if time.monotonic() - last_log >= 30:
                                    print(f"{path.name} range {index + 1}/6: {offset / 1e6:.0f} MB", flush=True)
                                    last_log = time.monotonic()
                if part.stat().st_size != end - start + 1:
                    raise ValueError("Incomplete model range")
                return part
            except (requests.RequestException, OSError) as exc:
                if attempt == 7:
                    raise
                print(f"Retry model range {index + 1}: {type(exc).__name__}", flush=True)
                time.sleep(2)
        raise RuntimeError("Model range incomplete")

    with ThreadPoolExecutor(max_workers=6) as executor:
        parts = list(executor.map(fetch, enumerate(ranges)))
    assembled = path.with_name(path.name + ".assembling")
    with assembled.open("wb") as target:
        for part in parts:
            with part.open("rb") as source:
                shutil.copyfileobj(source, target, 8 * 1024 * 1024)
    found = sha256(assembled)
    if assembled.stat().st_size != expected_size or found != expected_hash:
        raise ValueError("Official SHA256 mismatch after range assembly")
    assembled.replace(path)
    for part in parts:
        part.unlink()
    if previous.exists():
        previous.unlink()
    print("Downloaded and checked: " + path.name, flush=True)
    return {"file": str(path.relative_to(ROOT)), "url": url, "bytes": expected_size, "sha256": found}


def sha256(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def download(url: str, path: Path, expected_hash: str | None = None, expected_size: int | None = None) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file() and (expected_size is None or path.stat().st_size == expected_size):
        found = sha256(path)
        if expected_hash is None or found == expected_hash:
            print("Already verified: " + path.name, flush=True)
            return {"file": str(path.relative_to(ROOT)), "url": url, "bytes": path.stat().st_size, "sha256": found}
    temporary = path.with_name(path.name + ".part")
    for attempt in range(8):
        offset = temporary.stat().st_size if temporary.exists() else 0
        headers = {"Range": f"bytes={offset}-", "Accept-Encoding": "identity"} if offset else {"Accept-Encoding": "identity"}
        try:
            with requests.get(url, headers=headers, timeout=(30, 90), stream=True) as response:
                response.raise_for_status()
                resume = offset > 0 and response.status_code == 206
                if resume and not response.headers.get("Content-Range", "").startswith(f"bytes {offset}-"):
                    raise ValueError("Download range mismatch")
                size = offset if resume else 0
                last_log = time.monotonic()
                with temporary.open("ab" if resume else "wb") as handle:
                    for block in response.iter_content(1024 * 1024):
                        if block:
                            handle.write(block)
                            size += len(block)
                            if time.monotonic() - last_log >= 15:
                                print(f"{path.name}: {size / 1e6:.0f} MB", flush=True)
                                last_log = time.monotonic()
            if expected_size is not None and temporary.stat().st_size != expected_size:
                raise ValueError("Download size mismatch: " + path.name)
            found = sha256(temporary)
            if expected_hash is not None and found != expected_hash:
                raise ValueError("Official SHA256 mismatch: " + path.name)
            temporary.replace(path)
            print("Downloaded and checked: " + path.name, flush=True)
            return {"file": str(path.relative_to(ROOT)), "url": url, "bytes": path.stat().st_size, "sha256": found}
        except (requests.RequestException, OSError) as exc:
            if attempt == 7:
                raise
            print(f"Retry {path.name}: {type(exc).__name__}", flush=True)
            time.sleep(min(2 + attempt, 8))
    raise RuntimeError("Download incomplete")


def install_runtime() -> list[dict]:
    rows = []
    archives = (
        (f"llama-{BUILD}-bin-win-cuda-12.4-x64.zip", "c2da1f73ed176ae093ac5aceb978a7b167a16113f6d74c6789eeaee2135cb8dc", 266582698),
        ("cudart-llama-bin-win-cuda-12.4-x64.zip", "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6", 391443627),
    )
    for name, checksum, size in archives:
        archive = ROOT / "tools/runtime/downloads" / name
        url = f"https://github.com/ggml-org/llama.cpp/releases/download/{BUILD}/{name}"
        rows.append(download(url, archive, checksum, size))
        RUNTIME.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as package:
            for info in package.infolist():
                if not (RUNTIME / info.filename).resolve().is_relative_to(RUNTIME.resolve()):
                    raise ValueError("Unsafe runtime archive path")
            package.extractall(RUNTIME)
    rows.append(download(f"https://raw.githubusercontent.com/ggml-org/llama.cpp/{BUILD}/LICENSE", RUNTIME / "LICENSE.txt", "94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d", 1078))
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights-only", action="store_true")
    parser.add_argument("--runtime-only", action="store_true")
    args = parser.parse_args()
    rows = []
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = []
        if not args.runtime_only:
            for name, checksum, size in WEIGHTS:
                downloader = segmented_download if size > 1024 * 1024 * 1024 else download
                futures.append(executor.submit(downloader, REGISTRY + checksum, MODEL / name, checksum, size))
        runtime = executor.submit(install_runtime) if not args.weights_only else None
        for future in futures:
            rows.append(future.result())
        if runtime:
            rows.extend(runtime.result())
    MODEL.mkdir(parents=True, exist_ok=True)
    record = {"schemaVersion": 1, "model": "Qwen/Qwen3.5-4B", "quantization": "Q4_K_M", "distribution": "Ollama official library/qwen3.5:4b-q4_K_M", "upstreamModelCard": "https://huggingface.co/Qwen/Qwen3.5-4B", "registryManifest": "https://registry.ollama.ai/v2/library/qwen3.5/manifests/4b-q4_K_M", "license": "Apache-2.0", "runtime": "llama.cpp v0.7.0 / b11669 CUDA12", "baseUrl": "http://127.0.0.1:8188/v1", "apiModelName": "qwen3.5-4b-local", "files": rows, "imageUploaded": False, "validation": "pending"}
    (MODEL / "download-manifest.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Installation complete; runtime inference is not yet verified.", flush=True)


if __name__ == "__main__":
    main()
