"""Small, scoped dialogue memory for one assistant and its current host.

Only user/assistant text is retained. Connection configuration, image payloads,
tool arguments and results are never copied into the dialogue transcript.
"""
from __future__ import annotations

import re
import uuid

MAX_TURNS = 8
MAX_TEXT = 2200
MAX_HISTORY_CHARS = 14000
_TOKEN = re.compile(r'(?i)(?:sk-(?:proj-|svcacct-)?[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|bearer\s+[^\s,;"\']{8,})')


def clean_text(value, limit=MAX_TEXT, secrets=()):
    if not isinstance(value, str):
        return ''
    for secret in secrets:
        if isinstance(secret, str) and secret:
            value = value.replace(secret, '[已移除密钥]')
    return _TOKEN.sub('[已移除密钥]', value).strip()[:limit]


def read(output, scope):
    conversation = output.get('conversation') if isinstance(output, dict) else None
    if not isinstance(conversation, dict) or conversation.get('scope') != scope:
        return {'scope': scope.copy(), 'messages': []}
    messages = []
    entries = conversation.get('messages')
    if not isinstance(entries, list):
        entries = []
    for item in entries[-MAX_TURNS * 2:]:
        if not isinstance(item, dict) or item.get('role') not in {'user', 'assistant'}:
            continue
        text = clean_text(item.get('content'))
        if text:
            messages.append({'id': str(item.get('id') or uuid.uuid4().hex[:12])[:50],
                             'role': item['role'], 'content': text,
                             'state': item.get('state') if item.get('state') in {'applied','discussion','restored'} else 'discussion'})
    # Never send an orphan assistant response after trimming earlier exchanges.
    while messages and messages[0]['role'] != 'user':
        messages.pop(0)
    while sum(len(m['content']) for m in messages) > MAX_HISTORY_CHARS and len(messages) > 2:
        messages = messages[2:]
    return {'scope': scope.copy(), 'messages': messages}


def model_history(output, scope):
    return [{'role': m['role'], 'content': m['content']} for m in read(output, scope)['messages']]


def reply_text(result):
    parts = [result.get('message', '')]
    for key in ('items', 'suggestions', 'checks'):
        for item in result.get(key, [])[:8]:
            if isinstance(item, dict):
                parts.append('：'.join(str(item.get(k,'')) for k in ('label','title','value','detail') if item.get(k)))
    parts.extend(q for q in result.get('questions', [])[:5] if isinstance(q, str))
    if result.get('adopted'):
        parts.append('执行状态：修改已保存到当前服装方案，可切回历史版本')
    elif result.get('restored'):
        parts.append('执行状态：画面已切回历史版本')
    elif result.get('kind') in {'assistant_candidate','assistant_plan'}:
        parts.append('执行状态：这轮尚未改变服装方案')
    return '\n'.join(p for p in parts if p)


def append(output, scope, user_text, result, secrets=()):
    current = read(output, scope)
    state = 'applied' if result.get('adopted') else 'restored' if result.get('restored') else 'discussion'
    current['messages'].extend([
        {'id':uuid.uuid4().hex[:12], 'role':'user', 'content':clean_text(user_text, secrets=secrets), 'state':'discussion'},
        {'id':uuid.uuid4().hex[:12], 'role':'assistant', 'content':clean_text(reply_text(result), secrets=secrets), 'state':state},
    ])
    return read({'conversation':current}, scope)
