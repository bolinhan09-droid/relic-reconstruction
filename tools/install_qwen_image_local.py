"""Optional Qwen Image 2.1 research install; never part of the default app package.

Source model uses Qwen RESEARCH LICENSE, not Apache-2.0. Quantized generation
weights are supplied by stable-diffusion.cpp's maintainer and are not an
official Qwen quantization. All four weight hashes come from HF LFS metadata.
"""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import zipfile

from install_qwen_local import download, segmented_download

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "models/qwen-image-2.1-research"
RUNTIME = ROOT / "tools/runtime/sd-95b3090-cuda12"
RELEASE = "master-975-95b3090"
FILES = [
    ("leejet/Qwen-Image-2.1-GGUF", "qwen_image_2.1-Q4_K.gguf", 4197494816, "29f9c83c249ff0292fb2943fceddfa2319b446601866c82a4f8be062abea72c2"),
    ("Qwen/Qwen3-VL-8B-Instruct-GGUF", "Qwen3VL-8B-Instruct-Q4_K_M.gguf", 5027784800, "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2"),
    ("Qwen/Qwen3-VL-8B-Instruct-GGUF", "mmproj-Qwen3VL-8B-Instruct-F16.gguf", 1159029824, "ca524100ebf825c9a870db1c580d03879e0da0ab2541697e2458e64891cf9d38"),
    ("Comfy-Org/Qwen-Image-2.1", "vae/qwen_image_2.1_vae_bf16.safetensors", 675509688, "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9"),
]


def install_weight(row):
    repository, filename, size, checksum = row
    fetch = segmented_download if size > 1024 ** 3 else download
    return fetch(f"https://huggingface.co/{repository}/resolve/main/{filename}?download=true", MODEL / Path(filename).name, checksum, size)


def install_runtime():
    rows = []
    archives = (
        ("sd-master-95b3090-bin-win-cuda12-x64.zip", "b935f5902fbedefe6db0b68c8930ae3e7c0f3cc778bd5d501a3c7f7ee7336338", 343630973),
        ("cudart-sd-bin-win-cu12-x64.zip", "fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d", 563452046),
    )
    for name, checksum, size in archives:
        archive = ROOT / "tools/runtime/downloads" / name
        rows.append(download(f"https://github.com/leejet/stable-diffusion.cpp/releases/download/{RELEASE}/{name}", archive, checksum, size))
        RUNTIME.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as package:
            for entry in package.infolist():
                if not (RUNTIME / entry.filename).resolve().is_relative_to(RUNTIME.resolve()):
                    raise ValueError("Unsafe runtime archive path")
            package.extractall(RUNTIME)
    return rows


def main():
    MODEL.mkdir(parents=True, exist_ok=True)
    rows = [download("https://huggingface.co/Qwen/Qwen-Image-2.1/raw/main/LICENSE", MODEL / "LICENSE.txt", "8dc973f024ff95966bea25866efa443fd16776dcb1001e681e3d467ea572b28d", 7831)]
    (MODEL / "NOTICE.txt").write_text(
        "Qwen is licensed under the Qwen RESEARCH LICENSE AGREEMENT, Copyright (c) 2026 Hangzhou Tongyi Laboratory Technology Co., Ltd. All Rights Reserved.\n"
        "Optional local research/evaluation component. Not included in the application distribution.\n"
        "Generation weights are a Q4_K conversion by leejet/stable-diffusion.cpp, not official Qwen weights in their original precision.\n",
        encoding="utf-8",
    )
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(install_weight, row) for row in FILES]
        runtime = pool.submit(install_runtime)
        for result in futures:
            rows.append(result.result())
        rows.extend(runtime.result())
    manifest = {
        "schemaVersion": 1, "model": "Qwen/Qwen-Image-2.1", "license": "Qwen RESEARCH LICENSE AGREEMENT",
        "commercialUse": False, "includeInApplicationPackage": False,
        "originalModelCard": "https://huggingface.co/Qwen/Qwen-Image-2.1",
        "runtimeDocumentation": "https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/qwen_image_2.1.md",
        "runtime": RELEASE, "totalWeightBytes": sum(row[2] for row in FILES), "files": rows, "validation": "pending",
    }
    (MODEL / "download-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Optional research components installed. Hardware feasibility still requires real inference.", flush=True)


if __name__ == "__main__":
    main()
