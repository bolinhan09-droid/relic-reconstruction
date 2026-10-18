"""Local foreground/depth jobs and deterministic cached photo-surface fields.

Photograph bytes are immutable. Background visibility is a view preference;
only the pigment layer is displaced. No metric fold heights are inferred here.
"""
from __future__ import annotations

from functools import lru_cache
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import uuid

from fastapi import HTTPException, Request
from PIL import Image, ImageChops
import runtime_paths


def validate_options(project):
    value = project.get('surfaceOptions')
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - {'version', 'analysisId', 'enabled', 'strength', 'backgroundVisible'}:
        raise HTTPException(422, '表面贴合设置格式无效')
    if value.get('version', 1) != 1 or isinstance(value.get('version'), bool):
        raise HTTPException(422, '表面贴合设置版本无效')
    strength = value.get('strength', .55)
    if isinstance(strength, bool) or not isinstance(strength, (int, float)) or not math.isfinite(strength) or not 0 <= strength <= 1:
        raise HTTPException(422, '表面贴合强度须在0到1之间')
    enabled, visible = value.get('enabled', False), value.get('backgroundVisible', True)
    if not isinstance(enabled, bool) or not isinstance(visible, bool):
        raise HTTPException(422, '表面开关须为勾选状态')
    analysis = value.get('analysisId')
    if analysis is not None and (not isinstance(analysis, str) or not analysis.startswith('surface-')
                                 or len(analysis) > 70 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in analysis)):
        raise HTTPException(422, '表面分析编号无效')
    if enabled and not analysis:
        raise HTTPException(422, '请先完成当前照片的表面分析，再开启褶皱贴合')
    return {'version': 1, 'analysisId': analysis, 'enabled': enabled, 'strength': float(strength), 'backgroundVisible': visible}


def image_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def options_for_generation(project):
    result = dict(project)
    if isinstance(result.get('surfaceOptions'), dict):
        result['surfaceOptions'] = {k: v for k, v in result['surfaceOptions'].items() if k != 'backgroundVisible'}
    return result


def _source_url(project):
    reference = project.get('reference') or {}
    return reference.get('url') if isinstance(reference, dict) else None


def resolve_analysis(project, strict=False):
    options = validate_options(project)
    if not options or not options.get('analysisId'):
        return None
    folder = runtime_paths.data_root() / 'surface-jobs' / options['analysisId']
    try:
        record = json.loads((folder / 'job.json').read_text(encoding='utf8'))
        expected_url = _source_url(project)
        if (record.get('status') != 'succeeded' or expected_url != record.get('sourceUrl')
                or not (folder / 'field.json').is_file() or not (folder / 'foreground-mask.png').is_file()):
            raise ValueError('表面分析与当前照片不一致')
        # Resolve only the trusted snapshot path written by this module. The
        # project cannot supply a filesystem path or executable through the API.
        path = Path(record['sourcePath'])
        if image_hash(path) != record.get('sourceHash'):
            raise ValueError('照片文件已经改变，请重新分析表面')
        return record, folder
    except (OSError, ValueError, KeyError, TypeError):
        if strict:
            raise HTTPException(422, '当前照片的表面分析无效或已变化，请重新分析') from None
        return None


@lru_cache(maxsize=8)
def _field(path, modified, size):
    from cloth_surface import field_from_payload
    return field_from_payload(json.loads(Path(path).read_text(encoding='utf8')))


def render_surface(project, mask, layer):
    options = validate_options(project)
    if not options or not options['enabled']:
        return mask, layer
    resolved = resolve_analysis(project, strict=True)
    record, folder = resolved
    path = folder / 'field.json'
    try:
        field = _field(str(path), path.stat().st_mtime_ns, path.stat().st_size)
        full_alpha = Image.open(folder / 'foreground-mask.png').convert('L').resize(mask.size, Image.Resampling.LANCZOS)
    except (OSError, ValueError):
        raise HTTPException(422, '表面分析缓存缺失或损坏，请重新分析') from None
    from cloth_surface import apply_surface
    # Mask support follows exactly the same geometry as pigment. Erased areas
    # are already gone; caller reapplies protected rectangles after displacement.
    permission = Image.new('RGBA', mask.size, (255, 255, 255, 0))
    permission.putalpha(mask)
    moved = apply_surface(permission, field, strength=options['strength'], shade=0, mask_only=True, clip_foreground=False)
    mask = ImageChops.multiply(moved.getchannel('A'), full_alpha).point(lambda n: 255 if n else 0)
    if layer is not None:
        layer = apply_surface(layer, field, strength=options['strength'], shade=.35, clip_foreground=False)
        layer.putalpha(ImageChops.multiply(layer.getchannel('A'), full_alpha))
    return mask, layer


def configuration(core):
    settings = core.read_json(core.DATA / 'runtime/surface-runtime.json', {})
    settings = settings if isinstance(settings, dict) else {}
    model_dir = Path(settings.get('modelDir') or core.ROOT / 'models/garment-surface').resolve()
    script = Path(settings.get('scriptPath') or core.ROOT / 'tools/analyze_garment_surface.py').resolve()
    python = settings.get('pythonExecutable')
    if not python and Path('E:/lora-platform/.venv/Scripts/python.exe').is_file():
        python = 'E:/lora-platform/.venv/Scripts/python.exe'
    validation = core.read_json(model_dir / 'local-validation.json', {})
    foreground = validation.get('foregroundModel', 'u2netp')
    if foreground not in {'u2netp', 'u2net', 'u2net_human_seg'}:
        foreground = 'u2netp'
    ready = bool(python and Path(python).is_file() and script.is_file()
                 and all((model_dir / p).is_file() for p in (foreground + '.onnx',
                     'depth-anything-v2-small/model.safetensors', 'depth-anything-v2-small/config.json',
                     'depth-anything-v2-small/preprocessor_config.json')))
    return {'available': ready, 'python': python, 'script': script, 'modelDir': model_dir,
            'foregroundModel': foreground, 'validated': validation.get('status') == 'succeeded',
            'reason': ('本机前景与相对深度模型已验证' if validation.get('status') == 'succeeded'
                       else '已找到本机模型；首次分析将实际验证运行条件') if ready else '本机表面模型尚未完整安装；原照片仍可正常绘制'}


def _worker(core, folder, record, config):
    record.update(status='running', message='本机正在提取主体并估计相对深度', updatedAt=core.now())
    core.write_json(folder / 'job.json', record)
    try:
        environment = os.environ.copy()
        environment.update(PYTHONUTF8='1', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
        with (folder / 'model.log').open('w', encoding='utf8') as log:
            process = subprocess.run([config['python'], str(config['script']), '--input', str(folder / 'input.png'),
                '--output-dir', str(folder / 'model-output'), '--model-dir', str(config['modelDir']),
                '--foreground-model', config['foregroundModel']], cwd=core.ROOT, env=environment,
                stdout=log, stderr=subprocess.STDOUT, timeout=240, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        result = folder / 'model-output'
        receipt = core.read_json(result / 'receipt.json', {})
        if process.returncode or not (result / 'foreground-mask.png').is_file() or not (result / 'relative-depth.png').is_file() or not receipt.get('localInference'):
            raise RuntimeError('真实模型分析未完成，未使用灰度图替代深度模型输出')
        source = core.load_rgb(folder / 'input.png')
        mask = Image.open(result / 'foreground-mask.png').convert('L').resize(source.size, Image.Resampling.LANCZOS)
        depth16 = Image.open(result / 'relative-depth.png')
        depth = depth16.point(lambda n: n / 257).convert('L').resize(source.size, Image.Resampling.BILINEAR)
        foreground = source.convert('RGBA'); foreground.putalpha(mask)
        foreground.save(folder / 'foreground.png'); mask.save(folder / 'foreground-mask.png'); depth.save(folder / 'depth-preview.png')
        from cloth_surface import build_surface_field, field_payload
        field = build_surface_field(source, foreground=mask, relative_depth=depth)
        field.metadata.update(relativeDepthModel='Depth-Anything-V2-Small', metricHeightMeasured=False,
                              foregroundIsGarmentParsing=False, sourceHash=record['sourceHash'])
        core.write_json(folder / 'field.json', field_payload(field))
        record.update(status='succeeded', message='主体与相对深度已分析，笔触使用缓存场实时贴合',
            foregroundUrl=core.data_url(folder / 'foreground.png'), maskUrl=core.data_url(folder / 'foreground-mask.png'),
            depthUrl=core.data_url(folder / 'depth-preview.png'), fieldUrl=core.data_url(folder / 'field.json'),
            receiptUrl=core.data_url(folder / 'receipt.json'), localInference=True, imageUploaded=False,
            metricHeightMeasured=False, physicalSimulation=False,
            warnings=['前景提取保留人物与服装，不等于识别每种衣片或面料。',
                      '凹凸来自模型相对深度和光照线索；纯色、反光及遮挡可能误判，强度可调或关闭。'])
        core.write_json(folder / 'receipt.json', {**record, 'modelReceipt': receipt, 'fieldMetadata': field.metadata})
    except Exception as error:
        record.update(status='failed', message='本机表面分析未完成，保留原照片和已有笔触', error=str(error)[:600])
    record.update(updatedAt=core.now())
    core.write_json(folder / 'job.json', record)


def register_surface_routes(app, core):
    def latest(project):
        path = core.local_image(project)
        fingerprint = image_hash(path)
        records = [core.read_json(p, {}) for p in (core.DATA / 'surface-jobs').glob('*/job.json')]
        records = [r for r in records if r.get('sourceHash') == fingerprint and r.get('sourceUrl') == _source_url(project)
                   and r.get('status') == 'succeeded' and all((core.DATA / 'surface-jobs' / r['id'] / name).is_file()
                       for name in ('field.json', 'foreground-mask.png', 'foreground.png', 'depth-preview.png'))]
        return max(records, key=lambda r: r.get('createdAt', ''), default=None)

    @app.get('/api/projects/{project_id}/surface')
    def get_surface(project_id: str):
        project = core.get_project(project_id)
        found = latest(project)
        if found:
            return found
        config = configuration(core)
        return {'status': 'not_analyzed', 'available': config['available'], 'reason': config['reason'], 'sourceUrl': _source_url(project)}

    @app.post('/api/projects/{project_id}/surface')
    def analyze(request: Request, project_id: str, payload: dict):
        core.require_local_origin(request)
        with core.LOCK:
            project = core.get_project(project_id)
            if isinstance(payload.get('revision'), bool) or payload.get('revision') != project['revision']:
                raise HTTPException(409, '方案已变化，请保存后重新分析')
            cached = latest(project)
            if cached:
                return cached
            config = configuration(core)
            if not config['available']:
                raise HTTPException(422, config['reason'])
            existing = [core.read_json(p, {}) for p in (core.DATA / 'surface-jobs').glob('*/job.json')]
            if any(r.get('status') in {'running', 'queued'} for r in existing):
                raise HTTPException(409, '已有本机表面分析正在执行，请等待完成')
            path = core.local_image(project)
            identifier = 'surface-' + uuid.uuid4().hex[:16]
            folder = core.DATA / 'surface-jobs' / identifier
            folder.mkdir(parents=True, exist_ok=True)
            core.load_rgb(path).save(folder / 'input.png')
            record = {'id': identifier, 'analysisId': identifier, 'status': 'queued', 'projectId': project_id,
                      'sourceRevision': project['revision'], 'sourceHash': image_hash(path), 'sourceUrl': _source_url(project),
                      'sourcePath': str(path), 'createdAt': core.now(), 'updatedAt': core.now(), 'localInference': False,
                      'message': '等待本机分析；不上传照片'}
            core.write_json(folder / 'job.json', record)
            core.EXECUTOR.submit(_worker, core, folder, record, config)
            return record

    @app.get('/api/surface-jobs/{analysis_id}')
    def read_job(analysis_id: str):
        record = core.read_json(core.DATA / 'surface-jobs' / core.safe_id(analysis_id) / 'job.json', {})
        if not record:
            raise HTTPException(404, '表面分析记录不存在')
        return record

    @app.on_event('startup')
    def interrupted():
        for path in (core.DATA / 'surface-jobs').glob('*/job.json'):
            record = core.read_json(path, {})
            if record.get('status') in {'running', 'queued'}:
                record.update(status='interrupted', message='上次本机分析被关闭中断，可重新提交', updatedAt=core.now())
                core.write_json(path, record)
