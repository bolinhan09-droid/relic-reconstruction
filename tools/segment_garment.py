"""Offline prompted SAM 2.1 segmentation worker; never downloads model assets."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import time


def run(input_path, output_dir, model_dir, prompts, device='auto'):
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
    import numpy as np
    from PIL import Image, ImageOps
    import torch
    from transformers import Sam2Model, Sam2Processor

    begin = time.perf_counter()
    output_dir, model_dir = Path(output_dir), Path(model_dir)
    if not all((model_dir / name).is_file() for name in ('config.json', 'preprocessor_config.json', 'model.safetensors')):
        raise RuntimeError('SAM 2.1 model is missing; no placeholder mask was produced')
    image = ImageOps.exif_transpose(Image.open(input_path)).convert('RGB')
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
    if device not in {'cpu', 'cuda'}:
        raise ValueError('device must be auto, cpu, or cuda')
    if device == 'cpu':
        torch.set_num_threads(min(8, os.cpu_count() or 4))
    if device == 'cuda':
        torch.cuda.reset_peak_memory_stats()
    model = Sam2Model.from_pretrained(model_dir, local_files_only=True).eval().to(device)
    processor = Sam2Processor.from_pretrained(model_dir, local_files_only=True)
    options = {'images': image, 'return_tensors': 'pt'}
    points = prompts.get('points', [])
    if points:
        options['input_points'] = [[[[p['x'] * (image.width - 1), p['y'] * (image.height - 1)] for p in points]]]
        options['input_labels'] = [[[p['label'] for p in points]]]
    if prompts.get('box'):
        b = prompts['box']
        options['input_boxes'] = [[[b['x'] * image.width, b['y'] * image.height,
                                  (b['x'] + b['width']) * image.width, (b['y'] + b['height']) * image.height]]]
    if not points and not prompts.get('box'):
        raise ValueError('A positive point or box must identify the garment')
    inputs = processor(**options).to(device)
    with torch.inference_mode():
        outputs = model(**inputs, multimask_output=True)
    candidates = processor.post_process_masks(outputs.pred_masks.cpu(), inputs['original_sizes'].cpu())[0][0]
    scores = outputs.iou_scores.detach().float().cpu()[0][0]
    # Prefer masks respecting clicks, rather than pretending model scores are
    # measured garment correctness. The returned score is explicitly named.
    ranks = []
    for index, candidate in enumerate(candidates):
        mask = candidate.numpy().astype(bool)
        mismatch = sum(bool(mask[round(p['y'] * (image.height - 1)), round(p['x'] * (image.width - 1))]) != bool(p['label']) for p in points)
        ranks.append((mismatch, -float(scores[index]), index))
    mismatch, _, chosen = min(ranks)
    alpha = Image.fromarray(candidates[chosen].numpy().astype(np.uint8) * 255, 'L')
    if alpha.getbbox() is None:
        raise RuntimeError('SAM returned an empty region; refine the selection')
    output_dir.mkdir(parents=True, exist_ok=True)
    alpha.save(output_dir / 'mask.png')
    receipt = {'status': 'succeeded', 'model': 'facebook/sam2.1-hiera-tiny', 'localInference': True,
               'imageUploaded': False, 'device': device, 'elapsedSeconds': round(time.perf_counter() - begin, 3),
               'modelPredictedIoU': float(scores[chosen]), 'promptMismatches': mismatch,
               'qualityMeasuredAgainstGroundTruth': False, 'maskPixels': int(np.count_nonzero(np.asarray(alpha))),
               'peakCudaAllocatedMiB': round(torch.cuda.max_memory_allocated() / 2**20, 1) if device == 'cuda' else None}
    (output_dir / 'receipt.json').write_text(json.dumps(receipt, indent=2), encoding='utf8')
    print(json.dumps(receipt), flush=True)
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--prompts', required=True)
    parser.add_argument('--device', choices=['auto', 'cpu', 'cuda'], default='auto')
    args = parser.parse_args()
    run(args.input, args.output_dir, args.model_dir, json.loads(Path(args.prompts).read_text(encoding='utf8')), args.device)
