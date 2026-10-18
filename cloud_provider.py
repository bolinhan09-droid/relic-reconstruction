"""Optional image API adapters. Secrets live in memory; no automatic retries."""
from __future__ import annotations

import base64
import binascii
import ipaddress
import os
import re
import threading
from urllib.parse import urlparse

import httpx
import runtime_paths
from runtime_paths import loopback_url

PROVIDERS = {
    'openai': {'models': ['gpt-image-2', 'gpt-image-2-2026-04-21'], 'default': 'gpt-image-2',
               'qualities': ['low', 'medium', 'high', 'auto'], 'environment': 'OPENAI_API_KEY'},
    'qwen': {'models': ['qwen-image-3.0-pro', 'qwen-image-3.0', 'qwen-image-2.1-pro', 'qwen-image-2.1-turbo'],
             'default': 'qwen-image-3.0-pro', 'qualities': ['auto'], 'environment': 'DASHSCOPE_API_KEY'},
    'openai_compatible': {'models': [], 'default': 'gpt-image-2',
                         'qualities': ['low', 'medium', 'high', 'auto'], 'environment': None},
    'local_openai': {'models': [], 'default': '', 'qualities': ['auto'], 'environment': None},
}
OPENAI_IMAGE_PROVIDERS = ('openai', 'openai_compatible', 'local_openai')
REGIONS = ['cn-beijing', 'ap-southeast-1']
_LOCK = threading.RLock()
_ACTIVE = 'openai'
_SETTINGS = {name: {'model': item['default'], 'quality': 'medium' if name in OPENAI_IMAGE_PROVIDERS else 'auto',
                    'apiKey': '', 'baseUrl': '', 'region': 'cn-beijing', 'workspaceId': ''}
             for name, item in PROVIDERS.items()}
_SETTINGS['local_openai'].update(baseUrl='http://127.0.0.1:1234/v1', quality='auto')
MAX_RESULT_BYTES = 48 * 1024 * 1024


class CloudError(Exception):
    """Only safe, user-facing strings may be placed here."""


def _key(provider: str) -> tuple[str, str | None]:
    session_key = _SETTINGS[provider]['apiKey']
    if session_key:
        return session_key, 'session'
    environment_name = PROVIDERS[provider]['environment']
    environment_key = os.environ.get(environment_name, '').strip() if environment_name else ''
    return environment_key, 'environment' if environment_key else None


def _public(provider: str) -> dict:
    entry = _SETTINGS[provider]
    key, source = _key(provider)
    workspace = entry['workspaceId'] or os.environ.get('DASHSCOPE_WORKSPACE_ID', '') if provider == 'qwen' else ''
    ready = bool(entry['baseUrl'] and entry['model']) if provider == 'local_openai' else bool(key) and (provider != 'qwen' or bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,99}', workspace)))
    if provider == 'openai_compatible':
        ready = ready and bool(entry['baseUrl'])
    return {'provider': provider, 'model': entry['model'], 'quality': entry['quality'],
            'hasKey': bool(key), 'ready': ready, 'models': PROVIDERS[provider]['models'],
            'qualities': PROVIDERS[provider]['qualities'], 'keySource': source,
            'region': entry['region'] if provider == 'qwen' else None,
            'workspaceId': workspace, 'regions': REGIONS if provider == 'qwen' else [],
            'baseUrl': entry['baseUrl'] if provider in ('openai_compatible', 'local_openai') else ('https://api.openai.com/v1' if provider == 'openai' else ''),
            'maskSupport': provider in ('openai', 'local_openai'), 'imageEditingVerified': False,
            'localOnly': provider == 'local_openai', 'billing': 'local_runtime' if provider == 'local_openai' else 'separate_api',
            'reason': '' if ready else ('请在本机填写 API Key 和工作空间 ID' if provider == 'qwen'
                          else '请填写中转接口地址和该中转站的密钥' if provider == 'openai_compatible'
                          else '请填写已启动的本机图像编辑地址和模型名称；聊天模型不等于图像编辑模型' if provider == 'local_openai' else '请在本机填写 API Key')}


def public_settings() -> dict:
    with _LOCK:
        return {**_public(_ACTIVE), 'providers': {name: _public(name) for name in PROVIDERS}}


def validate_base_url(value: object) -> str:
    if not isinstance(value, str) or len(value) > 500:
        raise ValueError('请填写有效的 HTTPS 中转接口地址，例如 https://api.example.com/v1')
    value = value.strip().rstrip('/')
    try:
        parsed = urlparse(value)
        host = parsed.hostname or ''
        if (parsed.scheme != 'https' or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.port not in (None, 443) or not re.fullmatch(r'[A-Za-z0-9.-]+', host)
                or '.' not in host or host.endswith('.') or any(len(label) > 63 or not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?', label) for label in host.split('.'))
                or host.lower().endswith(('.localhost', '.local', '.internal', '.lan'))
                or not re.fullmatch(r'(?:/[A-Za-z0-9._~-]+)*', parsed.path)
                or any(part in ('.', '..') for part in parsed.path.split('/'))):
            raise ValueError()
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None and not address.is_global:
            raise ValueError()
        if parsed.path.endswith(('/responses', '/chat/completions', '/images/edits', '/models')):
            raise ValueError()
    except ValueError:
        raise ValueError('中转地址须为公网 HTTPS API 根地址（通常包含 /v1），不能包含密钥、参数或具体请求路径。') from None
    return parsed._replace(netloc=host.lower()).geturl()


def _candidate(payload: dict) -> tuple[str, dict]:
    provider = payload.get('provider', _ACTIVE)
    if not isinstance(provider, str) or provider not in PROVIDERS:
        raise ValueError('请选择受支持的云端或本机图像编辑接口')
    entry = dict(_SETTINGS[provider])
    model = payload.get('model', entry['model'])
    quality = payload.get('quality', entry['quality'])
    if provider in ('qwen', 'local_openai') and quality in ('low', 'medium', 'high'):
        quality = 'auto'
    allowed_model = (isinstance(model, str) and bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}', model))) if provider in ('openai_compatible', 'local_openai') else model in PROVIDERS[provider]['models']
    if not allowed_model or quality not in PROVIDERS[provider]['qualities']:
        raise ValueError('所选接口不支持该模型或质量设置；中转图像模型名称请按服务商文档填写')
    if provider in ('openai_compatible', 'local_openai'):
        validator = loopback_url if provider == 'local_openai' else validate_base_url
        base_url = validator(payload.get('baseUrl', entry['baseUrl']))
        if base_url != entry['baseUrl']:
            # A credential is scoped to its chosen endpoint. Never silently reuse it on another host/path.
            entry['apiKey'] = ''
        entry['baseUrl'] = base_url
    if 'apiKey' in payload:
        key = payload['apiKey']
        if not isinstance(key, str) or len(key) > 1024 or any(ord(c) < 33 or ord(c) > 126 for c in key):
            raise ValueError('API Key 格式不正确；请勿粘贴空格或换行')
        entry['apiKey'] = key
    if provider == 'qwen':
        region = payload.get('region', entry['region'])
        workspace = payload.get('workspaceId', entry['workspaceId'])
        if region not in REGIONS or not isinstance(workspace, str) or (workspace and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,99}', workspace)):
            raise ValueError('千问地区或工作空间 ID 格式不正确')
        entry.update(region=region, workspaceId=workspace)
    entry.update(model=model, quality=quality)
    return provider, entry


def configure(payload: dict) -> dict:
    global _ACTIVE
    with _LOCK:
        provider, entry = _candidate(payload)
        local = entry if provider == 'local_openai' else _SETTINGS['local_openai']
        runtime_paths.write_local_options('local-image.json', {
            'baseUrl': local['baseUrl'], 'model': local['model'], 'quality': 'auto', 'selected': provider == 'local_openai'})
        _SETTINGS[provider] = entry
        _ACTIVE = provider
        return public_settings()


def clear_key(provider: str | None = None) -> dict:
    with _LOCK:
        name = provider or _ACTIVE
        if name not in PROVIDERS:
            raise ValueError('接口名称不受支持')
        _SETTINGS[name]['apiKey'] = ''
        return public_settings()


def credentials(provider: str | None = None) -> tuple[dict, str]:
    with _LOCK:
        name = provider or _ACTIVE
        if name not in PROVIDERS:
            raise ValueError('接口名称不受支持')
        state = _public(name)
        if not state['ready']:
            raise CloudError(state['reason'])
        key, _ = _key(name)
        return state, key


def cloud_client() -> httpx.Client:
    # No SDK retries; an uncertain paid request must not be resubmitted automatically.
    return httpx.Client(timeout=httpx.Timeout(600, connect=20, write=60, pool=20), follow_redirects=False, trust_env=False)


def safe_usage(value: object) -> dict:
    if not isinstance(value, dict):
        return {}
    allowed = {'input_tokens', 'output_tokens', 'total_tokens', 'text_tokens', 'image_tokens',
               'output_width', 'output_height', 'input_image_count', 'output_image_count', 'image_count', 'width', 'height'}
    return {name: number for name, number in value.items() if name in allowed
            and isinstance(number, (int, float)) and not isinstance(number, bool) and 0 <= number <= 10 ** 10}


def _request_id(response: httpx.Response) -> str | None:
    value = response.headers.get('x-request-id', '')
    return value if re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value) else None


def _check_status(response: httpx.Response, service: str = '图像接口') -> None:
    if response.status_code >= 300:
        safe_messages = {401: '认证失败，请确认密钥属于该接口地址，且仍有效。中转站密钥不能用于 OpenAI 官方地址。', 403: '该账户没有此接口或模型的调用权限。',
                         429: '接口额度不足或请求过于频繁，请在服务商控制台检查。',
                         400: '接口拒绝了图像或参数，请检查素材和模型是否支持。',
                         404: '未找到请求接口，请确认 API 根地址和服务商是否支持该接口。',
                         405: '该服务不接受此请求方式，请确认是否支持图像编辑接口。'}
        message = safe_messages.get(response.status_code, '请求未成功。未自动重试，请检查服务商控制台。')
        raise CloudError(f'{service}（HTTP {response.status_code}）：{message}')


def _check_response(response: httpx.Response, service: str = '图像接口') -> dict:
    _check_status(response, service)
    try:
        body = response.json()
        if not isinstance(body, dict) or not isinstance(body.get('data'), list) or not body['data']:
            raise ValueError()
        return body
    except (ValueError, TypeError):
        raise CloudError('接口没有返回有效图像。未自动重试，请检查服务商控制台。') from None


def check_connection(payload: dict) -> dict:
    """Read available model IDs only. Do not save settings, upload photos, or submit generation."""
    with _LOCK:
        provider, entry = _candidate(payload)
        environment_name = PROVIDERS[provider]['environment']
        key = entry['apiKey'] or (os.environ.get(environment_name, '').strip() if environment_name else '')
    if provider == 'qwen':
        return {'ok': False, 'authenticated': None, 'modelIds': [], 'imageCandidates': [],
                'imageEditingVerified': False, 'message': '千问工作空间接口暂不提供本平台的模型列表检查；保存设置不代表生图已验证。'}
    if not key and provider != 'local_openai':
        raise CloudError('请先填写该服务的 API 密钥；改中转地址后需要重新填写对应密钥。')
    base_url = entry['baseUrl'] if provider in ('openai_compatible', 'local_openai') else 'https://api.openai.com/v1'
    service = urlparse(base_url).hostname or '所选服务'
    try:
        with cloud_client() as client:
            response = client.get(base_url + '/models', headers={'Authorization': 'Bearer ' + key} if key else {}, timeout=25)
            _check_status(response, service)
            if len(response.content) > 2 * 1024 * 1024:
                raise CloudError('模型列表超过读取限制。未提交生图。')
            try:
                body = response.json()
                rows = body.get('data') if isinstance(body, dict) else None
                if not isinstance(rows, list):
                    raise ValueError()
                model_ids = list(dict.fromkeys(row['id'] for row in rows[:2000] if isinstance(row, dict)
                    and isinstance(row.get('id'), str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}', row['id'])))
            except (ValueError, TypeError):
                raise CloudError('地址可访问，但未返回兼容的模型列表，不能据此确认密钥或图像编辑可用。') from None
    except httpx.TimeoutException:
        raise CloudError('模型列表检查超时。未提交生图，请检查地址或网络。') from None
    except httpx.HTTPError:
        raise CloudError('模型列表检查连接失败。未提交生图，请检查地址或网络。') from None
    image_candidates = [name for name in model_ids if re.search(r'image|dall-e|flux|wanx', name, re.I)]
    listed = entry['model'] in model_ids
    message = f'{service} 的本机模型列表读取成功，未上传图片或验证图像编辑。' if provider == 'local_openai' else f'{service} 的模型列表读取成功，密钥被该请求接受。'
    if not listed:
        message += f' 当前填写的 {entry["model"]} 不在返回列表中。'
    message += ('发现可能的图像模型，可按服务商说明选择。' if image_candidates
                else '未发现名称可识别的图像模型；请向服务商确认是否提供图像编辑或使用了其他模型别名。')
    message += '此检查不验证 /images/edits、蒙版或实际生图能力，也没有提交生成请求。'
    return {'ok': True, 'authenticated': bool(key) if provider == 'local_openai' else True, 'modelIds': model_ids, 'imageCandidates': image_candidates,
            'modelListed': listed, 'imageEditingVerified': False, 'message': message}


def _download_qwen(client: httpx.Client, url: str) -> bytes:
    parsed = urlparse(url)
    # Only official result buckets. Reject local hosts, custom ports and redirects.
    if (parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443)
            or not re.fullmatch(r'dashscope-result[-a-z0-9]*\.oss[-a-z0-9]*\.aliyuncs\.com', parsed.hostname or '')):
        raise CloudError('接口返回的图像下载地址不在允许的官方结果域名内。')
    # New request, deliberately without the API Authorization header.
    with client.stream('GET', url) as response:
        if response.status_code != 200:
            raise CloudError('接口已完成，但图像下载失败；未重复生成，请先检查任务记录。')
        chunks, total = [], 0
        for chunk in response.iter_bytes():
            total += len(chunk)
            if total > MAX_RESULT_BYTES:
                raise CloudError('接口图像超过平台大小限制。')
            chunks.append(chunk)
        return b''.join(chunks)


def edit(images: list[bytes], prompt: str, mask: bytes | None, settings: dict, key: str) -> tuple[bytes, dict]:
    provider = settings['provider']
    try:
        with cloud_client() as client:
            if provider in OPENAI_IMAGE_PROVIDERS:
                base_url = loopback_url(settings.get('baseUrl', '')) if provider == 'local_openai' else validate_base_url(settings.get('baseUrl', '')) if provider == 'openai_compatible' else 'https://api.openai.com/v1'
                service = urlparse(base_url).hostname or '所选服务'
                files = [('image[]', (f'image-{index + 1}.png', data, 'image/png')) for index, data in enumerate(images)]
                if mask is not None:
                    files.append(('mask', ('mask.png', mask, 'image/png')))
                fields = {'model': settings['model'], 'prompt': prompt, 'n': '1', 'output_format': 'png'}
                # Local image servers such as stable-diffusion.cpp don't accept
                # the cloud-only quality/size:auto parameters. Omitting size
                # keeps the decoded first-image geometry under that protocol.
                if provider != 'local_openai':
                    fields.update(quality=settings['quality'], size='auto')
                response = client.post(base_url + '/images/edits',
                    headers={'Authorization': 'Bearer ' + key} if key else {}, files=files, data=fields)
                body = _check_response(response, service)
                encoded = body['data'][0].get('b64_json', '')
                if not isinstance(encoded, str) or not encoded or len(encoded) > MAX_RESULT_BYTES * 1.4:
                    raise CloudError('接口没有返回平台可读取的 Base64 图像。该接入方式要求 /images/edits 返回 data[].b64_json；聊天专用接口不能直接用于服装编辑。')
                try:
                    data = base64.b64decode(encoded, validate=True)
                except (ValueError, binascii.Error):
                    raise CloudError('接口返回的图像编码无效。') from None
            elif provider == 'qwen':
                limit = 3 if settings['model'].startswith('qwen-image-3.0') else 10
                if not 1 <= len(images) <= limit or any(len(image) > 10 * 1024 * 1024 for image in images):
                    raise CloudError('千问输入图片数量或大小超出模型限制。')
                image_values = ['data:image/png;base64,' + base64.b64encode(data).decode('ascii') for data in images]
                endpoint = f"https://{settings['workspaceId']}.{settings['region']}.maas.aliyuncs.com/compatible-mode/v1/images/generations"
                response = client.post(endpoint, headers={'Authorization': 'Bearer ' + key},
                    json={'model': settings['model'], 'prompt': prompt, 'image': image_values if len(image_values) > 1 else image_values[0],
                          'n': 1, 'size': 'auto', 'prompt_extend': False, 'watermark': False})
                body = _check_response(response)
                url = body['data'][0].get('url')
                if not isinstance(url, str):
                    raise CloudError('千问接口没有返回有效图像地址。')
                data = _download_qwen(client, url)
            else:
                raise CloudError('图像接口不受支持。')
            metadata = {'provider': provider, 'model': settings['model'], 'quality': settings['quality'],
                        'requestId': _request_id(response), 'usage': safe_usage(body.get('usage', {})),
                        'requestCount': 1, 'serverMask': provider in OPENAI_IMAGE_PROVIDERS and mask is not None}
            if provider in ('openai_compatible', 'local_openai'):
                metadata['baseUrl'] = base_url
            if provider == 'local_openai':
                metadata.update(localOnly=True, billing='local_runtime', imageEditingVerified=False)
            return data, metadata
    except httpx.TimeoutException:
        raise CloudError('接口请求超时，可能已计费；平台未自动重试。请先检查服务商控制台再决定是否重新生成。') from None
    except httpx.HTTPError:
        raise CloudError('接口连接中断，可能已受理；平台未自动重试。请先检查服务商控制台。') from None


def _restore_local_options():
    global _ACTIVE
    saved = runtime_paths.read_local_options('local-image.json')
    if not saved:
        return
    try:
        if not isinstance(saved.get('selected'), bool):
            return
        if saved.get('model'):
            _, entry = _candidate({'provider': 'local_openai', 'baseUrl': saved.get('baseUrl'), 'model': saved.get('model'), 'quality': 'auto'})
            entry['apiKey'] = ''
            _SETTINGS['local_openai'] = entry
            if saved['selected']:
                _ACTIVE = 'local_openai'
    except (ValueError, TypeError):
        pass


_restore_local_options()
