"""Costume preview prototype with local, manual-import and optional image API paths."""
from __future__ import annotations

import copy
import html
import io
import json
import logging
import math
import os
import re
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps
import cloud_provider
import runtime_paths
import local_models

ROOT = runtime_paths.asset_root()
RESOURCES = ROOT / 'resources'
DATA = runtime_paths.data_root()
WEB = ROOT / 'web'
for folder in (DATA, DATA / 'uploads', DATA / 'projects', DATA / 'jobs', DATA / 'runtime'):
    folder.mkdir(parents=True, exist_ok=True)
COMFY_URL = local_models.get_settings(DATA)['comfyUrl']
MAX_UPLOAD = 20 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 24_000_000
LOCK = threading.RLock()
EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix='relic-generation')
TYPES = {'slash': '刀痕', 'blood': '血迹', 'burn': '烧焦'}
GENERATION_PIPELINE = 'sd15_masked_img2img_v1'
LOG = logging.getLogger('relic')
app = FastAPI(title='遗迹重构 · 节点创作台', version='0.10.0')


@app.exception_handler(RequestValidationError)
async def safe_request_validation(request: Request, exc: RequestValidationError):
    # Default validation bodies can echo invalid inputs. Never echo a pasted key.
    if request.url.path in ('/api/settings/ai', '/api/assistant/settings'):
        return Response(json.dumps({'detail': '接口设置格式不正确，请使用 JSON 对象提交。'}, ensure_ascii=False),
                        status_code=422, media_type='application/json')
    return await request_validation_exception_handler(request, exc)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def read_json(path: Path, default: Any = None) -> Any:
    if not path.is_file():
        return copy.deepcopy(default)
    try:
        return json.loads(path.read_text(encoding='utf-8-sig'))
    except (ValueError, OSError) as exc:
        raise HTTPException(500, f'本地资料读取失败：{path.name}') from exc


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    os.replace(temporary, path)


def safe_id(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value):
        raise HTTPException(400, '无效的资料编号')
    return value


def rows(value: Any, key: str) -> list[dict]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        result = value.get(key, [])
        return result if isinstance(result, list) else []
    return []


def catalog() -> dict:
    return read_json(RESOURCES / 'catalog.json', {'characters': [], 'merchants': [], 'garments': []})


def scenarios() -> Any:
    return read_json(RESOURCES / 'scenarios.json', {'scenarios': []})


def registered_models() -> list[dict]:
    return local_models.registered_models(RESOURCES, DATA)


def rect(value: Any) -> dict:
    if not isinstance(value, dict):
        raise HTTPException(422, '区域须含 x、y、w、h')
    result = {}
    for key in ('x', 'y', 'w', 'h'):
        try:
            number = float(value[key])
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(422, '区域坐标须为 0–1 的数值') from exc
        if not math.isfinite(number) or number < 0 or number > 1:
            raise HTTPException(422, '区域坐标须为 0–1 的数值')
        result[key] = round(number, 6)
    if result['w'] <= 0 or result['h'] <= 0 or result['x'] + result['w'] > 1.000001 or result['y'] + result['h'] > 1.000001:
        raise HTTPException(422, '区域宽高须大于 0，且不能超出原图')
    return result


def damage_items(value: Any) -> list[dict]:
    if not isinstance(value, list) or len(value) > 20:
        raise HTTPException(422, '每个方案最多设置 20 处战损')
    result, seen = [], set()
    for i, item in enumerate(value):
        if not isinstance(item, dict) or item.get('type') not in TYPES:
            raise HTTPException(422, '痕迹类型须为 slash、blood 或 burn')
        entry = copy.deepcopy(item)
        entry['id'] = safe_id(str(item.get('id') or f'damage-{i + 1}'))
        if entry['id'] in seen:
            raise HTTPException(422, '战损区域编号不能重复')
        seen.add(entry['id'])
        entry['rect'] = rect(item.get('rect'))
        try:
            intensity = float(item.get('intensity', .45))
        except (TypeError, ValueError) as exc:
            raise HTTPException(422, '模型编辑程度须为 0–1') from exc
        if not math.isfinite(intensity) or not 0 <= intensity <= 1:
            raise HTTPException(422, '模型编辑程度须为 0–1')
        entry['intensity'] = intensity
        entry['notes'] = str(item.get('notes', ''))[:2000]
        result.append(entry)
    return result


def protected_rects(value: Any) -> list[dict]:
    if not isinstance(value, list) or len(value) > 30:
        raise HTTPException(422, '最多设置 30 个保护区域')
    result = []
    for item in value:
        actual = item.get('rect', item) if isinstance(item, dict) else item
        normalized = rect(actual)
        if isinstance(item, dict) and 'rect' in item:
            result.append({**item, 'rect': normalized})
        else:
            result.append(normalized)
    return result


def get_project(project_id: str) -> dict:
    value = read_json(DATA / 'projects' / safe_id(project_id) / 'project.json')
    if value is None:
        raise HTTPException(404, '方案不存在')
    return value


def get_job(job_id: str) -> dict:
    value = read_json(DATA / 'jobs' / safe_id(job_id) / 'job.json')
    if value is None:
        raise HTTPException(404, '生成任务不存在')
    return value


def data_url(path: Path) -> str:
    return '/data/' + path.resolve().relative_to(DATA.resolve()).as_posix()


def local_image(project: dict) -> Path:
    reference = project.get('reference') or {}
    if not isinstance(reference, dict):
        raise HTTPException(422, '服装底图引用格式不正确，请重新选择或上传照片')
    upload_id = project.get('uploadId') or reference.get('id')
    reference_url = reference.get('url')
    uploaded_reference = bool(project.get('uploadId') or reference.get('uploaded') is True
                              or (isinstance(upload_id, str) and upload_id.startswith('upload-'))
                              or (isinstance(reference_url, str) and reference_url.startswith('/data/uploads/')))
    if upload_id:
        candidate = DATA / 'uploads' / safe_id(str(upload_id)) / 'image.png'
        if candidate.is_file():
            return candidate
    if uploaded_reference:
        # A missing personal photograph must never silently turn into a catalog sample.
        if not upload_id and isinstance(reference_url, str) and reference_url.startswith('/data/uploads/'):
            upload_root = (DATA / 'uploads').resolve()
            candidate = (upload_root / reference_url[len('/data/uploads/'):]).resolve()
            if candidate.is_relative_to(upload_root) and candidate.is_file() and candidate.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp'}:
                return candidate
        raise HTTPException(422, '原上传服装照片已丢失或引用失效，请重新上传；当前方案不会改用示例服装')
    garment_id = project.get('garmentId') or project.get('garmentID')
    garment = next((g for g in catalog().get('garments', []) if g.get('id') == garment_id), None)
    source = (garment or {}).get('imageUrl') or reference.get('url') or project.get('imageUrl')
    if isinstance(source, str) and source.startswith(('/resources/', '/data/uploads/')):
        base = RESOURCES if source.startswith('/resources/') else DATA / 'uploads'
        relative = source[len('/resources/'):] if base == RESOURCES else source[len('/data/uploads/'):]
        candidate = (base / relative).resolve()
        if candidate.is_relative_to(base.resolve()) and candidate.is_file() and candidate.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp'}:
            return candidate
    raise HTTPException(422, '请先选择样衣或上传 PNG、JPEG、WebP 服装照片')


def load_rgb(path: Path) -> Image.Image:
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source)
        if image.width < 8 or image.height < 8:
            raise HTTPException(422, '照片尺寸过小')
        rgba = image.convert('RGBA')
        background = Image.new('RGBA', rgba.size, 'white')
        background.alpha_composite(rgba)
        return background.convert('RGB')


def check_project(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise HTTPException(422, '方案格式不正确')
    project = copy.deepcopy(payload)
    project['title'] = str(project.get('title') or '未命名战损方案')[:200]
    project['damageItems'] = damage_items(project.get('damageItems', []))
    project['protectedRects'] = protected_rects(project.get('protectedRects', []))
    from brush_workflow import validate_brush_strokes, validate_brush_options
    project['brushStrokes'] = validate_brush_strokes(project.get('brushStrokes', []))
    project.update(validate_brush_options(project))
    from surface_workflow import validate_options
    surface_options = validate_options(project)
    if surface_options is not None:
        project['surfaceOptions'] = surface_options
    project['customDamageIdea'] = str(project.get('customDamageIdea', ''))[:4000]
    reversible = project.get('reversibleRequired', True)
    if not isinstance(reversible, bool) and reversible != 'unknown':
        raise HTTPException(422, '可恢复要求须为勾选状态或尚未确定')
    project['reversibleRequired'] = reversible
    scene = scenario_for(project)
    if scene.get('burnRequiresCustomAddition') and any(item['type'] == 'burn' for item in project['damageItems']) and not project.get('customDamageEnabled'):
        raise HTTPException(422, '该剧情没有烧焦依据；请先开启自主战损补充，再添加烧焦区域')
    if project.get('mode') not in (None, 'canonical', 'custom', 'story', 'reconstruction'):
        # Generation mode is kept separately; newer clients may use a named workflow.
        project['mode'] = str(project['mode'])[:80]
    local_image(project)
    if surface_options and surface_options['enabled']:
        from surface_workflow import resolve_analysis
        resolve_analysis(project, strict=True)
    if project.get('conceptReference'):
        reference = project['conceptReference']
        if isinstance(reference, str):
            reference = {'url': reference}
        if not isinstance(reference, dict):
            raise HTTPException(422, '二维参考图格式不正确')
        image = load_rgb(local_reference(reference))
        project['conceptReference'] = {**reference, 'width': image.width, 'height': image.height}
    return project


def local_reference(reference: dict | str) -> Path:
    """Resolve a concept image only from canonical local image directories."""
    url = reference if isinstance(reference, str) else reference.get('url', '')
    if not isinstance(url, str) or '?' in url or '#' in url or '\\' in url:
        raise HTTPException(422, '二维参考必须是平台内已上传或已生成的图片')
    roots = [(RESOURCES, '/resources/'), (DATA / 'uploads', '/data/uploads/'), (DATA / 'jobs', '/data/jobs/')]
    for folder, prefix in roots:
        if url.startswith(prefix):
            candidate = (folder / url[len(prefix):]).resolve()
            if candidate.is_relative_to(folder.resolve()) and candidate.is_file() and candidate.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp'):
                if prefix == '/data/jobs/' and candidate.name != 'result.png':
                    break
                return candidate
    raise HTTPException(422, '二维参考图片不存在，或路径不受支持')


def require_local_origin(request: Request | None, require_json: bool = True):
    """Secrets and charged actions are allowed only through the local same-origin UI."""
    loopback = {'127.0.0.1', '::1', 'localhost'}
    if request is None or request.client is None or request.client.host not in loopback or request.url.hostname not in loopback:
        raise HTTPException(403, '请在本机打开平台完成此操作')
    origin = request.headers.get('origin')
    expected = str(request.base_url).rstrip('/')
    if origin and origin.rstrip('/') != expected:
        raise HTTPException(403, '不允许跨站提交密钥或生成请求')
    if request.headers.get('sec-fetch-site') == 'cross-site':
        raise HTTPException(403, '不允许跨站提交此操作')
    if require_json and request.method == 'POST' and 'application/json' not in request.headers.get('content-type', ''):
        raise HTTPException(415, '请使用 JSON 提交接口设置或生成请求')


@app.get('/api/settings/ai')
def api_get_ai_settings():
    return cloud_provider.public_settings()


@app.post('/api/settings/ai')
def api_set_ai_settings(payload: dict, request: Request):
    require_local_origin(request)
    try:
        return cloud_provider.configure(payload)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@app.delete('/api/settings/ai')
def api_clear_ai_key(request: Request, provider: str | None = None):
    require_local_origin(request)
    try:
        return cloud_provider.clear_key(provider)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@app.post('/api/settings/ai/check')
def api_check_ai_settings(payload: dict, request: Request):
    require_local_origin(request)
    try:
        return cloud_provider.check_connection(payload)
    except (ValueError, cloud_provider.CloudError) as exc:
        raise HTTPException(422, str(exc)) from None


def garment_for(project: dict) -> dict:
    return next((g for g in catalog().get('garments', []) if g.get('id') == project.get('garmentId')), {})


def scenario_for(project: dict) -> dict:
    return next((s for s in rows(scenarios(), 'scenarios') if s.get('id') == project.get('scenarioId')), {})


def pixel_rect(value: dict, width: int, height: int) -> tuple[int, int, int, int]:
    value = value.get('rect', value)
    left, top = int(value['x'] * width), int(value['y'] * height)
    right = min(width, max(left + 1, math.ceil((value['x'] + value['w']) * width)))
    bottom = min(height, max(top + 1, math.ceil((value['y'] + value['h']) * height)))
    return left, top, right, bottom


def mask_for(item: dict, protected: list[dict], size: tuple[int, int]) -> Image.Image:
    mask = Image.new('L', size, 0)
    draw = ImageDraw.Draw(mask)
    x0, y0, x1, y1 = pixel_rect(item['rect'], *size)
    draw.rectangle((x0, y0, x1 - 1, y1 - 1), fill=255)
    for protection in protected:
        x0, y0, x1, y1 = pixel_rect(protection, *size)
        draw.rectangle((x0, y0, x1 - 1, y1 - 1), fill=0)
    return mask


def font(size: int = 22) -> ImageFont.ImageFont:
    for candidate in (Path('C:/Windows/Fonts/msyh.ttc'), Path('C:/Windows/Fonts/arial.ttf')):
        if candidate.is_file():
            try:
                return ImageFont.truetype(str(candidate), size)
            except OSError:
                pass
    return ImageFont.load_default()


def preview(project: dict) -> Path:
    image = load_rgb(local_image(project)).convert('RGBA')
    if project.get('brushStrokes'):
        from brush_workflow import render_brush_guide
        image = render_brush_guide(image, project).convert('RGBA')
    layer = Image.new('RGBA', image.size)
    draw = ImageDraw.Draw(layer)
    colors = {'slash': (242, 153, 74), 'blood': (160, 48, 56), 'burn': (101, 103, 115)}
    size = max(15, round(min(image.size) / 36))
    for number, item in enumerate(project['damageItems'], 1):
        x0, y0, x1, y1 = pixel_rect(item['rect'], *image.size)
        color = colors[item['type']]
        draw.rectangle((x0, y0, x1 - 1, y1 - 1), fill=(*color, 38), outline=(*color, 255), width=max(2, size // 9))
        text = f'{number:02d} {TYPES[item["type"]]}'
        draw.text((x0 + 5, y0 + 4), text, font=font(size), fill=(*color, 255), stroke_width=1, stroke_fill=(255, 255, 255, 255))
    for protection in project['protectedRects']:
        x0, y0, x1, y1 = pixel_rect(protection, *image.size)
        draw.rectangle((x0, y0, x1 - 1, y1 - 1), outline=(64, 150, 124, 255), width=max(2, size // 9))
        draw.text((x0 + 5, y0 + 4), '保护', font=font(size), fill=(28, 109, 86, 255))
    image = Image.alpha_composite(image, layer).convert('RGB')
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, image.width, size * 2), fill='white')
    draw.text((10, 4), '位置规划示意 · 非 AI 生成效果', font=font(size), fill=(60, 65, 74))
    path = DATA / 'projects' / project['id'] / 'preview.png'
    image.save(path)
    return path


def instructions(project: dict) -> list[dict]:
    garment = garment_for(project)
    material = project.get('material') or project.get('uploadMaterial') or garment.get('material') or '未知，需用户确认'
    reversible = project.get('reversibleRequired', True)
    result = []
    for number, item in enumerate(project.get('damageItems', []), 1):
        r = item['rect']
        position = f'图中横向 {r["x"]:.0%}–{r["x"] + r["w"]:.0%}，纵向 {r["y"]:.0%}–{r["y"] + r["h"]:.0%}'
        method = {
            'slash': '先在废布试样，以可拆贴片或局部抽丝模拟裂口；确认款式关键结构后再决定是否裁切。',
            'blood': '先以布用颜料在废布试色，按区域分层点染、擦染；干燥后检查渗透范围。',
            'burn': '先以深色布用颜料和可拆补丁模拟炭化边缘，分层控制深浅；制作阶段使用模拟材质。',
        }[item['type']]
        if reversible:
            method = {
                'slash': '先在可拆补丁或同材质废布上做裂口、抽丝效果，再固定到对应编号区域；保持原衣不裁切。',
                'blood': '先在可拆布片上试色并制作戏剧血迹，干燥后再固定到对应位置；不将布用颜料可洗作为恢复保证。',
                'burn': '先在可拆补丁上用深色颜料、仿焦边材质模拟烧焦，再固定到对应位置；使用模拟材质。',
            }[item['type']]
        result.append({'number': f'{number:02d}', 'damageId': item['id'], 'type': item['type'], 'label': TYPES[item['type']],
                       'position': position, 'rect': r, 'intensity': item['intensity'], 'notes': item.get('notes', ''),
                       'method': method, 'material': material, 'materialStatus': '需用户确认',
                       'intensityMeaning': '模型编辑程度，不代表物理损伤量',
                       'reversibleRequired': reversible,
                       'check': ('可恢复要求尚未确定，暂以可拆试样作参考。' if reversible == 'unknown' else '')
                           + '先确认面料、正反面与保护区；小样通过后再在对应编号区域操作。'})
    brush_labels = {'blood': '血迹', 'slash': '割裂', 'wear': '磨损', 'burn': '焦痕'}
    for kind, label in brush_labels.items():
        strokes = [stroke for stroke in project.get('brushStrokes', []) if stroke['type'] == kind]
        if not strokes:
            continue
        result.append({'number': f'画笔·{label}', 'damageId': f'brush-{kind}', 'type': kind, 'label': label,
                       'position': '对照绘制引导图中的笔触位置；已擦除与保护区域不参与精修',
                       'rect': None, 'intensity': sum(stroke['opacity'] for stroke in strokes) / len(strokes),
                       'notes': f'{len(strokes)} 笔。浓淡为草图视觉参数，不代表物理损伤量或颜料用量。',
                       'method': '先在同材质废布或可拆贴片上做小样，对照视觉方案确认颜色、边缘及固定方式，再决定实物操作。',
                       'material': material, 'materialStatus': '需用户确认', 'intensityMeaning': '画笔草图浓淡，不代表物理损伤量',
                       'reversibleRequired': reversible, 'check': '实际尺寸、渗色、手感、清洗与结构强度由实物小样确认。'})
    return result


def comfy_client(timeout: float = 5) -> httpx.Client:
    return httpx.Client(base_url=local_models.get_settings(DATA)['comfyUrl'], timeout=timeout, trust_env=False)


def input_choices(info: dict, node: str, field: str) -> list[str]:
    try:
        definition = info[node]['input']['required'][field][0]
        return definition if isinstance(definition, list) else []
    except (KeyError, TypeError, IndexError):
        return []


def environment() -> dict:
    result = {'comfy_available': False, 'base_model_available': False, 'baseModelId': None, 'checkpoint': None,
              'comfyUrl': COMFY_URL, 'semanticVisualAI': False, 'reason': '尚未连接本机图像生成服务', 'checkpoints': [],
              'pipeline': GENERATION_PIPELINE, 'intensityMeaning': '模型编辑程度，不代表物理损伤量'}
    try:
        with comfy_client() as client:
            stats = client.get('/system_stats')
            stats.raise_for_status()
            info_response = client.get('/object_info')
            info_response.raise_for_status()
            info = info_response.json()
        checkpoints = input_choices(info, 'CheckpointLoaderSimple', 'ckpt_name')
        result.update(comfy_available=True, checkpoints=checkpoints)
        required = {'CheckpointLoaderSimple', 'LoadImage', 'VAEEncode', 'SetLatentNoiseMask', 'KSampler', 'VAEDecode', 'SaveImage', 'CLIPTextEncode', 'ImageCompositeMasked'}
        missing = sorted(required.difference(info))
        if missing:
            result['reason'] = '图像服务缺少工作流节点：' + '、'.join(missing)
            return result
        for model in registered_models():
            if (model.get('kind') or model.get('type')) not in ('base', 'checkpoint'):
                continue
            model_file = model.get('file') or model.get('path') or model.get('checkpoint')
            checkpoint = str(model.get('checkpointName') or model.get('checkpoint') or (Path(str(model_file)).name if model_file else ''))
            status = model.get('status')
            architecture = str(model.get('architecture') or model.get('baseModel') or '').lower().replace('.', '')
            if architecture not in ('sd15', 'sd1_5', 'stable-diffusion-15', 'stable-diffusion-1-5') or status not in ('ready', 'available', 'trained'):
                continue
            if model_file and (':' in str(model_file) or str(model_file).startswith('/')) and not Path(str(model_file)).is_file():
                continue
            if checkpoint in checkpoints:
                result.update(base_model_available=True, baseModelId=model.get('id'), checkpoint=checkpoint,
                              reason='基础模型实验可用；专用痕迹模型尚未训练')
                break
        if not result['base_model_available']:
            result['reason'] = '注册的 SD1.5 底模尚未在本机图像服务中就绪'
        result['loraFiles'] = input_choices(info, 'LoraLoader', 'lora_name')
    except (httpx.HTTPError, ValueError, OSError) as exc:
        result['reason'] = '本机图像服务未连接，请先启动现有图像生成服务'
        result['technicalDetail'] = str(exc)[:180]
    return result


@app.get('/api/health')
def health():
    return {'ok': True, 'application': 'relic-reconstruction', 'version': '0.10.0', 'root': str(ROOT),
            'dataDir': str(DATA), 'themeUrl': '/data/theme.png' if (DATA / 'theme.png').is_file() else None}


@app.get('/api/catalog')
def api_catalog():
    return catalog()


@app.get('/api/scenarios')
def api_scenarios():
    return scenarios()


@app.get('/api/models')
def api_models():
    env = environment()
    result = []
    for model in registered_models():
        entry = copy.deepcopy(model)
        kind = entry.get('kind') or entry.get('type')
        entry['kind'] = kind
        entry['type'] = entry.get('damageType') or kind
        is_base = kind in ('base', 'checkpoint')
        model_file = entry.get('file') or entry.get('path')
        ready = entry.get('status') in ('ready', 'trained', 'available')
        entry['available'] = bool(env['base_model_available'] and entry.get('id') == env['baseModelId']) if is_base else bool(
            ready and model_file and Path(str(model_file)).is_file()
            and entry.get('architecture') == 'sd15' and (entry.get('checkpointName') or entry.get('checkpoint') or Path(str(model_file)).name) in env.get('loraFiles', []))
        entry['baseModel'] = entry.get('architecture', 'sd15')
        entry['reason'] = env['reason'] if is_base else ('文件已登记且服务可见；效果与兼容性仍需实测' if entry['available'] else '尚未登记或未接入，暂不可调用')
        result.append(entry)
    return {'models': result, 'environment': env, 'cloud': cloud_provider.public_settings(),
            'visualReview': {'kind': 'pixel_protection_and_manual', 'semanticAI': False}}


@app.get('/api/environment')
def api_environment():
    return environment()


@app.post('/api/uploads')
async def upload(file: UploadFile = File(...)):
    content = await file.read(MAX_UPLOAD + 1)
    await file.close()
    if len(content) > MAX_UPLOAD:
        raise HTTPException(413, '照片不应超过 20 MB')
    try:
        with Image.open(io.BytesIO(content)) as source:
            if source.format not in ('PNG', 'JPEG', 'WEBP'):
                raise ValueError('format')
            source.verify()
        with Image.open(io.BytesIO(content)) as source:
            image = ImageOps.exif_transpose(source).convert('RGBA')
            image.load()
        if image.width < 32 or image.height < 32 or image.width * image.height > 24_000_000:
            raise ValueError('dimensions')
    except (ValueError, OSError, Image.DecompressionBombError) as exc:
        raise HTTPException(422, '请选择有效的 PNG、JPEG、WebP 照片，尺寸至少 32×32，不超过 2400 万像素') from exc
    upload_id = 'upload-' + uuid.uuid4().hex[:16]
    path = DATA / 'uploads' / upload_id / 'image.png'
    path.parent.mkdir(parents=True)
    image.save(path, format='PNG')
    result = {'id': upload_id, 'url': data_url(path), 'width': image.width, 'height': image.height,
              'originalName': Path(file.filename or '照片').name, 'createdAt': now()}
    write_json(path.parent / 'upload.json', result)
    return result


@app.post('/api/plan')
def plan(payload: dict):
    scene = scenario_for(payload)
    suggestions = scene.get('suggestedDamageItems') if 'suggestedDamageItems' in scene else scene.get('damageItems')
    defaults = {
        'slash': {'x': .30, 'y': .34, 'w': .26, 'h': .12},
        'blood': {'x': .49, 'y': .47, 'w': .18, 'h': .22},
        'burn': {'x': .35, 'y': .70, 'w': .28, 'h': .16},
    }
    if suggestions is None:
        selected = scene.get('damageTypes', ['slash'])
        suggestions = [{'id': f'damage-{i + 1}', 'type': damage_type, 'rect': defaults[damage_type], 'intensity': .35,
                        'notes': '规则推演的初始位置，可拖动调整；原作未确认该具体痕迹。'}
                       for i, damage_type in enumerate(selected) if damage_type in TYPES]
    suggestions = damage_items(suggestions)
    protections = protected_rects(payload.get('protectedRects', []))
    project = {**payload, 'damageItems': suggestions, 'protectedRects': protections}
    notes = ['以下为规则建议，未进行实时联网搜索或视觉 AI 判断。',
             '剧情来源与痕迹推演分别标注；区域位置不代表官方战损设定。', '面料、正反面、装饰与结构件保护范围需在制作前确认。',
             '编辑程度用于控制模型修改幅度，不代表衣物实际损伤量或制作时的物理尺度。']
    return {'label': '规则建议', 'provider': 'local_scene_rules', 'damageItems': suggestions, 'protectedRects': protections,
            'steps': instructions(project), 'notes': notes, 'scenario': scene, 'sources': scene.get('sources', []),
            'canonicalStatus': scene.get('canonicalStatus') or scene.get('status') or 'inferred', 'semanticAI': False}


@app.get('/api/projects')
def list_projects():
    projects = [read_json(path) for path in (DATA / 'projects').glob('*/project.json')]
    projects = sorted((p for p in projects if p), key=lambda p: p.get('updatedAt', ''), reverse=True)
    return {'projects': projects}


@app.post('/api/projects')
def create_project(payload: dict):
    project = check_project(payload)
    project_id = 'project-' + uuid.uuid4().hex[:16]
    project.update(id=project_id, revision=1, version=1, createdAt=now(), updatedAt=now())
    folder = DATA / 'projects' / project_id
    with LOCK:
        write_json(folder / 'history' / 'revision-0001.json', project)
        write_json(folder / 'project.json', project)
        preview(project)
    return {**project, 'previewUrl': f'/data/projects/{project_id}/preview.png'}


@app.get('/api/projects/{project_id}')
def api_get_project(project_id: str):
    project = get_project(project_id)
    return {**project, 'previewUrl': f'/data/projects/{project_id}/preview.png'}


@app.put('/api/projects/{project_id}')
def update_project(project_id: str, payload: dict):
    with LOCK:
        old = get_project(project_id)
        supplied_revision = payload.get('revision', payload.get('version'))
        if supplied_revision != old['revision']:
            raise HTTPException(409, '方案已更新，请重新载入后保存，避免覆盖已有修改')
        project = check_project({**old, **payload})
        server_fields = {'id', 'revision', 'version', 'createdAt', 'updatedAt', 'previewUrl', 'manualReview', 'reviewedJobRevision'}
        previous_content = {key: value for key, value in old.items() if key not in server_fields}
        updated_content = {key: value for key, value in project.items() if key not in server_fields}
        from surface_workflow import options_for_generation
        if options_for_generation(previous_content) == options_for_generation(updated_content):
            # Background visibility belongs to the workspace view, not to a new
            # generation revision. Preserve accepted results when toggling it.
            if old.get('surfaceOptions') != project.get('surfaceOptions'):
                old['surfaceOptions'] = project.get('surfaceOptions')
                write_json(DATA / 'projects' / safe_id(old['id']) / 'project.json', old)
            return {**old, 'previewUrl': f'/data/projects/{project_id}/preview.png'}
        # Every content revision needs a fresh result and a review associated with that result.
        project.pop('manualReview', None)
        project['reviewedJobRevision'] = None
        revision = old['revision'] + 1
        project.update(id=old['id'], revision=revision, version=revision, createdAt=old['createdAt'], updatedAt=now())
        folder = DATA / 'projects' / safe_id(project_id)
        write_json(folder / 'history' / f'revision-{revision:04d}.json', project)
        write_json(folder / 'project.json', project)
        preview(project)
    return {**project, 'previewUrl': f'/data/projects/{project_id}/preview.png'}


@app.get('/api/projects/{project_id}/history')
def project_history(project_id: str):
    get_project(project_id)
    return {'versions': [read_json(path) for path in sorted((DATA / 'projects' / project_id / 'history').glob('*.json'))]}


def prompt_for(item: dict) -> str:
    description = {
        'slash': 'localized thin slash tear in costume fabric, frayed cut edges, subtle damaged cloth threads',
        'blood': 'localized theatrical dark red blood stain painted onto costume fabric, irregular small fabric stain',
        'burn': 'localized scorched costume cloth, charcoal discoloration, brown singed fabric edge, soot texture',
    }[item['type']]
    return 'photo of a cosplay costume garment, same garment fabric and design, ' + description + ', preserve original costume silhouette and details, no body, no person'


def workflow(checkpoint: str, uploaded_name: str, item: dict, settings: dict, lora: dict | None = None) -> dict:
    graph = {
        '1': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': checkpoint}},
        '2': {'class_type': 'LoadImage', 'inputs': {'image': uploaded_name}},
        '3': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt_for(item), 'clip': ['1', 1]}},
        '4': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'human, body, face, wounds, naked, nudity, new clothing design, changed color, text, watermark, blurry', 'clip': ['1', 1]}},
        # Ordinary SD1.5 uses the intact source latent. Inpaint encoders erase masked source pixels,
        # which leaves gray blocks when a general checkpoint is sampled at a low editing strength.
        '5': {'class_type': 'VAEEncode', 'inputs': {'pixels': ['2', 0], 'vae': ['1', 2]}},
        '11': {'class_type': 'SetLatentNoiseMask', 'inputs': {'samples': ['5', 0], 'mask': ['2', 1]}},
        '6': {'class_type': 'KSampler', 'inputs': {'model': ['1', 0], 'positive': ['3', 0], 'negative': ['4', 0], 'latent_image': ['11', 0],
                'seed': settings['seed'], 'steps': settings['steps'], 'cfg': settings['cfg'], 'sampler_name': 'euler', 'scheduler': 'normal',
                'denoise': round(.20 + item['intensity'] * .35, 4)}},
        '7': {'class_type': 'VAEDecode', 'inputs': {'samples': ['6', 0], 'vae': ['1', 2]}},
        '8': {'class_type': 'ImageCompositeMasked', 'inputs': {'destination': ['2', 0], 'source': ['7', 0], 'x': 0, 'y': 0, 'resize_source': False, 'mask': ['2', 1]}},
        '9': {'class_type': 'SaveImage', 'inputs': {'images': ['8', 0], 'filename_prefix': 'relic_local_experiment'}},
    }
    if lora:
        graph['10'] = {'class_type': 'LoraLoader', 'inputs': {'model': ['1', 0], 'clip': ['1', 1],
            'lora_name': lora['comfyFile'], 'strength_model': .7, 'strength_clip': .7}}
        graph['3']['inputs']['clip'] = ['10', 1]
        graph['4']['inputs']['clip'] = ['10', 1]
        graph['6']['inputs']['model'] = ['10', 0]
    return graph


def update_job(job_id: str, **updates) -> dict:
    with LOCK:
        job = get_job(job_id)
        job.update(updates, updatedAt=now())
        write_json(DATA / 'jobs' / job_id / 'job.json', job)
        return job


def generate(job_id: str, project: dict, settings: dict, env: dict, loras: dict):
    folder = DATA / 'jobs' / job_id
    try:
        update_job(job_id, status='running', progress=.02, message='正在准备原图与保护区域')
        original = load_rgb(local_image(project))
        # SD1.5 processes at a practical resolution while the final image retains original pixels outside every mask.
        scale = min(1., 768 / max(original.size))
        working_size = tuple(max(64, int(dimension * scale) // 8 * 8) for dimension in original.size)
        current = original.copy()
        original.save(folder / 'original.png')
        write_json(folder / 'project.json', project)
        write_json(folder / 'configuration.json', {'mode': settings['mode'], 'settings': settings, 'environment': env,
                    'originalSize': list(original.size), 'workingSize': list(working_size), 'generatedBy': 'local_ComfyUI_SD15',
                    'pipeline': GENERATION_PIPELINE, 'intensityMeaning': '模型编辑程度，不代表物理损伤量',
                    'denoiseFormula': '0.20 + intensity * 0.35', 'sourceLatentPreserved': True,
                    'semanticVisualAI': False, 'source': '基础模型实验' if not loras else '逐区域专用模型生成'})
        combined_mask = Image.new('L', original.size)
        completed = []
        for index, item in enumerate(project['damageItems']):
            base_progress = index / len(project['damageItems'])
            update_job(job_id, progress=.04 + base_progress * .90, currentStep=index + 1,
                       message=f'正在生成第 {index + 1}/{len(project["damageItems"])} 处：{TYPES[item["type"]]}')
            step_folder = folder / f'step-{index + 1:02d}-{item["type"]}'
            step_folder.mkdir()
            current.save(step_folder / 'input.png')
            full_mask = mask_for(item, project['protectedRects'], original.size)
            full_mask.save(step_folder / 'mask.png')
            if not full_mask.getbbox():
                raise ValueError(f'第 {index + 1} 处区域完全被保护区覆盖，请调整位置')
            combined_mask = ImageChops.lighter(combined_mask, full_mask)
            work_image = current.resize(working_size, Image.Resampling.LANCZOS).convert('RGBA')
            work_mask = full_mask.resize(working_size, Image.Resampling.NEAREST)
            # Comfy LoadImage computes its mask from 1-alpha.
            work_image.putalpha(ImageOps.invert(work_mask))
            encoded = io.BytesIO()
            work_image.save(encoded, format='PNG')
            step_settings = {**settings, 'seed': (settings['seed'] + index) % (2 ** 63)}
            with comfy_client(30) as client:
                uploaded = client.post('/upload/image', files={'image': (f'{job_id}-{index}.png', encoded.getvalue(), 'image/png')}, data={'type': 'input', 'overwrite': 'false'})
                uploaded.raise_for_status()
                upload_result = uploaded.json()
                uploaded_name = ((upload_result.get('subfolder', '') + '/') if upload_result.get('subfolder') else '') + upload_result['name']
                graph = workflow(env['checkpoint'], uploaded_name, item, step_settings, loras.get(item['type']))
                write_json(step_folder / 'workflow.json', graph)
                submitted = client.post('/prompt', json={'prompt': graph, 'client_id': job_id})
                if submitted.status_code >= 400:
                    raise ValueError('本机生成服务拒绝工作流：' + submitted.text[:400])
                prompt_id = submitted.json()['prompt_id']
                write_json(step_folder / 'generation-source.json', {'promptId': prompt_id, 'service': COMFY_URL,
                           'checkpoint': env['checkpoint'], 'lora': loras.get(item['type']), 'settings': step_settings,
                           'pipeline': GENERATION_PIPELINE, 'denoise': graph['6']['inputs']['denoise'], 'generatedAt': now()})
                update_job(job_id, promptId=prompt_id)
                deadline = time.monotonic() + 900
                history_entry = None
                while time.monotonic() < deadline:
                    response = client.get('/history/' + prompt_id)
                    response.raise_for_status()
                    history_entry = response.json().get(prompt_id)
                    if history_entry:
                        state = history_entry.get('status', {})
                        if state.get('status_str') == 'error':
                            raise ValueError('本机生成失败：' + json.dumps(state.get('messages', []), ensure_ascii=False)[-500:])
                        if history_entry.get('outputs') or state.get('completed'):
                            break
                    time.sleep(1)
                else:
                    raise TimeoutError('本机图像生成超过 15 分钟；任务未提交重复请求，请检查本机服务')
                write_json(step_folder / 'history.json', history_entry)
                images = [image for output in history_entry.get('outputs', {}).values() for image in output.get('images', [])]
                if not images:
                    raise ValueError('本机服务完成了任务，但没有返回图像')
                output_meta = images[-1]
                downloaded = client.get('/view', params={key: output_meta[key] for key in ('filename', 'subfolder', 'type') if key in output_meta})
                downloaded.raise_for_status()
            generated = Image.open(io.BytesIO(downloaded.content)).convert('RGB')
            generated.save(step_folder / 'comfy-output.png')
            if generated.size != working_size:
                raise ValueError('本机服务输出尺寸与输入不一致，已停止组合')
            generated = generated.resize(original.size, Image.Resampling.LANCZOS)
            # A second exact composition makes every nonmasked original pixel invariant, including protected regions.
            current = Image.composite(generated, current, full_mask)
            current.save(step_folder / 'result.png')
            step_result = {'number': index + 1, 'damageId': item['id'], 'type': item['type'], 'status': 'succeeded',
                           'url': data_url(step_folder / 'result.png'), 'maskUrl': data_url(step_folder / 'mask.png'), 'promptId': prompt_id}
            completed.append(step_result)
            current.save(folder / 'latest.png')
            update_job(job_id, steps=completed, previewUrl=data_url(folder / 'latest.png'),
                       progress=.04 + (index + 1) / len(project['damageItems']) * .9,
                       message=f'第 {index + 1} 处已完成，已保留其余区域像素')
        final_path = folder / 'result.png'
        current.save(final_path)
        outside = ImageOps.invert(combined_mask)
        difference = ImageChops.difference(original, current)
        difference = Image.composite(difference, Image.new('RGB', original.size), outside)
        intact = difference.getbbox() is None
        validation = {'kind': 'pixel_protection', 'passed': intact, 'outsideMaskUnchanged': intact,
                      'protectedRegionsUnchanged': intact, 'semanticAI': False,
                      'message': '已检查：所有非生成区域（含保护区）像素与原图一致。角色还原与整体视觉需人工确认。',
                      'manualChecklist': project.get('qualityChecklist', {})}
        write_json(folder / 'validation.json', validation)
        write_json(folder / 'operation-guide.json', instructions(project))
        update_job(job_id, status='succeeded', progress=1., message='区域生成完成，请人工检查角色还原与整体视觉',
                   previewUrl=data_url(final_path), outputUrl=data_url(final_path), result={'url': data_url(final_path)},
                   validation=validation, completedAt=now())
    except Exception as exc:
        LOG.exception('Generation job failed: %s', job_id)
        message = exc.detail if isinstance(exc, HTTPException) else str(exc)
        update_job(job_id, status='failed', message='生成未完成：' + message[:600], error=message[:1000], completedAt=now())


def editable_union(project: dict, size: tuple[int, int]) -> Image.Image:
    combined = Image.new('L', size, 0)
    for item in project.get('damageItems', []):
        combined = ImageChops.lighter(combined, mask_for(item, project.get('protectedRects', []), size))
    if project.get('brushStrokes'):
        from brush_workflow import brush_mask
        combined = ImageChops.lighter(combined, brush_mask(project, size))
    return combined


def cloud_prompt(project: dict, kind: str = 'costume', provider: str = 'openai') -> str:
    scene = scenario_for(project)
    effects = []
    for index, item in enumerate(project.get('damageItems', []), 1):
        r = item['rect']
        location = '' if kind == 'concept' else f"位置：横向 {r['x']:.0%}–{r['x'] + r['w']:.0%}、纵向 {r['y']:.0%}–{r['y'] + r['h']:.0%}（第一张图左上为原点）。"
        defaults = {'blood': '干燥、暗红、哑光的戏剧假血飞溅，有主次和方向；不要湿亮液滴或长条流淌',
                    'slash': '清楚可见的织物割裂，合理的开口与短毛边；不要只增加一条浅线',
                    'burn': '深棕到灰黑的做旧色层与磨损边缘，保留衣服版型和接缝'}
        effects.append(f"{index}. {TYPES[item['type']]}，编辑程度 {item['intensity']:.0%}。{location}局部要求：{item.get('notes') or defaults[item['type']]}。")
    heading = ('编辑第一张真实 Cos 服装照片，在指定区域预览衣物战损与做旧。保持摄影风格与衣服原有结构。'
               if kind == 'costume' else '以第一张角色参考图为基础，生成服装战损设计的二维概念参考。保持角色身份、服装核心款式、标志与配件。')
    reference_note = ('第二张图（如果有）仅作服装痕迹与整体风格参考，不要将角色绘画的脸或体型替换到真实照片。'
                      if kind == 'costume' and project.get('conceptReference') else '')
    guidance = ''
    if kind == 'costume':
        guidance = ('只修改蒙版透明区域，保护区与其余部分保持原样。' if provider in cloud_provider.OPENAI_IMAGE_PROVIDERS
                    else '最后一张图是同一照片的区域规划标注，仅用来定位：编号框为可编辑范围，绿色框为保护区。不要画出框、文字或编号，只编辑第一张原图中指定衣服区域。')
        guidance += ' 如果原图有人，保留其身份、脸部、皮肤、姿态以及背景；不要在人体上添加伤口或流血，只呈现衣物表面的戏剧假血痕迹。'
    else:
        guidance = '概念图仅供选择视觉方向；不要把区域框位置照搬为真实衣服上的准确部位。人物原有身份、脸部与姿态保持一致，战损仅作用于服装，不在人体上增加伤口。'
    constraints = '避免改动徽标、原服装饰、腰带扣与其他用户要求保留的要素。优先尊重角色，不把衣服重新设计成完全不同款式。'
    return '\n'.join([heading, reference_note, guidance, constraints,
        '情境：' + str(scene.get('title') or '用户自主设定') + '。' + str(scene.get('summary') or scene.get('description') or '')[:1500],
        '用户补充：' + str(project.get('customDamageIdea') or '无')[:4000], *effects,
        '生成一张完整预览图，保留第一张图的构图、朝向和宽高比例，不输出拼图、操作步骤或文字。强度是视觉编辑程度，不是材料损伤量预测。'])


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def generate_cloud(job_id: str, project: dict, settings: dict, key: str, kind: str):
    folder = DATA / 'jobs' / job_id
    try:
        update_job(job_id, status='running', progress=.05, message='正在整理输入参考与编辑范围')
        source = local_reference(project['conceptReference']) if kind == 'concept' else local_image(project)
        original = load_rgb(source)
        working = original.copy()
        working.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
        original.save(folder / 'original.png')
        prompt = cloud_prompt(project, kind, settings['provider'])
        input_images = [png_bytes(working)]
        combined = None
        mask_data = None
        if kind == 'costume':
            combined = editable_union(project, original.size)
            if combined.getbbox() is None:
                raise cloud_provider.CloudError('可编辑范围全部被保护区覆盖，请调整选区。')
            combined.save(folder / 'mask.png')
            alpha = ImageOps.invert(combined.resize(working.size, Image.Resampling.NEAREST))
            mask_rgba = Image.new('RGBA', working.size, (255, 255, 255, 255))
            mask_rgba.putalpha(alpha)
            mask_data = png_bytes(mask_rgba)
            (folder / 'mask-transparent.png').write_bytes(mask_data)
            if project.get('conceptReference'):
                concept = load_rgb(local_reference(project['conceptReference']))
                concept.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
                input_images.append(png_bytes(concept))
            if settings['provider'] == 'qwen':
                annotated = load_rgb(preview(project))
                annotated.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
                input_images.append(png_bytes(annotated))
        configuration = {**settings, 'mode': 'cloud_concept_edit' if kind == 'concept' else 'cloud_image_edit',
            'pipeline': 'cloud_reference_image_edit_v1', 'artifactKind': kind, 'prompt': prompt,
            'inputImageCount': len(input_images), 'requestCount': 1, 'automaticRetry': False,
            'regionEditing': 'local_exact_composite' if kind == 'costume' else 'concept_full_image',
            'serverMask': settings['provider'] in cloud_provider.OPENAI_IMAGE_PROVIDERS and kind == 'costume', 'physicalSimulation': False}
        write_json(folder / 'configuration.json', configuration)
        write_json(folder / 'project-snapshot.json', project)
        update_job(job_id, progress=.15, message='图像接口正在处理；本次仅提交一个生成请求')
        content, metadata = cloud_provider.edit(input_images, prompt, mask_data if kind == 'costume' else None, settings, key)
        # Never persist returned remote URLs, signed query strings or authentication headers.
        write_json(folder / 'generation-source.json', {**metadata, 'generatedAt': now(),
            'pipeline': configuration['pipeline'], 'artifactKind': kind, 'physicalSimulation': False})
        try:
            with Image.open(io.BytesIO(content)) as decoded:
                if min(decoded.size) < 8 or decoded.width * decoded.height > Image.MAX_IMAGE_PIXELS:
                    raise ValueError()
                decoded.load()
                generated = decoded.convert('RGBA')
            background = Image.new('RGBA', generated.size, 'white')
            background.alpha_composite(generated)
            generated = background.convert('RGB')
        except (ValueError, OSError, Image.DecompressionBombError):
            raise cloud_provider.CloudError('接口返回的图像无效或尺寸超过平台限制，已停止保存结果。') from None
        generated.save(folder / 'api-output.png')
        update_job(job_id, progress=.85, message='正在保存结果并检查保护区域')
        if kind == 'costume':
            original_ratio = original.width / original.height
            if abs((generated.width / generated.height) / original_ratio - 1) > .05:
                raise cloud_provider.CloudError('接口改变了构图比例，无法可靠对齐选区。已保留原始输出供检查；未再次调用接口。')
            generated = generated.resize(original.size, Image.Resampling.LANCZOS)
            result = Image.composite(generated, original, combined)
            difference = ImageChops.difference(original, result)
            outside_difference = Image.composite(difference, Image.new('RGB', original.size), ImageOps.invert(combined))
            intact = outside_difference.getbbox() is None
            validation = {'kind': 'pixel_protection', 'passed': intact, 'outsideMaskUnchanged': intact,
                'protectedRegionsUnchanged': intact, 'semanticAI': False,
                'message': '本地合成已检查：非选区与保护区像素不变。框内衣物结构、人物重叠、痕迹自然度与衔接仍须人工检查。',
                'manualChecklist': project.get('qualityChecklist', {})}
            write_json(folder / 'operation-guide.json', instructions(project))
        else:
            result = generated
            validation = {'kind': 'concept_manual_review', 'passed': None, 'semanticAI': False,
                'message': '二维概念图已保存；未进行真实服装的像素保护或物理材料验证。请人工比较后明确采用。'}
        result.save(folder / 'result.png')
        write_json(folder / 'validation.json', validation)
        result_url = data_url(folder / 'result.png')
        extra = {'resultingReference': {'url': result_url, 'width': result.width, 'height': result.height,
                  'generated': True, 'jobId': job_id}} if kind == 'concept' else {}
        update_job(job_id, status='succeeded', progress=1., completedAt=now(), message='预览已完成，请人工检查并确认',
            outputUrl=result_url, previewUrl=result_url, result={'url': result_url}, validation=validation,
            provider=metadata['provider'], model=metadata['model'], quality=metadata['quality'], usage=metadata['usage'], **extra)
    except Exception as exc:
        # No exception repr/traceback/body: a provider error may contain credentials or signed URLs.
        LOG.warning('Cloud generation failed for %s (%s)', job_id, type(exc).__name__)
        safe_message = str(exc) if isinstance(exc, cloud_provider.CloudError) else '图像任务未完成。请检查图片、接口设置与服务商控制台；平台未自动重试。'
        update_job(job_id, status='failed', message=safe_message, error=safe_message, completedAt=now())


def create_cloud_job(project: dict, payload: dict, request: Request | None):
    require_local_origin(request)
    kind = 'concept' if payload['mode'] == 'cloud_concept_edit' else 'costume'
    try:
        settings, key = cloud_provider.credentials(payload.get('provider'))
    except (ValueError, cloud_provider.CloudError) as exc:
        raise HTTPException(422, str(exc)) from None
    # The secrets never enter the persisted job/configuration/project objects.
    settings = {name: settings[name] for name in ('provider', 'model', 'quality', 'region', 'workspaceId', 'baseUrl')}
    if kind == 'concept':
        if not project.get('conceptReference'):
            raise HTTPException(422, '请先上传并保存角色二维参考图')
        load_rgb(local_reference(project['conceptReference']))
    else:
        original = load_rgb(local_image(project))
        if editable_union(project, original.size).getbbox() is None:
            raise HTTPException(422, '可编辑范围全部被保护区覆盖，请调整选区')
    with LOCK:
        active = [read_json(path) for path in (DATA / 'jobs').glob('*/job.json')]
        if any(job and job.get('status') in ('queued', 'running') for job in active):
            raise HTTPException(409, '已有图像任务正在执行，请等待完成后再生成')
        latest = get_project(project['id'])
        if latest['revision'] != project['revision']:
            raise HTTPException(409, '方案版本已经变化，请刷新后再生成')
        job_id = 'job-' + uuid.uuid4().hex[:16]
        job = {'id': job_id, 'projectId': project['id'], 'projectRevision': project['revision'], 'mode': payload['mode'],
            'artifactKind': kind, 'provider': settings['provider'], 'model': settings['model'], 'quality': settings['quality'],
            'generatedBy': settings['provider'] + '_image_api', 'status': 'queued', 'progress': 0.,
            'message': '接口任务已排队', 'createdAt': now(), 'updatedAt': now(), 'steps': [],
            'validation': {'kind': 'concept_manual_review' if kind == 'concept' else 'pixel_protection', 'passed': None, 'semanticAI': False}}
        write_json(DATA / 'jobs' / job_id / 'job.json', job)
        EXECUTOR.submit(generate_cloud, job_id, copy.deepcopy(project), settings, key, kind)
    return job


@app.post('/api/projects/{project_id}/jobs')
def create_job(project_id: str, payload: dict | None = None, request: Request = None):
    payload = payload or {}
    project = get_project(project_id)
    if 'projectRevision' in payload and payload['projectRevision'] != project['revision']:
        raise HTTPException(409, '方案已经修改，请保存并刷新后再生成')
    if not project['damageItems'] and payload.get('mode') != 'cloud_concept_edit':
        raise HTTPException(422, '请先添加至少一个战损区域并保存')
    if payload.get('mode') in ('cloud_image_edit', 'cloud_concept_edit'):
        return create_cloud_job(project, payload, request)
    env = environment()
    if not env['base_model_available']:
        raise HTTPException(503, env['reason'])
    mode = payload.get('mode', 'base_experiment')
    if mode not in ('base_experiment', 'registered_lora'):
        raise HTTPException(422, '生成模式不受支持')
    try:
        settings = {'mode': mode, 'seed': int(payload.get('seed', int(time.time()) % (2 ** 31))),
                    'steps': int(payload.get('steps', 16)), 'cfg': float(payload.get('cfg', 6.5))}
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, '生成参数格式不正确') from exc
    if not 6 <= settings['steps'] <= 30 or not math.isfinite(settings['cfg']) or not 1 <= settings['cfg'] <= 12 or not 0 <= settings['seed'] < 2 ** 63:
        raise HTTPException(422, '步数须为 6–30，CFG 须为 1–12，随机种子须为有效非负整数')
    loras = {}
    if mode == 'registered_lora':
        selections = payload.get('modelSelections') or project.get('modelSelections', {})
        for damage_type in set(item['type'] for item in project['damageItems']):
            model_id = selections.get(damage_type)
            candidate = next((m for m in registered_models() if m.get('id') == model_id), None)
            if not candidate or (candidate.get('kind') or candidate.get('type')) != 'lora' or candidate.get('status') not in ('ready', 'trained', 'available'):
                raise HTTPException(422, f'{TYPES[damage_type]}专用模型尚未训练或未接入，请选择基础模型实验')
            if candidate.get('architecture') != 'sd15' or candidate.get('damageType') != damage_type:
                raise HTTPException(422, '专用模型架构或痕迹类型不兼容，已停止生成')
            source = candidate.get('file') or candidate.get('path')
            name = candidate.get('checkpointName') or candidate.get('checkpoint') or (Path(str(source)).name if source else '')
            if not source or not Path(str(source)).is_file() or name not in env.get('loraFiles', []):
                raise HTTPException(422, '专用模型文件未真实就绪，已停止生成')
            loras[damage_type] = {**candidate, 'comfyFile': name}
    local_image(project)
    with LOCK:
        active = [read_json(path) for path in (DATA / 'jobs').glob('*/job.json')]
        if any(j and j.get('status') in ('queued', 'running') for j in active):
            raise HTTPException(409, '已有图像任务正在执行，请等待完成后再生成')
        job_id = 'job-' + uuid.uuid4().hex[:16]
        job = {'id': job_id, 'projectId': project_id, 'projectRevision': project['revision'], 'mode': mode,
               'status': 'queued', 'progress': 0., 'message': '生成任务已排队', 'createdAt': now(), 'updatedAt': now(),
               'steps': [], 'validation': {'kind': 'pixel_protection', 'semanticAI': False, 'passed': None}}
        write_json(DATA / 'jobs' / job_id / 'job.json', job)
        EXECUTOR.submit(generate, job_id, copy.deepcopy(project), settings, env, loras)
    return job


@app.get('/api/jobs/{job_id}')
def api_get_job(job_id: str):
    return get_job(job_id)


@app.get('/api/projects/{project_id}/jobs')
def list_project_jobs(project_id: str):
    get_project(project_id)
    jobs = [read_json(path) for path in (DATA / 'jobs').glob('*/job.json')]
    return {'jobs': sorted((j for j in jobs if j and j.get('projectId') == project_id), key=lambda j: j.get('createdAt', ''), reverse=True)}


@app.post('/api/projects/{project_id}/review')
def save_manual_review(project_id: str, payload: dict):
    with LOCK:
        project = get_project(project_id)
        job = get_job(str(payload.get('jobId', '')))
        if job.get('projectId') != project_id or job.get('status') != 'succeeded' or job.get('artifactKind', 'costume') != 'costume':
            raise HTTPException(422, '只能确认本方案已完成的生成结果')
        if job.get('projectRevision') != project['revision'] or payload.get('projectRevision') != project['revision']:
            raise HTTPException(409, '方案已经修改；旧版本结果不能作为当前方案的人工确认')
        checklist = payload.get('qualityChecklist', {})
        if not isinstance(checklist, dict) or len(checklist) > 30 or any(not isinstance(value, bool) for value in checklist.values()):
            raise HTTPException(422, '人工检查项须为确认勾选状态')
        review = {'id': 'review-' + uuid.uuid4().hex[:16], 'projectId': project_id, 'projectRevision': project['revision'],
                  'jobId': job['id'], 'qualityChecklist': checklist, 'provider': 'human_review', 'semanticAI': False, 'createdAt': now()}
        write_json(DATA / 'projects' / project_id / 'reviews' / (review['id'] + '.json'), review)
        job['manualReview'] = review
        job['updatedAt'] = now()
        write_json(DATA / 'jobs' / job['id'] / 'job.json', job)
        project['manualReview'] = review
        write_json(DATA / 'projects' / project_id / 'project.json', project)
    return {'review': review, 'job': job}


def current_generation(project: dict) -> dict | None:
    candidates = [read_json(path) for path in (DATA / 'jobs').glob('*/job.json')]
    candidates = sorted((j for j in candidates if j and j.get('projectId') == project['id']
                         and j.get('projectRevision') == project['revision'] and j.get('status') == 'succeeded'
                         and j.get('artifactKind', 'costume') == 'costume'
                         and j.get('validation', {}).get('passed') is True),
                        key=lambda j: j.get('completedAt', j.get('createdAt', '')), reverse=True)
    for job in candidates:
        result_path = DATA / 'jobs' / safe_id(job['id']) / 'result.png'
        if result_path.is_file():
            return job
    return None


def current_concept_generation(project: dict) -> dict | None:
    candidates = [read_json(path) for path in (DATA / 'jobs').glob('*/job.json')]
    candidates = sorted((job for job in candidates if job and job.get('projectId') == project['id']
        and job.get('projectRevision') == project['revision'] and job.get('status') == 'succeeded'
        and job.get('artifactKind') == 'concept'), key=lambda job: job.get('completedAt', job.get('createdAt', '')), reverse=True)
    return next((job for job in candidates if (DATA / 'jobs' / safe_id(job['id']) / 'result.png').is_file()), None)


def job_label(job: dict) -> str:
    if job.get('mode') == 'manual_brush_import':
        return '画笔方案外部精修图导回（来源未核验）'
    if job.get('mode') == 'cloud_brush_refine':
        return '画笔引导 AI 精修结果'
    if job.get('mode') == 'manual_external_import':
        return '外部生成图导入（接口来源未核验）'
    if job.get('mode') in ('cloud_image_edit', 'cloud_concept_edit'):
        names = {'openai': 'GPT Image', 'qwen': '千问图像', 'openai_compatible': 'OpenAI 兼容中转', 'local_openai': '本机图像编辑服务'}
        return names.get(job.get('provider'), '云端图像') + '编辑结果'
    return '基础模型实验结果' if job.get('mode') == 'base_experiment' else '分区域专用模型结果'


def generation_receipt(project: dict) -> dict | None:
    job = current_generation(project)
    if not job:
        return None
    job_folder = DATA / 'jobs' / job['id']
    return {'jobId': job['id'], 'projectRevision': job['projectRevision'], 'mode': job['mode'],
            'label': job_label(job), 'artifactKind': job.get('artifactKind', 'costume'),
            'provider': job.get('provider', 'local_comfyui'), 'model': job.get('model'), 'usage': job.get('usage', {}),
            'generatedBy': job.get('generatedBy', 'local_ComfyUI_SD15'), 'completedAt': job.get('completedAt'),
            'resultUrl': data_url(job_folder / 'result.png'), 'resultDownloadUrl': f'/api/projects/{project["id"]}/exports/result',
            'configurationUrl': data_url(job_folder / 'configuration.json'), 'configuration': read_json(job_folder / 'configuration.json', {}),
            'steps': job.get('steps', []), 'validation': job.get('validation'), 'manualReview': job.get('manualReview'), 'semanticAI': False}


def export_html(project: dict) -> str:
    scene = scenario_for(project)
    guide = instructions(project)
    original = local_image(project)
    original_data = io.BytesIO()
    load_rgb(original).save(original_data, format='PNG')
    import base64
    original_uri = 'data:image/png;base64,' + base64.b64encode(original_data.getvalue()).decode('ascii')
    preview_path = preview(project)
    preview_uri = 'data:image/png;base64,' + base64.b64encode(preview_path.read_bytes()).decode('ascii')
    esc = lambda value: html.escape(str(value), quote=True)
    job = current_generation(project)
    result_section = ''
    if job:
        result_path = DATA / 'jobs' / job['id'] / 'result.png'
        result_uri = 'data:image/png;base64,' + base64.b64encode(result_path.read_bytes()).decode('ascii')
        result_label = job_label(job)
        result_section = f'<h2>当前版本预览图 · {esc(result_label)}</h2><figure><img src="{result_uri}" style="max-width:680px"><figcaption>生成或导入任务 {esc(job["id"])} · 第 {job["projectRevision"]} 版。像素保护检查通过；框内衣物结构、角色还原与痕迹质量由人工确认。</figcaption></figure>'
    material = project.get('material') or project.get('uploadMaterial') or garment_for(project).get('material') or '未知，需用户确认'
    reversible_value = project.get('reversibleRequired', True)
    reversible_note = ('可恢复要求尚未确定：先以可拆贴片做参考试样，确认是否需要恢复后再选择操作方式。' if reversible_value == 'unknown' else
        '要求可恢复：先在可拆贴片、补丁上制作效果，再固定到服装；不保证布用颜料可洗。' if reversible_value else
        '允许直接制作：先在废布做小样，确认面料与效果后再决定是否在原衣上操作。')
    sources_html = ''.join(f'<li><a href="{esc(s.get("url", ""))}">{esc(s.get("title", "剧情来源"))}</a> {esc(s.get("notes", ""))}</li>'
                           for s in scene.get('sources', []) if str(s.get('url', '')).startswith(('https://', 'http://')))
    rows_html = ''.join(f'<tr><td>{s["number"]}</td><td>{esc(s["label"])}</td><td>{esc(s["position"])}</td><td>{s["intensity"]:.0%}</td><td>{esc(s["method"])}<br>{esc(s["notes"])}</td></tr>' for s in guide)
    title = esc(project['title'])
    return f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>{title} · 位置操作单</title>
<style>body{{max-width:1080px;margin:40px auto;padding:0 24px;font:15px/1.8 Arial,"Microsoft YaHei",sans-serif;color:#24323b}}h1{{font-size:28px}}.muted{{color:#63727b}}.images{{display:flex;gap:20px}}figure{{flex:1;margin:0}}img{{max-width:100%;border:1px solid #e0e6e6;border-radius:12px}}table{{border-collapse:collapse;width:100%;margin:24px 0}}th,td{{border:1px solid #d8e0e0;padding:12px;text-align:left;vertical-align:top}}th{{background:#f1f5f4}}@media print{{body{{margin:16px;max-width:none}}a{{color:inherit}}}}@media(max-width:650px){{.images{{display:block}}table{{font-size:12px}}}}</style>
<h1>{title}</h1><p class="muted">方案 {esc(project['id'])} · 第 {project['revision']} 版 · 导出时间 {esc(now())}</p>
<p><strong>位置规划与制作建议。</strong>该操作单使用规则建议，绘制笔触与编号框是战损位置示意。图像生成结果仅在真实任务完成后另行保存。</p>
<p>剧情方向：{esc(scene.get('title', '自主设定战损'))}。具体痕迹与位置为服装推演，须由用户确认；自主设定仅调整战损。</p>
<div class="images"><figure><img src="{original_uri}"><figcaption>原始服装图</figcaption></figure><figure><img src="{preview_uri}"><figcaption>绘制引导与编号位置规划：割裂 / 血迹 / 磨损 / 焦痕；绿色框为保护区域</figcaption></figure></div>
{result_section}
<table><thead><tr><th>编号</th><th>痕迹</th><th>对应位置</th><th>模型编辑程度</th><th>规则制作建议</th></tr></thead><tbody>{rows_html}</tbody></table>
<p>编辑程度描述视觉修改意图，不代表衣物实际损伤量或制作时的物理尺度。图像效果、局部衔接与面料制作结果仍须人工和实样验证。</p>
<p><strong>面料待确认：</strong>{esc(material)}。先在废布做小样；确认正反面、透染、装饰与结构件保护范围后，再按编号执行。</p>
<p>{esc(reversible_note)}</p>
<p>自主战损说明：{esc(project.get('customDamageIdea') or '未填写')}</p>
<p>保护区域：{len(project['protectedRects'])} 处。整体视觉与角色还原由人工检查；语义视觉 AI 尚未接入。</p>
<h2>剧情来源</h2><ul>{sources_html or '<li>自主设定或尚无来源</li>'}</ul><p class="muted">来源支持剧情背景，不代表该具体刀痕、血迹或烧焦部位已经获得原作确认。</p></html>'''


@app.get('/api/projects/{project_id}/exports/{kind}')
def export(project_id: str, kind: str):
    project = get_project(project_id)
    if kind == 'original':
        path = local_image(project)
        return FileResponse(path, filename=f'{project_id}-original{path.suffix}')
    if kind == 'preview':
        path = preview(project)
        return FileResponse(path, media_type='image/png', filename=f'{project_id}-position-plan.png')
    if kind == 'result':
        job = current_generation(project)
        if not job:
            raise HTTPException(422, '当前方案版本尚无通过像素保护检查的生成结果；可先导出位置规划')
        return FileResponse(DATA / 'jobs' / job['id'] / 'result.png', media_type='image/png', filename=f'{project_id}-revision-{project["revision"]}-generated-result.png')
    if kind == 'concept':
        job = current_concept_generation(project)
        if not job:
            raise HTTPException(422, '当前版本尚无二维概念结果')
        return FileResponse(DATA / 'jobs' / job['id'] / 'result.png', media_type='image/png', filename=f'{project_id}-concept.png')
    if kind == 'json':
        result = {**project, 'schemaVersion': '0.1', 'suggestionProvider': 'local_scene_rules',
                  'operationGuide': instructions(project), 'scenarioSources': scenario_for(project).get('sources', []),
                  'generation': generation_receipt(project), 'semanticVisualAI': False}
        return Response(json.dumps(result, ensure_ascii=False, indent=2), media_type='application/json',
                        headers={'Content-Disposition': f'attachment; filename="{project_id}.json"'})
    if kind == 'html':
        return HTMLResponse(export_html(project), headers={'Content-Disposition': f'attachment; filename="{project_id}-guide.html"'})
    raise HTTPException(404, '不支持该导出类型')


@app.on_event('startup')
def recover_interrupted_jobs():
    for path in (DATA / 'jobs').glob('*/job.json'):
        job = read_json(path)
        if job and job.get('status') in ('queued', 'running'):
            job.update(status='interrupted', message='平台重启中断了任务；已有图像与配置已保留，接口可能已受理，请先检查记录再决定是否重新生成', updatedAt=now())
            write_json(path, job)


try:
    from manual_workflow import register_manual_routes
except ModuleNotFoundError as exc:
    if exc.name != 'manual_workflow':
        raise
else:
    register_manual_routes(app, sys.modules[__name__])

from quick_draft import register_draft_routes
register_draft_routes(app, sys.modules[__name__])
from brush_workflow import register_brush_routes
register_brush_routes(app, sys.modules[__name__])
from co_design import register_co_design_routes
register_co_design_routes(app, sys.modules[__name__])
local_models.register_local_model_routes(app, sys.modules[__name__])

from garment_mapping import register_mapping_routes
register_mapping_routes(app, sys.modules[__name__])
from surface_workflow import register_surface_routes
register_surface_routes(app, sys.modules[__name__])

from node_studio.routes import register_node_studio_routes
register_node_studio_routes(app, sys.modules[__name__])

from node_studio.garment_jobs import register_garment_job_routes
register_garment_job_routes(app, sys.modules[__name__])
from local_ai_runtime import register_local_ai_routes
register_local_ai_routes(app, sys.modules[__name__])
from local_image_runtime import register_local_image_routes
register_local_image_routes(app, sys.modules[__name__])

from node_studio.proximity import register_proximity_routes
register_proximity_routes(app, sys.modules[__name__])

from node_studio.character_research import register_character_research_routes
register_character_research_routes(app, sys.modules[__name__])

app.mount('/resources', StaticFiles(directory=RESOURCES), name='resources')
app.mount('/data', StaticFiles(directory=DATA), name='data')


@app.get('/')
def index():
    path = WEB / 'node-studio' / 'index.html'
    if path.is_file():
        return FileResponse(path)
    return HTMLResponse('<!doctype html><meta charset="utf-8"><title>战损方案工作台</title><p>平台服务已就绪，正在准备界面。</p>')


@app.get('/legacy')
def legacy_editor():
    """Existing algorithms keep their own UI lifecycle behind the node adapter."""
    return FileResponse(WEB / 'index.html')


app.mount('/web', StaticFiles(directory=WEB), name='web')
app.mount('/', StaticFiles(directory=WEB, html=True), name='frontend')
