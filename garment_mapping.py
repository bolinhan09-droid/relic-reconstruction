"""Local virtual try-off and explicit, auditable garment effect correspondence.

MGT generates appearance; it does not supply correspondence or real dimensions.
The separate piecewise-affine module transports existing alpha layers using
confirmed landmark pairs. Unsupported regions stay marked as inferred/unknown.
Only Pillow and the standard library are required by the desktop mapping core.
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import math
import os
import subprocess
import sys
import time
import uuid
import zipfile
from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, Response
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat

MAX_EDGE = 1600
MODEL_FILES = ('tryoffdiffv2_multi.pth', 'siglip/model.safetensors', 'vae/diffusion_pytorch_model.safetensors')


def fail(message, status=422):
    raise HTTPException(status, message)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def number(value, low=0., high=1.):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        fail('坐标和尺寸须为有效范围内的有限数值')
    return float(value)


def points(value, minimum=3, maximum=32):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        fail(f'请提供 {minimum}–{maximum} 个对应点')
    result = []
    for p in value:
        if not isinstance(p, dict) or set(p) != {'x', 'y'}:
            fail('对应点须包含 x、y 归一化坐标')
        result.append((number(p['x']), number(p['y'])))
    if len(set(result)) != len(result):
        fail('对应点不能重复')
    return result


def cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def segments_intersect(a, b, c, d):
    eps = 1e-10
    ca, cb, cc, cd = cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)
    if ca * cb < -eps and cc * cd < -eps:
        return True
    def on_segment(p, q, r):
        return (abs(cross(p, q, r)) <= eps and min(p[0], q[0]) - eps <= r[0] <= max(p[0], q[0]) + eps
                and min(p[1], q[1]) - eps <= r[1] <= max(p[1], q[1]) + eps)
    return on_segment(a, b, c) or on_segment(a, b, d) or on_segment(c, d, a) or on_segment(c, d, b)


def validate_mesh(vertices, triangles):
    edges = sorted({tuple(sorted((tri[i], tri[(i + 1) % 3]))) for tri in triangles for i in range(3)})
    for index, (a, b) in enumerate(edges):
        for c, d in edges[index + 1:]:
            shared = {a, b} & {c, d}
            if shared:
                common = next(iter(shared))
                other_a = b if a == common else a
                other_b = d if c == common else c
                origin, va, vb = vertices[common], vertices[other_a], vertices[other_b]
                if abs(cross(origin, va, vb)) <= 1e-10 and (va[0] - origin[0]) * (vb[0] - origin[0]) + (va[1] - origin[1]) * (vb[1] - origin[1]) > 1e-10:
                    fail('对应网格有重叠边，请重新确认点号或分区处理')
            elif segments_intersect(vertices[a], vertices[b], vertices[c], vertices[d]):
                fail('对应网格有全局交叉，请重新确认点号或分区处理')


def validate_boundary(vertices):
    area = abs(sum(p[0] * vertices[(i + 1) % len(vertices)][1] - vertices[(i + 1) % len(vertices)][0] * p[1] for i, p in enumerate(vertices))) / 2
    if area < 1e-8:
        fail('部件边界面积太小')
    for i in range(len(vertices)):
        for j in range(i + 2, len(vertices)):
            if i == 0 and j == len(vertices) - 1:
                continue
            if segments_intersect(vertices[i], vertices[(i + 1) % len(vertices)], vertices[j], vertices[(j + 1) % len(vertices)]):
                fail('部件边界不能自交')


def triangulate(vertices):
    """Bowyer-Watson incremental Delaunay triangulation of normalized controls."""
    original_count = len(vertices)
    vertices = list(vertices) + [(-16., -16.), (16., -16.), (0., 16.)]
    triangles = [(original_count, original_count + 1, original_count + 2)]
    for index in range(original_count):
        p = vertices[index]
        bad = []
        for tri in triangles:
            a, b, c = [vertices[i] for i in tri]
            ax, ay, bx, by, cx, cy = a[0] - p[0], a[1] - p[1], b[0] - p[0], b[1] - p[1], c[0] - p[0], c[1] - p[1]
            determinant = (ax * ax + ay * ay) * (bx * cy - by * cx) - (bx * bx + by * by) * (ax * cy - ay * cx) + (cx * cx + cy * cy) * (ax * by - ay * bx)
            if determinant * cross(a, b, c) > 1e-13:
                bad.append(tri)
        edges = {}
        for tri in bad:
            triangles.remove(tri)
            for a, b in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
                key = tuple(sorted((a, b)))
                edges[key] = edges.get(key, 0) + 1
        for (a, b), count in edges.items():
            if count == 1 and abs(cross(vertices[a], vertices[b], p)) > 1e-10:
                triangles.append((a, b, index) if cross(vertices[a], vertices[b], p) > 0 else (b, a, index))
    result = [t for t in triangles if max(t) < original_count]
    if not result:
        fail('对应点共线或区域太小，请沿衣物轮廓补点')
    used = {i for tri in result for i in tri}
    if len(used) != original_count:
        fail('有对应点过于接近或无法参与网格，请移动后重试')
    return result


def affine(destination, source):
    """Inverse coefficients for Pillow: output position -> input position."""
    (x0, y0), (x1, y1), (x2, y2) = destination
    den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if abs(den) < 1e-9:
        fail('网格中存在退化三角形，请重新布置对应点')
    coefficients = []
    for axis in (0, 1):
        u0, u1, u2 = [p[axis] for p in source]
        a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / den
        b = ((x1 - x0) * (u2 - u0) - (x2 - x0) * (u1 - u0)) / den
        coefficients.extend((a, b, u0 - a * x0 - b * y0))
    return tuple(coefficients)


def polygon_mask(vertices, size):
    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).polygon([(x * (size[0] - 1), y * (size[1] - 1)) for x, y in vertices], fill=255)
    return mask


def warp_layers(source, effect, src, dst, target_size, source_boundary=None, target_boundary=None):
    triangles = triangulate(dst)
    # A flipped triangle is an ambiguous overlapping chart, not a valid cloth map.
    if any(cross(src[a], src[b], src[c]) * cross(dst[a], dst[b], dst[c]) <= 1e-10 for a, b, c in triangles):
        fail('对应网格发生翻折／交叉。请核对点号，或把复杂部件分区映射')
    validate_mesh(src, triangles)
    validate_mesh(dst, triangles)
    sw, sh = source.size
    tw, th = target_size
    source_rgba, effect = source.convert('RGBA'), effect.convert('RGBA')
    allowed_source = polygon_mask(source_boundary, source.size) if source_boundary else Image.new('L', source.size, 255)
    allowed_target = polygon_mask(target_boundary, target_size) if target_boundary else Image.new('L', target_size, 255)
    source_rgba.putalpha(allowed_source)
    effect.putalpha(ImageChops.multiply(effect.getchannel('A'), allowed_source))
    mapped_original = Image.new('RGBA', target_size)
    mapped_effect = Image.new('RGBA', target_size)
    coverage = Image.new('L', target_size, 0)
    seen_source = Image.new('L', source.size, 0)
    draw_seen = ImageDraw.Draw(seen_source)
    for tri in triangles:
        source_tri = [(src[i][0] * (sw - 1), src[i][1] * (sh - 1)) for i in tri]
        target_tri = [(dst[i][0] * (tw - 1), dst[i][1] * (th - 1)) for i in tri]
        left = max(0, math.floor(min(p[0] for p in target_tri)))
        top = max(0, math.floor(min(p[1] for p in target_tri)))
        right = min(tw, math.ceil(max(p[0] for p in target_tri)) + 1)
        bottom = min(th, math.ceil(max(p[1] for p in target_tri)) + 1)
        if right <= left or bottom <= top:
            continue
        local_tri = [(x - left, y - top) for x, y in target_tri]
        coeffs = affine(local_tri, source_tri)
        size = (right - left, bottom - top)
        tri_mask = Image.new('L', size)
        ImageDraw.Draw(tri_mask).polygon(local_tri, fill=255)
        src_mask = allowed_source.transform(size, Image.Transform.AFFINE, coeffs, Image.Resampling.NEAREST)
        tri_mask = ImageChops.multiply(tri_mask, src_mask)
        tri_mask = ImageChops.multiply(tri_mask, allowed_target.crop((left, top, right, bottom)))
        for image, output in ((source_rgba, mapped_original), (effect, mapped_effect)):
            # Premultiplied RGBA avoids dark halos around semi-transparent dots.
            a, b, c, d, e, f = coeffs
            if (abs(a - 1) + abs(b) + abs(d) + abs(e - 1) < 1e-8
                    and abs(c - round(c)) + abs(f - round(f)) < 1e-7):
                patch = image.crop((round(c), round(f), round(c) + size[0], round(f) + size[1]))
            else:
                patch = image.convert('RGBa').transform(size, Image.Transform.AFFINE, coeffs, Image.Resampling.BICUBIC).convert('RGBA')
            output.paste(patch, (left, top), tri_mask)
        coverage.paste(255, (left, top), tri_mask)
        draw_seen.polygon(source_tri, fill=255)
    seen_source = ImageChops.multiply(seen_source, allowed_source)
    total = ImageStat.Stat(effect.getchannel('A')).sum[0]
    represented = ImageStat.Stat(ImageChops.multiply(effect.getchannel('A'), seen_source)).sum[0]
    return mapped_original, mapped_effect, coverage, triangles, (represented / total if total else None)


def model_configuration(core):
    settings = core.read_json(core.DATA / 'runtime' / 'flatlay-runtime.json', {})
    if not isinstance(settings, dict):
        settings = {}
    model_dir = Path(settings.get('modelDir') or os.environ.get('RELIC_FLATLAY_MODELS') or core.ROOT / 'models' / 'tryoffdiff').resolve()
    candidates = [settings.get('pythonExecutable'), os.environ.get('RELIC_FLATLAY_PYTHON'),
                  str(core.ROOT / '.model-runtime' / 'Scripts' / 'python.exe')]
    # Existing local installation on this workstation; never taken from an HTTP request.
    if Path('E:/lora-platform/.venv/Scripts/python.exe').is_file():
        candidates.append('E:/lora-platform/.venv/Scripts/python.exe')
    python = next((str(Path(p).resolve()) for p in candidates if p and Path(p).is_file()), None)
    script = Path(settings.get('scriptPath') or core.ROOT / 'tools' / 'flatlay_model_experiment.py').resolve()
    missing = [name for name in MODEL_FILES if not (model_dir / name).is_file()]
    validation = core.read_json(model_dir / 'local-validation.json', {})
    verified = isinstance(validation, dict) and validation.get('semanticAI') is True and validation.get('status') == 'succeeded'
    ready = bool(python and script.is_file() and not missing and verified)
    return {'python': python, 'modelDir': model_dir, 'script': script, 'available': ready,
            'reason': '本机预训练模型已完成推理验证' if ready else '本机模型仍在下载／验证；可先上传平铺图完成对应映射',
            'missing': missing, 'qualityWarning': validation.get('qualityWarning', '复杂披风、叠穿与真实尺寸尚未验证') if isinstance(validation, dict) else ''}


def source_bundle(core, project, mode='brush'):
    import brush_workflow as brush
    if mode not in {'brush', 'approved'}:
        fail('来源须为 brush 或 approved')
    project_id = core.safe_id(project['id'])
    snapshot = project
    original_path = core.local_image(project)
    warnings = []
    source_kind = 'recorded_brush_layer' if project.get('brushStrokes') else 'baked_photo'
    if not project.get('brushStrokes'):
        reference = project.get('reference') or {}
        job_id = reference.get('jobId') if isinstance(reference, dict) else None
        if job_id:
            folder = core.DATA / 'jobs' / core.safe_id(job_id)
            old = core.read_json(folder / 'project-snapshot.json', {})
            verified_reference = False
            if (folder / 'result.png').is_file():
                actual_reference = core.load_rgb(original_path)
                previous_result = core.load_rgb(folder / 'result.png')
                verified_reference = actual_reference.size == previous_result.size and actual_reference.tobytes() == previous_result.tobytes()
            if verified_reference and isinstance(old, dict) and old.get('brushStrokes') and (folder / 'original.png').is_file():
                snapshot, original_path, source_kind = old, folder / 'original.png', 'recovered_brush_snapshot'
            elif isinstance(old, dict) and old.get('brushStrokes'):
                warnings.append('当前照片与所引用精修结果不一致，未套用旧笔触；请重新载入对应方案')
    original = core.load_rgb(original_path)
    if snapshot.get('brushStrokes'):
        _, paint = brush._raster(snapshot, original.size, with_paint=True, source=original)
        guide = original.convert('RGBA')
        guide.alpha_composite(paint)
        guide = guide.convert('RGB')
    else:
        paint = Image.new('RGBA', original.size)
        guide = original.copy()
        warnings.append('该照片未带独立笔触记录；可迁移整张可见纹理，但不能声称已准确分离照片中原有血迹')
    if mode == 'approved':
        try:
            job = core.current_generation(project)
        except (AttributeError, HTTPException):
            job = None
        if job and (core.DATA / 'jobs' / job['id'] / 'result.png').is_file():
            approved = core.load_rgb(core.DATA / 'jobs' / job['id'] / 'result.png')
        elif (project.get('reference') or {}).get('generated'):
            approved = core.load_rgb(core.local_image(project))
        else:
            fail('没有已采用的精修图；请选择可编辑笔触来源')
        if approved.size != original.size:
            fail('精修图尺寸发生变化，请先重新对齐，不能直接沿用原图坐标')
        if paint.getchannel('A').getbbox():
            # This is a masked edited patch, explicitly labelled; not semantic separation.
            alpha = paint.getchannel('A').point(lambda n: 255 if n else 0)
            paint = approved.convert('RGBA')
            paint.putalpha(alpha)
            guide, source_kind = approved, 'approved_patch_with_recorded_support'
            warnings.append('精修来源按已记录笔触范围提取图像补丁，补丁包含原织纹；不是自动分离真实血液材质')
        else:
            guide, original, source_kind = approved, approved, 'baked_approved_photo'
    file_hash = digest(original_path)
    content_hash = hashlib.sha256(file_hash.encode() + original.tobytes() + guide.tobytes() + paint.tobytes()).hexdigest()
    value = {'projectRevision': project['revision'], 'sourceRevision': snapshot.get('revision', project['revision']),
             'sourceHash': content_hash, 'sourceFileHash': file_hash, 'sourceKind': source_kind, 'sourceMode': mode,
             'width': original.width, 'height': original.height, 'warnings': warnings}
    tag = hashlib.sha256((str(project['revision']) + mode + content_hash).encode()).hexdigest()[:16]
    folder = core.DATA / 'projects' / project_id / 'mapping-sources' / tag
    folder.mkdir(parents=True, exist_ok=True)
    for name, image in [('original.png', original), ('guide.png', guide), ('effects.png', paint)]:
        if not (folder / name).is_file():
            image.save(folder / name)
    value.update(sourceOriginalUrl=core.data_url(folder / 'original.png'), sourceGuideUrl=core.data_url(folder / 'guide.png'),
                 effectLayerUrl=core.data_url(folder / 'effects.png'), tag=tag)
    return value, original, guide, paint


def checked_project(core, project_id, payload):
    project = core.get_project(project_id)
    revision = payload.get('revision', payload.get('projectRevision'))
    if isinstance(revision, bool) or revision != project['revision']:
        fail('方案已变化，请保存后重新载入映射来源', 409)
    return project


def _model_worker(core, folder, source_path, settings, record, project_id):
    record.update(status='running', updatedAt=core.now(), message='本机模型正在推理')
    core.write_json(folder / 'job.json', record)
    try:
        environment = os.environ.copy()
        environment.update(PYTHONUTF8='1', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
        command = [settings['python'], str(settings['script']), '--input', str(source_path), '--output-dir', str(folder / 'model-output'),
                   '--model-dir', str(settings['modelDir']), '--category', record['category'], '--steps', '30', '--seed', '42']
        with (folder / 'model.log').open('w', encoding='utf-8') as log:
            process = subprocess.run(command, cwd=core.ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
        output = folder / 'model-output' / 'flatlay.png'
        receipt = core.read_json(folder / 'model-output' / 'receipt.json', {})
        if process.returncode != 0 or not output.is_file() or not receipt.get('semanticAI'):
            raise RuntimeError('本机平铺模型未成功输出；请查看模型实验记录，未使用几何图片替代 AI 结果')
        core.load_rgb(output)
        stale = core.get_project(project_id)['revision'] != record['projectRevision']
        record.update(status='succeeded', resultUrl=core.data_url(output), outputUrl=core.data_url(output),
                      receiptUrl=core.data_url(folder / 'model-output' / 'receipt.json'), stale=stale,
                      semanticAI=True, exactGeometry=False, inferredHidden=True,
                      message='平铺外观已生成；遮挡与背面为推测，需确认对应点后迁移痕迹')
    except Exception as exc:
        record.update(status='failed', error=str(exc)[:600], message='本机平铺未完成；没有产生替代结果')
    record.update(updatedAt=core.now())
    core.write_json(folder / 'job.json', record)


def create_mapping(core, project, payload):
    src, dst = points(payload.get('sourcePoints')), points(payload.get('targetPoints'))
    if len(src) != len(dst):
        fail('源图与目标图的对应点数量须相同')
    source_meta, original, guide, effect = source_bundle(core, project, payload.get('sourceMode', 'brush'))
    if payload.get('sourceHash') and payload['sourceHash'] != source_meta['sourceHash']:
        fail('原图文件已经改变，请重新载入再确认对应点', 409)
    flatlay_id, upload_id = payload.get('flatlayJobId'), payload.get('targetUploadId')
    if bool(flatlay_id) == bool(upload_id):
        fail('请选择一张已上传平铺图或一个本机平铺结果')
    ai_inferred = False
    hidden_effect_candidate = False
    if flatlay_id:
        record = core.read_json(core.DATA / 'flatlay-jobs' / core.safe_id(flatlay_id) / 'job.json', {})
        if record.get('projectId') != project['id'] or record.get('projectRevision') != project['revision'] or record.get('status') != 'succeeded':
            fail('模型结果不属于当前方案版本，请重新载入')
        if record.get('sourceHash') != source_meta['sourceHash']:
            fail('平铺结果与当前原图不匹配，请重新生成或上传实物平铺图', 409)
        target_path = core.DATA / 'flatlay-jobs' / core.safe_id(flatlay_id) / 'model-output' / 'flatlay.png'
        ai_inferred = True
        hidden_effect_candidate = record.get('inputContainsEffects') is True
    else:
        target_path = core.DATA / 'uploads' / core.safe_id(upload_id) / 'image.png'
        if not target_path.is_file():
            fail('平铺图片不存在，请重新上传')
    target = core.load_rgb(target_path)
    suggestion_meta = None
    if payload.get('suggestionId'):
        suggestion_meta = core.read_json(core.DATA / 'projects' / core.safe_id(project['id']) / 'mapping-suggestions' /
                                         core.safe_id(payload['suggestionId']) / 'receipt.json', {})
        if (suggestion_meta.get('projectId') != project['id'] or suggestion_meta.get('projectRevision') != project['revision']
                or suggestion_meta.get('sourceHash') != source_meta['sourceHash']
                or suggestion_meta.get('targetHash') != digest(target_path) or suggestion_meta.get('status') != 'proposed'):
            fail('建议点与当前两张图或版本不一致，请重新建议', 409)
    source_boundary = points(payload['sourceBoundary']) if payload.get('sourceBoundary') else None
    target_boundary = points(payload['targetBoundary']) if payload.get('targetBoundary') else None
    for boundary in (source_boundary, target_boundary):
        if boundary:
            validate_boundary(boundary)
    # Bound memory and CPU work, preserving normalized controls across resize.
    original.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)
    effect = effect.resize(original.size, Image.Resampling.LANCZOS)
    target.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)
    warped, layer, coverage, triangles, retained = warp_layers(original, effect, src, dst, target.size, source_boundary, target_boundary)
    if target_boundary:
        target_mask = polygon_mask(target_boundary, target.size)
        target_mask_kind = 'user_outline'
    else:
        # A transparent estimate is useful for diagnostics, never textile segmentation.
        border = target.getpixel((0, 0))
        background = Image.new('RGB', target.size, border)
        difference = ImageChops.difference(target, background)
        channels = difference.split()
        target_mask = ImageChops.lighter(ImageChops.lighter(channels[0], channels[1]), channels[2]).point(lambda x: 255 if x > 25 else 0)
        if ImageStat.Stat(target_mask).sum[0] < target.width * target.height * 255 * .01:
            target_mask = Image.new('L', target.size, 255)
            target_mask_kind = 'entire_image_fallback_includes_background'
        else:
            target_mask = ImageChops.lighter(target_mask.filter(ImageFilter.MaxFilter(5)), coverage)
            target_mask_kind = 'background_difference_estimate'
    unknown = ImageChops.subtract(target_mask, coverage)
    result = target.convert('RGBA')
    if hidden_effect_candidate:
        # Preserve observed geometry/texture rather than trusting the diffusion
        # model to reproduce existing marks. Outside it is an unverified proposal.
        result.paste(warped, (0, 0), coverage)
    result.alpha_composite(layer)
    baked = source_meta['sourceKind'].startswith('baked')
    if baked:
        # Embedded marks are transported with visible pixels; never claimed as a separated stain layer.
        result.paste(warped, (0, 0), coverage)
    diagnostic = result.copy()
    amber = Image.new('RGBA', target.size, (235, 171, 54, 0))
    amber.putalpha(unknown.point(lambda x: 95 if x else 0))
    diagnostic.alpha_composite(amber)
    mesh = target.copy()
    draw = ImageDraw.Draw(mesh)
    for tri in triangles:
        poly = [(dst[i][0] * (target.width - 1), dst[i][1] * (target.height - 1)) for i in tri]
        draw.line(poly + [poly[0]], fill='#229a83', width=2)
    for index, (x, y) in enumerate(dst, 1):
        pos = (x * (target.width - 1), y * (target.height - 1))
        draw.ellipse((pos[0] - 4, pos[1] - 4, pos[0] + 4, pos[1] + 4), fill='#ffffff', outline='#183a30')
        draw.text((pos[0] + 6, pos[1] + 3), str(index), fill='#127a61')
    width_cm = payload.get('physicalWidthCm')
    if width_cm is not None:
        width_cm = number(width_cm, .1, 1000.)
        if ai_inferred:
            fail('AI 生成平铺图没有实测尺度。请上传真实平铺照片并校准后再填写实物宽度')
    identifier = 'mapping-' + uuid.uuid4().hex[:16]
    folder = core.DATA / 'projects' / core.safe_id(project['id']) / 'mappings' / identifier
    folder.mkdir(parents=True, exist_ok=True)
    assets = {'target.png': target, 'mapped-original.png': warped, 'mapped-effects.png': layer,
              'mapped-result.png': result.convert('RGB'), 'coverage.png': coverage,
              'unknown-mask.png': unknown, 'uncertainty.png': diagnostic.convert('RGB'), 'mesh.png': mesh}
    for name, image in assets.items():
        image.save(folder / name)
    mask_total = ImageStat.Stat(target_mask).sum[0]
    unknown_total = ImageStat.Stat(unknown).sum[0]
    warnings = list(source_meta['warnings'])
    if retained is not None and retained < .995:
        warnings.append('部分笔触位于对应网格之外，未自动搬移。请补对应点／分件范围后重新映射')
    if ai_inferred:
        warnings.append('目标平铺形态、被遮挡的布料与背面均由模型推测；已确认痕迹通过独立几何图层迁移')
    if unknown_total:
        warnings.append('黄色区没有经过源图对应验证；本版不把该区的隐藏痕迹续接说成已还原')
    if target_mask_kind != 'user_outline':
        warnings.append('未知区域范围使用背景差分估计，请用目标部件边界进一步限定')
    receipt = {'id': identifier, 'projectId': project['id'], 'projectRevision': project['revision'],
               'source': source_meta, 'targetHash': digest(target_path), 'componentName': str(payload.get('componentName') or '当前部件')[:100],
               'algorithm': 'confirmed_landmark_piecewise_affine_delaunay_v1', 'semanticAI': ai_inferred,
               'mappingIsLearned': False, 'physicalSimulation': False, 'manufacturingVerified': False,
               'inferredHidden': ai_inferred, 'hiddenDamageCompletionAttempted': hidden_effect_candidate,
               'hiddenDamageCompletionVerified': False,
               'layerMode': 'embedded_visible_pixels' if baked else 'recorded_alpha_layer',
               'sourcePoints': payload['sourcePoints'], 'targetPoints': payload['targetPoints'],
               'triangles': triangles, 'targetSize': list(target.size), 'physicalWidthCm': width_cm,
               'sourceBoundary': payload.get('sourceBoundary'), 'targetBoundary': payload.get('targetBoundary'),
               'targetMaskKind': target_mask_kind, 'createdAt': core.now(), 'warnings': warnings,
               'metrics': {'sourcePaintCoveredFraction': retained, 'unknownTargetFraction': unknown_total / mask_total if mask_total else None,
                           'controlPoints': len(src), 'triangles': len(triangles), 'realGarmentAccuracyMeasured': False}}
    if suggestion_meta:
        receipt['initialization'] = {'suggestionId': suggestion_meta['id'], 'method': suggestion_meta['method'],
                                     'userConfirmed': True, 'accuracyMeasured': False,
                                     'pointsEditedAfterSuggestion': suggestion_meta.get('sourcePoints') != payload['sourcePoints']
                                         or suggestion_meta.get('targetPoints') != payload['targetPoints']}
    core.write_json(folder / 'receipt.json', receipt)
    with zipfile.ZipFile(folder / 'mapping-package.zip', 'w', zipfile.ZIP_DEFLATED) as package:
        for name in (*assets, 'receipt.json'):
            package.write(folder / name, name)
        package.writestr('READ-ME.txt', ('服装痕迹映射实验包\n对应点为用户确认，网格内迁移不等于真实布料物理展开。\n黄色区域为无对应依据区；AI 补全是设计候选，不是实测事实。\n' + '\n'.join(warnings)).encode('utf-8'))
    return {**receipt, 'resultUrl': core.data_url(folder / 'mapped-result.png'),
            'originalWarpUrl': core.data_url(folder / 'mapped-original.png'), 'effectLayerUrl': core.data_url(folder / 'mapped-effects.png'),
            'coverageUrl': core.data_url(folder / 'coverage.png'), 'uncertaintyUrl': core.data_url(folder / 'uncertainty.png'),
            'unknownMaskUrl': core.data_url(folder / 'unknown-mask.png'), 'meshUrl': core.data_url(folder / 'mesh.png'),
            'receiptUrl': core.data_url(folder / 'receipt.json'), 'exportUrl': core.data_url(folder / 'mapping-package.zip')}


def register_mapping_routes(app, core):
    @app.get('/api/flatlay/capabilities')
    def capabilities():
        config = model_configuration(core)
        return {key: config[key] for key in ('available', 'reason', 'qualityWarning')} | {
            'model': 'MGT / TryOffDiff v2 pretrained', 'provider': 'local_tryoffdiff', 'apiRequestRequired': False,
            'geometryAlgorithm': 'confirmed_landmark_piecewise_affine', 'semanticAI': True,
            'automaticDenseCorrespondence': False, 'hiddenDamageCompletion': 'unverified_model_candidate'}

    @app.get('/api/projects/{project_id}/mapping-source')
    def mapping_source(project_id: str, sourceMode: str = 'brush'):
        with core.LOCK:
            value = source_bundle(core, core.get_project(project_id), sourceMode)[0]
        return value

    @app.post('/api/projects/{project_id}/mapping-suggestions')
    def mapping_suggestions(request: Request, project_id: str, payload: dict):
        core.require_local_origin(request)
        import garment_correspondence
        with core.LOCK:
            project = copy.deepcopy(checked_project(core, project_id, payload))
        return garment_correspondence.create_suggestion(core, project, payload, sys.modules[__name__])

    @app.post('/api/projects/{project_id}/flatlay-jobs')
    def flatlay_job(request: Request, project_id: str, payload: dict):
        core.require_local_origin(request)
        with core.LOCK:
            project = checked_project(core, project_id, payload)
            config = model_configuration(core)
            if not config['available']:
                fail(config['reason'])
            category = payload.get('category', 'upper')
            if category not in {'upper', 'lower', 'dress'}:
                fail('平铺模型类别须为 upper、lower 或 dress')
            active_jobs = [core.read_json(path, {}) for path in (core.DATA / 'flatlay-jobs').glob('*/job.json')]
            if any(isinstance(job, dict) and job.get('status') in {'queued', 'running'} for job in active_jobs):
                fail('已有本机平铺任务正在执行，请等待完成后再提交', 409)
            meta, original, guide, _ = source_bundle(core, project, payload.get('sourceMode', 'brush'))
            include_effects = payload.get('includeEffects', False)
            if not isinstance(include_effects, bool):
                fail('痕迹补全选项须为勾选状态')
            if include_effects:
                original = guide
            identifier = 'flatlay-' + uuid.uuid4().hex[:16]
            folder = core.DATA / 'flatlay-jobs' / identifier
            folder.mkdir(parents=True, exist_ok=True)
            box = payload.get('sourceBox')
            if box:
                r = core.rect(box)
                original = original.crop((round(r['x'] * original.width), round(r['y'] * original.height),
                                          round((r['x'] + r['w']) * original.width), round((r['y'] + r['h']) * original.height)))
            if payload.get('sourceBoundary'):
                if box:
                    fail('请使用矩形裁剪或部件多边形其中一种')
                boundary = points(payload['sourceBoundary'])
                validate_boundary(boundary)
                mask = polygon_mask(boundary, original.size)
                original = Image.composite(original, Image.new('RGB', original.size, 'white'), mask)
            original.save(folder / 'input.png')
            record = {'id': identifier, 'projectId': project_id, 'projectRevision': project['revision'],
                      'sourceHash': meta['sourceHash'], 'category': category, 'status': 'queued',
                      'model': 'MGT / TryOffDiff v2 pretrained', 'provider': 'local_tryoffdiff',
                      'inputContainsEffects': include_effects,
                      'sourceBox': payload.get('sourceBox'), 'sourceBoundary': payload.get('sourceBoundary'),
                      'semanticAI': False, 'inferredHidden': False, 'createdAt': core.now(), 'updatedAt': core.now()}
            core.write_json(folder / 'job.json', record)
            try:
                core.EXECUTOR.submit(_model_worker, core, folder, folder / 'input.png', config, record, project_id)
            except Exception:
                record.update(status='failed', message='本机模型任务未能启动，未执行生成', updatedAt=core.now())
                core.write_json(folder / 'job.json', record)
            return record

    @app.get('/api/flatlay-jobs/{job_id}')
    def read_flatlay_job(job_id: str):
        record = core.read_json(core.DATA / 'flatlay-jobs' / core.safe_id(job_id) / 'job.json')
        if not record:
            fail('平铺任务不存在', 404)
        return record

    @app.post('/api/projects/{project_id}/mappings')
    def mapping(request: Request, project_id: str, payload: dict):
        core.require_local_origin(request)
        with core.LOCK:
            project = checked_project(core, project_id, payload)
            return create_mapping(core, project, payload)

    @app.on_event('startup')
    def interrupted_flatlay_jobs():
        for path in (core.DATA / 'flatlay-jobs').glob('*/job.json'):
            record = core.read_json(path, {})
            if record.get('status') in {'queued', 'running'}:
                record.update(status='interrupted', message='程序重启中断本机平铺任务，可以重新生成', updatedAt=core.now())
                core.write_json(path, record)
