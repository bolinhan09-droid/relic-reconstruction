"""Visible-cloth correspondence proposals with a small, auditable interface.

The outline adapter works without a neural runtime. Optional local DINOv2
features suggest landmarks, and every accepted mesh is checked for folds.
Neither adapter identifies invisible cloth, real dimensions or garment identity.
"""
from __future__ import annotations

import hashlib
from itertools import combinations
import json
import math
import os
from pathlib import Path
import subprocess
import threading
import uuid

from fastapi import HTTPException

MODEL_LOCK = threading.BoundedSemaphore(1)


def configuration(core):
    options = core.read_json(core.DATA / 'runtime/correspondence-runtime.json', {})
    if not isinstance(options, dict):
        options = {}
    directory = Path(options.get('modelDir') or core.ROOT / 'models/dinov2-small').resolve()
    script = Path(options.get('scriptPath') or core.ROOT / 'tools/dino_garment_correspondence.py').resolve()
    python = options.get('pythonExecutable')
    if not python and Path('E:/lora-platform/.venv/Scripts/python.exe').is_file():
        python = 'E:/lora-platform/.venv/Scripts/python.exe'
    ready = bool(python and Path(python).is_file() and script.is_file()
                 and all((directory / name).is_file() for name in ('config.json', 'model.safetensors', 'download-manifest.json')))
    return {'available': ready, 'python': python, 'script': script, 'modelDir': directory}


def _valid_mesh(src, dst, mapping):
    try:
        triangles = mapping.triangulate(dst)
        if any(mapping.cross(src[a], src[b], src[c]) * mapping.cross(dst[a], dst[b], dst[c]) <= 1e-10
               for a, b, c in triangles):
            return False
        mapping.validate_mesh(src, triangles)
        mapping.validate_mesh(dst, triangles)
        return True
    except HTTPException:
        return False


def filter_semantic_candidates(candidates, mapping):
    """Reject crossed/clustered matches; never fabricate missing controls."""
    rows = []
    for row in candidates[:40]:
        try:
            s = mapping.points([row['source']], minimum=1)[0]
            t = mapping.points([row['target']], minimum=1)[0]
            # A semantic feature score does not locate a physical cloth point.
            # This coarse upright-panel prior rejects large cross-region jumps
            # before mesh checks; relaxed poses must use manually corrected points.
            if math.dist(row['sourceRelative'], row['targetRelative']) > .20:
                continue
        except (HTTPException, KeyError, TypeError):
            continue
        if not any(s == old[0] or t == old[1] for old in rows):
            rows.append((s, t, row))
    seed, area = None, 0.
    for group in combinations(rows[:18], 3):
        src, dst = [p[0] for p in group], [p[1] for p in group]
        candidate_area = min(abs(mapping.cross(*src)), abs(mapping.cross(*dst)))
        if candidate_area > area and _valid_mesh(src, dst, mapping):
            seed, area = list(group), candidate_area
    if seed is None:
        return None
    accepted = seed
    for row in rows:
        if row in accepted:
            continue
        trial = accepted + [row]
        if _valid_mesh([p[0] for p in trial], [p[1] for p in trial], mapping):
            accepted = trial
        if len(accepted) == 24:
            break
    def spread(axis):
        values = [p[axis] for p in accepted]
        return (max(p[0] for p in values) - min(p[0] for p in values)) * (max(p[1] for p in values) - min(p[1] for p in values))
    if len(accepted) < 6 or min(spread(0), spread(1)) < .008:
        return None
    return {'sourcePoints': [{'x': p[0][0], 'y': p[0][1]} for p in accepted],
            'targetPoints': [{'x': p[1][0], 'y': p[1][1]} for p in accepted],
            'pointScores': [p[2].get('cosineSimilarity') for p in accepted],
            'quality': {'geometricallyAcceptedCandidates': len(accepted),
                        'sourceBoundingAreaFraction': spread(0), 'targetBoundingAreaFraction': spread(1),
                        'accuracyMeasured': False}}


def _boundary(payload, key, mapping, core):
    boundary = payload.get(key)
    if boundary:
        parsed = mapping.points(boundary)
        mapping.validate_boundary(parsed)
        return [{'x': x, 'y': y} for x, y in parsed]
    if key == 'sourceBoundary' and payload.get('sourceBox'):
        box = core.rect(payload['sourceBox'])
        x, y, w, h = (box[name] for name in ('x', 'y', 'w', 'h'))
        return [{'x': x, 'y': y}, {'x': x + w, 'y': y}, {'x': x + w, 'y': y + h}, {'x': x, 'y': y + h}]
    return None


def create_suggestion(core, project, payload, mapping):
    from garment_shape_matching import suggest_correspondence
    mode = payload.get('sourceMode', 'brush')
    method = payload.get('method', 'auto')
    if method not in {'auto', 'shape', 'semantic'}:
        mapping.fail('对应方式须为 auto、shape 或 semantic')
    meta, original, _, _ = mapping.source_bundle(core, project, mode)
    # The editor retains its background. Matching can independently ignore it
    # using a verified model alpha; no background pixels are deleted from input.
    from surface_workflow import resolve_analysis
    analyzed = resolve_analysis(project)
    matching_mask = None
    if analyzed:
        from PIL import Image
        matching_mask = Image.open(analyzed[1] / 'foreground-mask.png').convert('L').resize(original.size, Image.Resampling.LANCZOS)
        original = Image.composite(original, Image.new('RGB', original.size, 'white'), matching_mask)
    if payload.get('sourceHash') != meta['sourceHash']:
        mapping.fail('来源图已改变，请重新打开衣片映射', 409)
    upload_id = core.safe_id(payload.get('targetUploadId'))
    target_path = core.DATA / 'uploads' / upload_id / 'image.png'
    if not target_path.is_file():
        mapping.fail('请上传一张真实平铺照后再建议对应点')
    target = core.load_rgb(target_path)
    source_boundary = _boundary(payload, 'sourceBoundary', mapping, core)
    target_boundary = _boundary(payload, 'targetBoundary', mapping, core)
    shape = suggest_correspondence(original, target, source_boundary, target_boundary, max_points=21)
    identifier = 'suggestion-' + uuid.uuid4().hex[:16]
    folder = core.DATA / 'projects' / project['id'] / 'mapping-suggestions' / identifier
    folder.mkdir(parents=True, exist_ok=True)
    value = {**shape, 'id': identifier, 'status': 'proposed' if shape['status'] == 'suggested' else 'needs_selection',
             'projectId': project['id'], 'projectRevision': project['revision'], 'sourceHash': meta['sourceHash'],
             'targetHash': mapping.digest(target_path), 'targetUploadId': upload_id,
             'sourceMode': mode, 'requiresConfirmation': True, 'createdAt': core.now(),
             'semanticAI': False, 'imageUploaded': False, 'quality': {'accuracyMeasured': False}}
    if analyzed:
        value['foregroundAnalysisId'] = analyzed[0]['id']
    config = configuration(core)
    # Explicit user-selected panels can still be feature matched when a shape
    # profile rejects their branching contour. Otherwise request selection.
    selected_source = source_boundary or shape.get('sourceBoundary')
    selected_target = target_boundary or shape.get('targetBoundary')
    # Overall placement is the requested first draft. A valid outline proposal
    # covers the panel more consistently than sparse DINO matches on plain cloth.
    # Neural proposals remain an explicit experiment or a fallback for branching
    # silhouettes; they never silently replace a usable whole-panel draft.
    attempt_semantic = method == 'semantic' or (method == 'auto' and shape['status'] != 'suggested')
    if attempt_semantic and config['available'] and selected_source and selected_target:
        if not MODEL_LOCK.acquire(blocking=False):
            value['warnings'].append('本机语义匹配正在执行，本次使用轮廓近似；稍后可以重新建议。')
        else:
            try:
                source_path = core.DATA / 'projects' / project['id'] / 'mapping-sources' / meta['tag'] / 'original.png'
                if matching_mask is not None:
                    original.save(folder / 'matching-source.png')
                    source_path = folder / 'matching-source.png'
                request = {'sourcePath': str(source_path), 'targetPath': str(target_path), 'modelDir': str(config['modelDir']),
                           'sourceBoundary': selected_source, 'targetBoundary': selected_target}
                core.write_json(folder / 'semantic-request.json', request)
                environment = os.environ.copy()
                environment.update(PYTHONUTF8='1', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
                with (folder / 'semantic.log').open('w', encoding='utf-8') as log:
                    process = subprocess.run([config['python'], str(config['script']), '--request', str(folder / 'semantic-request.json'),
                                              '--output', str(folder / 'semantic-result.json')], cwd=core.ROOT,
                                             env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=120,
                                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                if process.returncode:
                    raise RuntimeError('DINOv2本机特征匹配没有完成')
                raw = core.read_json(folder / 'semantic-result.json', {})
                filtered = filter_semantic_candidates(raw.get('candidates', []), mapping)
                value['semanticExperiment'] = {'status': raw.get('status'), 'quality': raw.get('quality'),
                                               'elapsedSeconds': raw.get('elapsedSeconds'), 'model': raw.get('model')}
                if filtered:
                    value.update(filtered, status='proposed', method='dinov2_mutual_visible_landmarks_v1', semanticAI=True,
                                 sourceBoundary=selected_source, targetBoundary=selected_target,
                                 warnings=raw.get('warnings', []) + ['仅覆盖候选点围成的区域。请补充衣片边缘及接缝位置后确认。'])
                else:
                    value['warnings'].append('语义候选不足或存在网格冲突，本次未采用；轮廓建议仍须人工核对。')
            except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError) as error:
                value['warnings'].append(str(error) + '；没有把失败结果当作已识别对应。')
            finally:
                MODEL_LOCK.release()
    elif method == 'semantic' and not config['available']:
        value['warnings'].append('尚未配置本机DINOv2运行环境；当前仅有轮廓近似。')
    if method == 'auto' and value['status'] == 'proposed' and not value['semanticAI']:
        value['warnings'].append('当前采用整体位置优先的轮廓比例初稿；请核对领口、缝线和衣摆，必要时拖点修正。')
    if value['status'] == 'needs_selection':
        value['reason'] = shape.get('reason', '请在两张图分别框选同一块连续可见衣片，再建议对应点。')
    if core.get_project(project['id'])['revision'] != project['revision']:
        mapping.fail('方案在匹配期间已变化，请保存后重新建议', 409)
    core.write_json(folder / 'receipt.json', value)
    value['receiptUrl'] = core.data_url(folder / 'receipt.json')
    return value
