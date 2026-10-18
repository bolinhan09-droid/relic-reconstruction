"""Local foreground + relative inverse-depth inference. No network or training.

Foreground is salient person/object segmentation, not garment/material parsing.
Depth is monocular relative inverse-depth, not fold height in real units.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import sys
import time

ROOT = Path(__file__).resolve().parents[1]


def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def infer_foreground(image, path):
    import numpy as np
    import onnxruntime as ort
    from PIL import Image
    # Matches rembg U2netpSession/BaseSession preprocessing (ImageNet mean/std).
    arr = np.asarray(image.resize((320, 320), Image.Resampling.LANCZOS), dtype=np.float32)
    arr /= max(float(arr.max()), 1.0)
    arr = (arr - np.array([.485, .456, .406], np.float32)) / np.array([.229, .224, .225], np.float32)
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 4
    session = ort.InferenceSession(str(path), sess_options=opts, providers=["CPUExecutionProvider"])
    prediction = session.run(None, {session.get_inputs()[0].name: arr.transpose(2, 0, 1)[None]})[0]
    mask = prediction[0, 0].astype(np.float32)
    low, high = float(mask.min()), float(mask.max())
    if not np.isfinite(mask).all() or high - low <= 1e-7:
        raise RuntimeError("Foreground model returned a constant or non-finite mask")
    mask = (mask - low) / (high - low)
    result = Image.fromarray(np.round(np.clip(mask, 0, 1) * 255).astype(np.uint8)).resize(image.size, Image.Resampling.LANCZOS)
    return result, {"model": path.stem, "provider": "CPUExecutionProvider", "threshold": 128,
                    "foregroundFraction": float((np.asarray(result) >= 128).mean()),
                    "outputType": "salient foreground alpha; includes person and potentially held props"}


def infer_depth(image, path, device):
    import numpy as np
    import torch
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation
    torch.set_num_threads(4)
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but unavailable")
    processor = AutoImageProcessor.from_pretrained(str(path), local_files_only=True)
    model = AutoModelForDepthEstimation.from_pretrained(str(path), local_files_only=True).to(device).eval()
    inputs = {key: val.to(device) for key, val in processor(images=image, return_tensors="pt").items()}
    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    start = time.perf_counter()
    with torch.inference_mode():
        prediction = model(**inputs).predicted_depth
        prediction = torch.nn.functional.interpolate(prediction[:, None], image.size[::-1], mode="bicubic", align_corners=False)[0, 0]
    if device == "cuda":
        torch.cuda.synchronize()
    arr = prediction.float().cpu().numpy()
    if not np.isfinite(arr).all():
        raise RuntimeError("Depth model returned non-finite values")
    low, high = float(arr.min()), float(arr.max())
    if high - low <= 1e-7:
        raise RuntimeError("Depth model returned constant depth")
    normalized = np.clip((arr - low) / (high - low), 0, 1)
    return normalized, {"model": "Depth-Anything-V2-Small-hf", "device": device,
                        "normalization": "min-max per image; relative inverse-depth; larger/brighter means nearer",
                        "rawMinimum": low, "rawMaximum": high, "inferenceSeconds": round(time.perf_counter() - start, 3),
                        "peakAllocatedMiB": round(torch.cuda.max_memory_allocated() / 1048576, 1) if device == "cuda" else None,
                        "realWorldUnits": None, "metricHeightMeasured": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--model-dir", default=ROOT / "models/garment-surface", type=Path)
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    parser.add_argument("--foreground-model", choices=["u2netp", "u2net", "u2net_human_seg"], default="u2netp")
    parser.add_argument("--max-edge", type=int, default=1600)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    # Inference must stay local, including Transformers config resolution.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    started = time.perf_counter()
    try:
        import numpy as np
        from PIL import Image, ImageOps
        if not 320 <= args.max_edge <= 4096:
            raise ValueError("max-edge must be 320..4096")
        image = ImageOps.exif_transpose(Image.open(args.input)).convert("RGB")
        original_size = image.size
        image.thumbnail((args.max_edge, args.max_edge), Image.Resampling.LANCZOS)
        foreground_path = args.model_dir / (args.foreground_model + ".onnx")
        depth_path = args.model_dir / "depth-anything-v2-small"
        for path in [foreground_path, depth_path / "model.safetensors", depth_path / "config.json", depth_path / "preprocessor_config.json"]:
            if not path.is_file():
                raise FileNotFoundError("Required local model missing: " + str(path))
        alpha, fg_info = infer_foreground(image, foreground_path)
        print("Foreground inference complete", flush=True)
        relative, depth_info = infer_depth(image, depth_path, args.device)
        alpha.save(args.output_dir / "foreground-mask.png")
        foreground = image.convert("RGBA")
        foreground.putalpha(alpha)
        foreground.save(args.output_dir / "foreground.png")
        # 16-bit data and 8-bit preview are explicitly different files.
        Image.fromarray(np.round(relative * 65535).astype(np.uint16)).save(args.output_dir / "relative-depth.png")
        Image.fromarray(np.round(relative * 255).astype(np.uint8)).save(args.output_dir / "relative-depth-preview.png")
        receipt = {"status": "completed", "semanticAI": True, "localInference": True, "imageUploaded": False,
                   "trainingPerformed": False, "sourceSha256": sha256(args.input), "originalSize": original_size,
                   "outputSize": image.size, "foreground": fg_info, "depth": depth_info,
                   "modelHashes": {foreground_path.name: sha256(foreground_path), "depthModel": sha256(depth_path / "model.safetensors")},
                   "totalSeconds": round(time.perf_counter() - started, 3),
                   "outputs": {"foreground": "foreground.png", "mask": "foreground-mask.png", "relativeDepth": "relative-depth.png", "depthPreview": "relative-depth-preview.png"},
                   "limitations": ["Foreground alpha is a model estimate; thin clothing edges/props can be missed and need correction.",
                                   "This is person/object foreground, not clothing-only segmentation or material identification.",
                                   "Single-image relative depth is not true fold height, complete 3D geometry, UV, or hidden-surface recovery.",
                                   "Depth may respond to body pose and broad surfaces; fine folds can be missed."]}
        (args.output_dir / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"status": "completed", "outputDir": str(args.output_dir), "seconds": receipt["totalSeconds"]}), flush=True)
    except Exception as exc:
        failure = {"status": "failed", "semanticAI": False, "imageUploaded": False, "error": str(exc),
                   "totalSeconds": round(time.perf_counter() - started, 3)}
        (args.output_dir / "failure.json").write_text(json.dumps(failure, ensure_ascii=False, indent=2), encoding="utf-8")
        print(str(exc), file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
