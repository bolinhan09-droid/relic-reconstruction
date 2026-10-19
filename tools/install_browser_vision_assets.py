"""Fetch pinned official npm browser assets and Google hand landmark weights.

No npm lifecycle scripts run. npm tarballs are checked against published SRI.
Only explicitly selected regular files are copied into the project's web tree.
"""
from __future__ import annotations
import base64
import hashlib
import io
import json
from pathlib import Path
import shutil
import tarfile

import requests

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "web/node-studio/vendor"
PACKAGES = [
    ("@mediapipe/tasks-vision", "1.1.1", "mediapipe", "sha512-jwntgT5tzDrKOkqg6xNDNpRcTUnGvmylZE5DFnzPXossiWOIDdZX+C81LI75hlXhsG58YZW+lGzcmjH1qrQE/Q=="),
    ("three", "0.186.1", "three", "sha512-blFeqb49wRCSGUGj7gtpfnSGHy2lwDk94RhUmS1c/hTby70kvChbWpkJ4Pm1390LqzzvTmzgXKHPEafJwCb8jA=="),
]
MEDIAPIPE_LICENSE_URL = "https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/LICENSE"
MEDIAPIPE_LICENSE_SHA256 = "8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8"
HAND_MODEL_SHA256 = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1"


def install_mediapipe_license(target: Path) -> dict:
    """The npm tarball omits LICENSE; fetch and pin the official repository copy."""
    path = target / "LICENSE"
    content = path.read_bytes() if path.is_file() else b""
    if hashlib.sha256(content).hexdigest() != MEDIAPIPE_LICENSE_SHA256:
        response = requests.get(MEDIAPIPE_LICENSE_URL, timeout=30)
        response.raise_for_status()
        content = response.content
    if hashlib.sha256(content).hexdigest() != MEDIAPIPE_LICENSE_SHA256:
        raise ValueError("MediaPipe license differs from reviewed upstream copy")
    path.write_bytes(content)
    return {"file": str(path.relative_to(ROOT)), "source": MEDIAPIPE_LICENSE_URL, "bytes": len(content), "sha256": MEDIAPIPE_LICENSE_SHA256}


def local_three_import(target: Path) -> dict:
    path = target / "examples/jsm/controls/OrbitControls.js"
    source = path.read_text(encoding="utf-8")
    marker = "from 'three';"
    if source.count(marker) != 1:
        raise ValueError("Pinned Three.js import changed; review before installing")
    upstream_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    path.write_bytes(source.replace(marker, "from '../../../build/three.module.js';").encode("utf-8"))
    (target / "LOCAL_CHANGES.md").write_text(
        "# Local modification to Three.js 0.186.1\n\n"
        "OrbitControls imports the packaged three.module.js via a relative path instead of the bare three module name. "
        "Control behavior and MIT license are unchanged.\n", encoding="utf-8")
    return {"file": str(path.relative_to(ROOT)), "reason": "Resolve Three.js from local packaged assets", "upstreamSha256": upstream_hash, "installedSha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def disable_mediapipe_telemetry(target: Path) -> dict:
    """Patch only the pinned metrics sender; preserve inference and license."""
    bundle = target / "vision_bundle.mjs"
    source = bundle.read_text(encoding="utf-8")
    marker = 'this.o.send({url:"https://odml.pa.googleapis.com/v1/log"'
    replacement = '(()=>{t?.();})({url:"https://odml.pa.googleapis.com/v1/log"'
    if source.count(marker) != 1:
        raise ValueError("Pinned MediaPipe telemetry hook changed; review before installing")
    upstream_hash = hashlib.sha256(bundle.read_bytes()).hexdigest()
    source = '// Locally modified: optional metrics sender disabled for offline processing. See LOCAL_CHANGES.md.\n' + source.replace(marker, replacement)
    bundle.write_text(source, encoding="utf-8")
    (target / "LOCAL_CHANGES.md").write_text(
        "# Local modification to MediaPipe Tasks Vision 1.1.1\n\n"
        "The pinned npm archive is first verified against the published SHA512 integrity. "
        "The single performance-metrics sender to odml.pa.googleapis.com/v1/log is then replaced with a success callback without sending. "
        "The model, WASM, inference graph and Apache-2.0 license remain unchanged. "
        "This is a modified distribution, not an upstream privacy setting. "
        "The installer fails if the exact expected sender changes.\n",
        encoding="utf-8",
    )
    return {"file": str(bundle.relative_to(ROOT)), "reason": "Disable optional external performance telemetry", "upstreamSha256": upstream_hash, "installedSha256": hashlib.sha256(bundle.read_bytes()).hexdigest()}


def main():
    records = []
    for name, version, folder, integrity in PACKAGES:
        metadata_url = f"https://registry.npmjs.org/{name}/{version}"
        metadata = requests.get(metadata_url, timeout=30)
        metadata.raise_for_status()
        metadata = metadata.json()
        if metadata["dist"]["integrity"] != integrity:
            raise ValueError("npm integrity differs from pinned registry metadata")
        response = requests.get(metadata["dist"]["tarball"], timeout=90)
        response.raise_for_status()
        actual = "sha512-" + base64.b64encode(hashlib.sha512(response.content).digest()).decode()
        if actual != integrity:
            raise ValueError("npm package integrity mismatch")
        target = VENDOR / folder
        target.mkdir(parents=True, exist_ok=True)
        files = []
        with tarfile.open(fileobj=io.BytesIO(response.content), mode="r:gz") as archive:
            for member in archive:
                relative = member.name.removeprefix("package/")
                selected = relative in {"LICENSE", "LICENSE.txt", "package.json", "README.md"}
                if folder == "mediapipe":
                    selected |= relative == "vision_bundle.mjs" or relative.startswith("wasm/")
                else:
                    selected |= relative in {"build/three.module.js", "build/three.core.js", "examples/jsm/controls/OrbitControls.js"}
                if not selected or not member.isfile():
                    continue
                destination = (target / relative).resolve()
                if not destination.is_relative_to(target.resolve()):
                    raise ValueError("Invalid package path")
                destination.parent.mkdir(parents=True, exist_ok=True)
                content = archive.extractfile(member).read()
                destination.write_bytes(content)
                files.append({"file": str(destination.relative_to(ROOT)), "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()})
        record = {"package": name, "version": version, "source": metadata["dist"]["tarball"], "integrity": integrity, "files": files, "installScriptsExecuted": False}
        if folder == "mediapipe":
            record["additionalLicense"] = install_mediapipe_license(target)
            record["localModifications"] = [disable_mediapipe_telemetry(target)]
        else:
            record["localModifications"] = [local_three_import(target)]
        (target / "download-manifest.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
        records.append(record)
        print(name, version, "verified; extracted bytes", sum(row["bytes"] for row in files), flush=True)
    url = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
    response = requests.get(url, timeout=90)
    response.raise_for_status()
    if hashlib.sha256(response.content).hexdigest() != HAND_MODEL_SHA256:
        raise ValueError("Google hand landmark model differs from reviewed version")
    model = ROOT / "models/mediapipe/hand_landmarker.task"
    model.parent.mkdir(parents=True, exist_ok=True)
    model.write_bytes(response.content)
    web_model = VENDOR / "mediapipe/models/hand_landmarker.task"
    web_model.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(model, web_model)
    record = {"source": url, "version": "float16/1", "bytes": model.stat().st_size, "sha256": hashlib.sha256(response.content).hexdigest(), "files": [str(model.relative_to(ROOT)), str(web_model.relative_to(ROOT))], "externalImageUpload": False}
    (model.parent / "download-manifest.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    print("Google hand landmark model downloaded:", record["bytes"], record["sha256"], flush=True)


if __name__ == "__main__":
    main()
