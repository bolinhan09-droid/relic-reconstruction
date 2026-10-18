"""Local DINOv2 semantic landmark proposals, never generative unwrapping.

Model features suggest visible matches. Similarity is not garment accuracy and
all proposals require human confirmation. Dependencies stay outside the desktop.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import time


def inside(x, y, vertices):
    result = False
    for index, (ax, ay) in enumerate(vertices):
        bx, by = vertices[index - 1]
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            result = not result
    return result


def suggest(source_path, target_path, model_dir, source_boundary, target_boundary):
    import numpy as np
    import torch
    from PIL import Image, ImageOps
    from transformers import Dinov2Model

    started = time.monotonic()
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    torch.set_num_threads(4)
    model = Dinov2Model.from_pretrained(model_dir, local_files_only=True, use_safetensors=True).eval().to(device)
    mean = torch.tensor([.485, .456, .406], device=device)[:, None, None]
    std = torch.tensor([.229, .224, .225], device=device)[:, None, None]

    def features(path, boundary):
        image = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
        xs, ys = [p['x'] for p in boundary], [p['y'] for p in boundary]
        left, top, right, bottom = min(xs), min(ys), max(xs), max(ys)
        box = (round(left * image.width), round(top * image.height), round(right * image.width), round(bottom * image.height))
        if min(box[2] - box[0], box[3] - box[1]) < 16:
            raise ValueError('Selected garment region is too small')
        crop = image.crop(box)
        factor = 518 / max(crop.size)
        scaled = crop.resize((max(1, round(crop.width * factor)), max(1, round(crop.height * factor))), Image.Resampling.BICUBIC)
        pad_x, pad_y = (518 - scaled.width) // 2, (518 - scaled.height) // 2
        patch = Image.new('RGB', (518, 518), 'white')
        patch.paste(scaled, (pad_x, pad_y))
        tensor = torch.from_numpy(np.asarray(patch).copy()).to(device=device, dtype=torch.float32).permute(2, 0, 1) / 255
        with torch.inference_mode():
            hidden = model(pixel_values=((tensor - mean) / std)[None]).last_hidden_state[0, 1:]
            hidden = torch.nn.functional.normalize(hidden.float(), dim=1)
        side = math.isqrt(hidden.shape[0])
        if side * side != hidden.shape[0]:
            raise ValueError('Unexpected DINO patch grid')
        coordinates, relative, keep = [], [], []
        vertices = [(p['x'], p['y']) for p in boundary]
        for row in range(side):
            for col in range(side):
                u, v = ((col + .5) * 14 - pad_x) / scaled.width, ((row + .5) * 14 - pad_y) / scaled.height
                x, y = left + u * (right - left), top + v * (bottom - top)
                if inside(x, y, vertices) and .03 < u < .97 and .03 < v < .97:
                    keep.append(row * side + col)
                    coordinates.append((x, y))
                    relative.append((u, v))
        return hidden[keep], torch.tensor(relative, dtype=torch.float32, device=device), coordinates

    a, a_relative, a_points = features(source_path, source_boundary)
    b, b_relative, b_points = features(target_path, target_boundary)
    if min(len(a), len(b)) < 10:
        raise ValueError('Too few visible feature patches in selected regions')
    # A modest upright-image prior suppresses left/right sleeve swaps. This is
    # explicitly an initialization assumption, not learned garment geometry.
    cosine = a @ b.T
    positional = (a_relative[:, None, :] - b_relative[None, :, :]).square().sum(dim=2)
    score = cosine - .12 * positional
    forward = score.argmax(dim=1)
    backward = score.argmax(dim=0)
    top = score.topk(2, dim=1).values
    candidates = []
    for i, target_index in enumerate(forward.tolist()):
        j = int(target_index)
        similarity = float(cosine[i, j].item())
        margin = float((top[i, 0] - top[i, 1]).item())
        displacement = float(positional[i, j].item())
        if int(backward[j].item()) == i and similarity >= .55 and margin >= .003 and displacement <= .40:
            candidates.append({'source': {'x': a_points[i][0], 'y': a_points[i][1]},
                               'target': {'x': b_points[j][0], 'y': b_points[j][1]},
                               'sourceRelative': a_relative[i].tolist(), 'targetRelative': b_relative[j].tolist(),
                               'cosineSimilarity': round(similarity, 5), 'distinctivenessMargin': round(margin, 5)})
    candidates.sort(key=lambda p: p['cosineSimilarity'] + min(.1, p['distinctivenessMargin']), reverse=True)
    spread = []
    for candidate in candidates:
        if all(math.dist(candidate['sourceRelative'], p['sourceRelative']) > .10
               and math.dist(candidate['targetRelative'], p['targetRelative']) > .10 for p in spread):
            spread.append(candidate)
        if len(spread) >= 28:
            break
    result = {'status': 'candidates' if len(spread) >= 3 else 'insufficient_matches',
              'method': 'dinov2_small_mutual_cosine_upright_prior_v1', 'candidates': spread,
              'requiresConfirmation': True, 'localInference': True, 'imageUploaded': False,
              'inferredHidden': False, 'physicalSimulation': False, 'accuracyMeasured': False,
              'quality': {'rawMutualMatches': len(candidates), 'spreadCandidates': len(spread),
                          'similarityMeaning': 'feature cosine similarity, not correspondence accuracy'},
              'model': {'name': 'facebook/dinov2-small', 'license': 'Apache-2.0',
                        'weightsSha256': hashlib.sha256((Path(model_dir) / 'model.safetensors').read_bytes()).hexdigest()},
              'elapsedSeconds': round(time.monotonic() - started, 3), 'device': device,
              'warnings': ['语义特征仅建议可见位置，编号需人工核对；重复纹样、纯色和叠穿可能错配。',
                           '算法假设两张照片均为正面朝上；无法恢复折叠遮挡处与背面。']}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    request = json.loads(args.request.read_text(encoding='utf-8'))
    value = suggest(request['sourcePath'], request['targetPath'], request['modelDir'],
                    request['sourceBoundary'], request['targetBoundary'])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'status': value['status'], 'candidates': len(value['candidates']), 'seconds': value['elapsedSeconds']}))


if __name__ == '__main__':
    main()
