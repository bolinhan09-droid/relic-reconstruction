"""Garment pixel operations behind a small, replaceable local tool interface.

Every result is a new immutable artifact. Segmentation preserves image-space
coordinates; flattening explicitly starts a new coordinate space. A photograph
cannot establish hidden cloth geometry or measured pattern dimensions.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import uuid

from fastapi import HTTPException
from PIL import Image, ImageChops, ImageDraw, ImageOps


def _fail(message, code=422):
    raise HTTPException(code, message)


def _number(value, low=0., high=1.):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        _fail('坐标或尺寸超出有效范围')
    return float(value)


def _points(value, minimum=3, maximum=200):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        _fail(f'请提供 {minimum} 至 {maximum} 个有效坐标点')
    result = []
    for p in value:
        if not isinstance(p, dict) or not {'x', 'y'} <= set(p):
            _fail('每个坐标点需要 x、y')
        result.append({'x': _number(p['x']), 'y': _number(p['y'])})
    return result


def _local(core, url):
    if not isinstance(url, str) or any(c in url for c in ('?', '#', '\\', '\x00')):
        _fail('请使用当前平台中的本机图片')
    for prefix, root in (('/data/', core.DATA), ('/resources/', core.RESOURCES)):
        if url.startswith(prefix):
            root = Path(root).resolve()
            target = (root / url[len(prefix):]).resolve()
            if target.is_relative_to(root) and target.is_file() and target.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp'}:
                return target
    _fail('本机图片引用无效，请重新上传')


def _source(core, url):
    path = _local(core, url)
    with Image.open(path) as opened:
        if opened.width * opened.height > 24_000_000:
            _fail('图片过大，请先缩小到 2400 万像素以下')
        image = ImageOps.exif_transpose(opened).convert('RGBA')
    return image, hashlib.sha256(path.read_bytes()).hexdigest()


def _folder(core, action):
    identifier = action + '-' + uuid.uuid4().hex[:16]
    folder = core.DATA / 'garment-tools' / identifier
    folder.mkdir(parents=True, exist_ok=False)
    return identifier, folder


def _dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf8')


def _read(path):
    try:
        data = json.loads(path.read_text(encoding='utf8'))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _segmentation_configuration(core):
    settings = _read(core.DATA / 'runtime/segmentation-runtime.json')
    model_dir = Path(settings.get('modelDir') or core.ROOT / 'models/sam2.1-hiera-tiny').resolve()
    choices = [settings.get('pythonExecutable'), str(core.ROOT / '.model-runtime/Scripts/python.exe'),
               str(core.ROOT / '.model-runtime/bin/python'), 'E:/lora-platform/.venv/Scripts/python.exe']
    python = next((p for p in choices if p and Path(p).is_file()), None)
    script = Path(settings.get('scriptPath') or core.ROOT / 'tools/segment_garment.py').resolve()
    available = bool(python and script.is_file() and all((model_dir / f).is_file() for f in
                     ('config.json', 'preprocessor_config.json', 'model.safetensors')))
    device = settings.get('device', 'cpu')
    if device not in {'auto', 'cpu', 'cuda'}:
        device = 'cpu'
    return {'available': available, 'modelDir': model_dir, 'python': python, 'script': script, 'device': device}


def capabilities(core):
    import garment_mapping
    import surface_workflow
    sam = _segmentation_configuration(core)
    flat = garment_mapping.model_configuration(core)
    surface = surface_workflow.configuration(core)
    return {'segmentation': {'available': sam['available'], 'model': 'SAM 2.1 Tiny', 'local': True,
                            'methods': ['polygon'] + (['sam2'] if sam['available'] else []),
                            'reason': '点选或框选后提取真实像素，支持多点排除和边缘修正' if sam['available'] else '分割模型未完整安装；仍可手动圈出部件'},
            'foreground': {'available': surface['available'], 'model': surface['foregroundModel'], 'preservesPerson': True},
            'flatten': {'geometry': True, 'model': flat['available'], 'modelName': 'MGT / TryOffDiffv2Multi',
                        'exactPattern': False, 'qualityWarning': flat.get('qualityWarning', '')}}


def _run(core, python, script, arguments, folder, timeout=240):
    environment = os.environ.copy()
    environment.update(PYTHONUTF8='1', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
    with (folder / 'worker.log').open('w', encoding='utf8') as log:
        try:
            result = subprocess.run([str(python), str(script)] + [str(v) for v in arguments], cwd=core.ROOT,
                                    env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=timeout,
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except subprocess.TimeoutExpired:
            _fail('本机模型处理超时；原图和已有方案未改动', 504)
    if result.returncode:
        _fail('本机模型未完成处理，请检查模型运行环境；未产生占位结果', 503)


def _mask_polygon(mask, points, value):
    ImageDraw.Draw(mask).polygon([(p['x'] * (mask.width - 1), p['y'] * (mask.height - 1)) for p in points], fill=value)


def _mask_result(core, source_url, source_hash, image, mask, identifier, folder, method, params, receipt=None):
    for poly in params.get('excludePolygons', []):
        _mask_polygon(mask, _points(poly), 0)
    for poly in params.get('includePolygons', []):
        _mask_polygon(mask, _points(poly), 255)
    mask = ImageChops.multiply(mask, image.getchannel('A'))
    bbox = mask.getbbox()
    if bbox is None:
        _fail('所选区域没有可见像素，请重新选择')
    padding = round(_number(params.get('padding', .015), 0, .2) * max(image.size))
    bbox = (max(0, bbox[0] - padding), max(0, bbox[1] - padding),
            min(image.width, bbox[2] + padding), min(image.height, bbox[3] + padding))
    result = image.copy()
    result.putalpha(mask)
    result.save(folder / 'image.png')
    result.crop(bbox).save(folder / 'cropped.png')
    mask.save(folder / 'mask.png')
    preview = Image.new('RGBA', image.size, (231, 233, 230, 255))
    preview.alpha_composite(result)
    preview.convert('RGB').save(folder / 'preview.jpg', quality=90)
    name = params.get('name', '服装部件')
    if not isinstance(name, str) or len(name) > 80:
        _fail('部件名称请控制在 80 字以内')
    urls = {key: core.data_url(folder / file) for key, file in
            [('imageUrl', 'image.png'), ('croppedUrl', 'cropped.png'), ('maskUrl', 'mask.png'), ('previewUrl', 'preview.jpg')]}
    normalized = {'x': bbox[0] / image.width, 'y': bbox[1] / image.height,
                  'width': (bbox[2] - bbox[0]) / image.width, 'height': (bbox[3] - bbox[1]) / image.height}
    part = {'id': identifier, 'name': name, **urls, 'bbox': normalized, 'coordinateSpace': 'source_full_size',
            'width': image.width, 'height': image.height, 'cropPixels': list(bbox)}
    output = {'id': identifier, 'status': 'succeeded', **urls, 'sourceImageUrl': source_url, 'sourceHash': source_hash,
              'parts': [part], 'width': image.width, 'height': image.height, 'coordinateSpace': 'source_full_size',
              'localInference': method != 'polygon', 'semanticAI': method != 'polygon', 'method': method,
              'imageUploaded': False, 'exactGeometry': False,
              'warnings': ['分割结果为当前照片可见部件；遮挡部分没有自动补画。', '默认输出保留原图尺寸和坐标，裁切预览另存，不会改变痕迹位置。']}
    if receipt:
        output['modelReceipt'] = receipt
    _dump(folder / 'result.json', output)
    return output


def segment(core, source_url, params):
    """Return a transparent full-size selected part plus a separate cropped preview."""
    if not isinstance(params, dict):
        _fail('分割参数格式无效')
    method = params.get('method', 'sam2')
    if method not in {'sam2', 'polygon'}:
        _fail('请选择 SAM 点选/框选，或手动圈选')
    # Validate before allocating any artifact or invoking a model.
    prompts = {'points': []}
    if method == 'polygon':
        polygon = _points(params.get('polygon'))
        from garment_mapping import validate_boundary
        validate_boundary([(p['x'], p['y']) for p in polygon])
    else:
        raw = params.get('points', [])
        if not isinstance(raw, list) or len(raw) > 64:
            _fail('分割点不能超过 64 个')
        for p in raw:
            point = _points([p], 1, 1)[0]
            label = p.get('label', 1)
            if isinstance(label, bool) or label not in (0, 1):
                _fail('分割点只支持选中或排除')
            prompts['points'].append({**point, 'label': label})
        if params.get('box') is not None:
            box = params['box']
            if not isinstance(box, dict) or not {'x', 'y', 'width', 'height'} <= set(box):
                _fail('框选区域格式无效')
            box = {k: _number(box[k]) for k in ('x', 'y', 'width', 'height')}
            if min(box['width'], box['height']) <= 0 or box['x'] + box['width'] > 1 or box['y'] + box['height'] > 1:
                _fail('框选区域必须位于图片内且有面积')
            prompts['box'] = box
        if not any(p['label'] == 1 for p in prompts['points']) and 'box' not in prompts:
            _fail('请点选需要保留的衣服，或框出该部件')
        config = _segmentation_configuration(core)
        if not config['available']:
            _fail('SAM 2.1 分割模型未安装完整；可先手动圈选部件', 503)
    for field in ('includePolygons', 'excludePolygons'):
        if not isinstance(params.get(field, []), list) or len(params.get(field, [])) > 30:
            _fail('边缘修正区域数量无效')
        for polygon_ in params.get(field, []):
            _points(polygon_)
    image, source_hash = _source(core, source_url)
    identifier, folder = _folder(core, 'segment')
    receipt = None
    if method == 'polygon':
        mask = Image.new('L', image.size)
        _mask_polygon(mask, polygon, 255)
    else:
        image.save(folder / 'input.png')
        _dump(folder / 'prompts.json', prompts)
        _run(core, config['python'], config['script'], ['--input', folder / 'input.png', '--output-dir', folder / 'model-output',
             '--model-dir', config['modelDir'], '--prompts', folder / 'prompts.json', '--device', config['device']], folder)
        receipt = _read(folder / 'model-output/receipt.json')
        if receipt.get('localInference') is not True or not (folder / 'model-output/mask.png').is_file():
            _fail('SAM 未返回真实分割结果', 503)
        with Image.open(folder / 'model-output/mask.png') as opened:
            mask = opened.convert('L')
        if mask.size != image.size:
            _fail('分割遮罩尺寸不匹配，未应用错误的坐标', 503)
    return _mask_result(core, source_url, source_hash, image, mask, identifier, folder, method, params, receipt)


def foreground(core, source_url, params=None):
    """Retain the whole subject including the head; never use garment-only SAM here."""
    import surface_workflow
    params = params or {}
    config = surface_workflow.configuration(core)
    if not config['available']:
        _fail('本机主体提取模型未安装完整', 503)
    image, source_hash = _source(core, source_url)
    identifier, folder = _folder(core, 'foreground')
    image.save(folder / 'input.png')
    _run(core, config['python'], config['script'], ['--input', folder / 'input.png', '--output-dir', folder / 'model-output',
         '--model-dir', config['modelDir'], '--foreground-model', config['foregroundModel']], folder)
    receipt = _read(folder / 'model-output/receipt.json')
    mask_path = folder / 'model-output/foreground-mask.png'
    if receipt.get('localInference') is not True or not mask_path.is_file():
        _fail('主体提取未完成，原背景仍保留', 503)
    with Image.open(mask_path) as opened:
        mask = opened.convert('L').resize(image.size, Image.Resampling.LANCZOS)
    result = _mask_result(core, source_url, source_hash, image, mask, identifier, folder, 'u2net_foreground',
                          {**params, 'name': params.get('name', '人物与服装主体')}, receipt)
    result['warnings'] = ['保留人物与服装整体，不等于识别各件衣服；头发、手持物和细边缘需检查。']
    result['relativeDepthUrl'] = core.data_url(folder / 'model-output/relative-depth.png')
    _dump(folder / 'result.json', result)
    return result


def flatten(core, source_url, params):
    """Visible-surface rectification or explicitly inferred model-generated flatlay."""
    if not isinstance(params, dict):
        _fail('展平参数格式无效')
    method = params.get('method', 'geometry')
    if method not in {'geometry', 'model'}:
        _fail('请选择可见区域矫正或 AI 平铺外观')
    image, source_hash = _source(core, source_url)
    if method == 'geometry':
        points = _points(params.get('quad'), 4, 4)
        from garment_mapping import validate_boundary, cross
        pairs = [(p['x'], p['y']) for p in points]
        validate_boundary(pairs)
        signs = [cross(pairs[i], pairs[(i + 1) % 4], pairs[(i + 2) % 4]) for i in range(4)]
        if not all(v > 1e-6 for v in signs):
            _fail('请按左上、右上、右下、左下顺序选择四个凸四边形锚点')
        scaled = [(p['x'] * image.width, p['y'] * image.height) for p in points]
        distance = lambda a, b: math.hypot(a[0] - b[0], a[1] - b[1])
        default_width = max(64, (distance(scaled[0], scaled[1]) + distance(scaled[3], scaled[2])) / 2)
        default_height = max(64, (distance(scaled[0], scaled[3]) + distance(scaled[1], scaled[2])) / 2)
        ratio = min(1., 2048 / max(default_width, default_height))
        width = round(_number(params.get('outputWidth', max(32, default_width * ratio)), 32, 2048))
        height = round(_number(params.get('outputHeight', max(32, default_height * ratio)), 32, 2048))
    else:
        import garment_mapping
        config = garment_mapping.model_configuration(core)
        if not config['available']:
            _fail('本机 AI 平铺模型未安装或尚未验证', 503)
        category = params.get('category', 'upper')
        if category not in {'upper', 'lower', 'dress'}:
            _fail('平铺模型仅支持上衣、下装或连衣服装')
    identifier, folder = _folder(core, 'flatten')
    image.save(folder / 'input.png')
    if method == 'geometry':
        # Pillow QUAD is a real inverse bilinear warp of visible pixels. It is
        # deliberately not described as recovered 3D cloth or an AI completion.
        quad = tuple(c for index in (0, 3, 2, 1) for c in scaled[index])
        result = image.transform((width, height), Image.Transform.QUAD, quad, Image.Resampling.BICUBIC)
        result.save(folder / 'image.png')
        output = {'semanticAI': False, 'localInference': False, 'inferredHidden': False,
                  'transform': {'kind': 'inverse_bilinear_quad', 'sourcePoints': points, 'sourceSize': list(image.size),
                                'targetSize': [width, height]},
                  'warnings': ['仅矫正选中区域的可见像素，褶皱遮挡部分仍未知。', '结果是近似表面整形，不是服装纸样，也不包含真实尺寸。']}
    else:
        white = Image.new('RGBA', image.size, 'white')
        white.alpha_composite(image)
        white.convert('RGB').save(folder / 'input.png')
        _run(core, config['python'], config['script'], ['--input', folder / 'input.png', '--output-dir', folder / 'model-output',
             '--model-dir', config['modelDir'], '--category', category, '--steps', '30', '--seed', '42'], folder, 1200)
        receipt = _read(folder / 'model-output/receipt.json')
        path = folder / 'model-output/flatlay.png'
        if receipt.get('semanticAI') is not True or not path.is_file():
            _fail('平铺模型没有完成真实推理，未使用几何占位图代替', 503)
        with Image.open(path) as opened:
            result = opened.convert('RGBA')
        result.save(folder / 'image.png')
        width, height = result.size
        output = {'semanticAI': True, 'localInference': True, 'inferredHidden': True, 'modelReceipt': receipt,
                  'warnings': ['AI 生成平铺外观可能改变结构和已有痕迹；不可作为已验证的制作版型。',
                               config.get('qualityWarning', ''), '后续请在映射节点确认真实平铺照片的对应点。']}
    output.update(id=identifier, status='succeeded', imageUrl=core.data_url(folder / 'image.png'),
                  sourceImageUrl=source_url, sourceHash=source_hash, method=method, width=width, height=height,
                  exactGeometry=False, measuredDimensions=False, imageUploaded=False,
                  coordinateSpace='generated_flatlay' if method == 'model' else 'rectified_visible_surface')
    _dump(folder / 'result.json', output)
    return output


def _assistant_source(core, project, folder):
    """Bake the current editable view exactly once before changing coordinates."""
    import brush_workflow
    reference_url = (project.get('reference') or {}).get('url')
    # The assistant binds its reference to the current raster. An older uploadId
    # can remain in a project snapshot and must not redirect this operation back
    # to the original, unedited garment.
    source_path = _local(core, reference_url) if reference_url else core.local_image(project)
    with Image.open(source_path) as opened:
        source = ImageOps.exif_transpose(opened).convert('RGBA')
    if project.get('brushStrokes'):
        _, paint = brush_workflow._raster(project, source.size, with_paint=True, source=source.convert('RGB'))
        source.alpha_composite(paint)
    path = Path(folder) / ('garment-source-' + uuid.uuid4().hex[:10] + '.png')
    path.parent.mkdir(parents=True, exist_ok=True)
    source.save(path)
    return core.data_url(path)


def _assistant_tool(action):
    def execute(core, project, args, candidate_folder):
        project = copy.deepcopy(project)
        source_url = _assistant_source(core, project, candidate_folder)
        output = action(core, source_url, args)
        from .adapters import _image_as_upload
        asset = _image_as_upload(core, output['imageUrl'], '协作执行 · 服装结果')
        project['reference'] = asset
        project['uploadId'] = asset['id']
        project.pop('garmentId', None)
        project.pop('garmentID', None)
        output.update(imageUrl=asset['url'], artifactType='raster_base', editableStrokes=False)
        project.update(brushStrokes=[], damageItems=[], brushAllowedRegions=[], brushEditRegions=[])
        project.pop('surfaceOptions', None)
        if output['coordinateSpace'] != 'source_full_size':
            previous_protections = copy.deepcopy(project.get('protectedRects', []))
            project['protectedRects'] = []
            output['protectionMapping'] = {'status': 'requires_reselection', 'previousRegions': previous_protections}
            output['warnings'].append('输出坐标已经改变，请重新圈定保护区；原方案中的保护范围和笔触仍保留在原分支。')
        return {'project': project, 'output': output, 'message': '已产生独立服装结果，原方案保持不变',
                'validation': {'passed': True, 'kind': 'local_tool', 'pixelOperation': True,
                               'sourceUnchanged': True, 'originalUnchanged': True, 'coordinateSpace': output['coordinateSpace'],
                               'requiresProtectionReselection': output['coordinateSpace'] != 'source_full_size',
                               'requiresVisualReview': True}}
    return execute


def assistant_tools():
    return {'garment_split': _assistant_tool(segment), 'garment_flatten': _assistant_tool(flatten),
            'foreground_remove': _assistant_tool(foreground)}
