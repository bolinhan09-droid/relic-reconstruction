"""Download public, pinned surface-analysis weights; never upload any image."""
from pathlib import Path
import argparse
import hashlib
import json
import requests
import time

ROOT = Path(__file__).resolve().parents[1]
REPO = "depth-anything/Depth-Anything-V2-Small-hf"
REVISION = "5426e4f0f36572d16453bbda7a8389317b1bef99"
DEPTH_FILES = {
    "config.json": None,
    "preprocessor_config.json": None,
    "model.safetensors": "3152477ce0d8d6978d76b995120de97cb5b928701fd0f817769f59e249a16b70",
    "README.md": None,
}
FOREGROUND = {
    "u2netp": "8e83ca70e441ab06c318d82300c84806",
    "u2net": "60024c5c889badc19c04ad937298a77b",
    "u2net_human_seg": "c09ddc2e0104f800e3e1bb4652583d1f",
}


def digest(path, algorithm="sha256"):
    h = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url, path, expected=None, algorithm="sha256"):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.is_file() or (expected and digest(path, algorithm) != expected):
        temporary = path.with_suffix(path.suffix + ".part")
        for attempt in range(6):
            offset = temporary.stat().st_size if temporary.is_file() else 0
            headers = {"Range": f"bytes={offset}-"} if offset else {}
            try:
                with requests.get(url, headers=headers, stream=True, timeout=120) as response:
                    response.raise_for_status()
                    mode = "ab" if offset and response.status_code == 206 else "wb"
                    with temporary.open(mode) as stream:
                        for chunk in response.iter_content(64 * 1024):
                            stream.write(chunk)
                break
            except requests.RequestException:
                if attempt == 5:
                    raise
                print("Retry " + path.name + " from " + str(temporary.stat().st_size if temporary.is_file() else 0), flush=True)
                time.sleep(1)
        if expected and digest(temporary, algorithm) != expected:
            raise ValueError("Official checksum mismatch: " + path.name)
        temporary.replace(path)
    print("Verified " + path.name, flush=True)
    return {"file": str(path.relative_to(ROOT)), "url": url, "bytes": path.stat().st_size,
            "sha256": digest(path), "officialChecksum": expected, "checksumAlgorithm": algorithm}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--foreground", choices=list(FOREGROUND), default="u2netp")
    args = parser.parse_args()
    target = ROOT / "models/garment-surface"
    rows = []
    for name, expected in DEPTH_FILES.items():
        rows.append(download(f"https://huggingface.co/{REPO}/resolve/{REVISION}/{name}",
                             target / "depth-anything-v2-small" / name, expected))
    name = args.foreground
    rows.append(download(f"https://github.com/danielgatis/rembg/releases/download/v0.0.0/{name}.onnx",
                         target / (name + ".onnx"), FOREGROUND[name], "md5"))
    for name, url in {
        "DepthAnything-LICENSE.txt": "https://raw.githubusercontent.com/DepthAnything/Depth-Anything-V2/main/LICENSE",
        "U2Net-LICENSE.txt": "https://raw.githubusercontent.com/xuebinqin/U-2-Net/master/LICENSE",
    }.items():
        rows.append(download(url, target / name))
    manifest = {"status": "downloaded", "depthRepository": REPO, "depthRevision": REVISION,
                "foregroundModel": args.foreground, "license": "Apache-2.0 (upstream declared)",
                "imageUploaded": False, "networkPurpose": "Public weights and source licenses only", "files": rows}
    (target / ("download-manifest-" + args.foreground + ".json")).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
