"""Real node API + mocked model transports; never reads user data or keys."""
from __future__ import annotations

import argparse
import copy
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def application(data):
    os.environ['RELIC_DATA_DIR'] = str(data)
    import app as core
    import co_design
    import quick_draft
    calls = []
    co_design._ACTIVE = 'local_openai'
    co_design._SETTINGS['local_openai'].update(baseUrl='http://127.0.0.1:18999/v1', model='mock-vision', vision=True, apiKey='')
    core.cloud_provider._ACTIVE = 'local_openai'
    core.cloud_provider._SETTINGS['local_openai'].update(baseUrl='http://127.0.0.1:18998/v1', model='mock-image', quality='auto', apiKey='')

    def assistant_transport(method, url, **kwargs):
        calls.append({'kind': 'assistant'})
        answer = {'message': '已经整理，可以继续调整', 'items': [
            {'label': '效果', 'value': '披风下摆少量绿色飞溅'}, {'label': '保留', 'value': '白色领巾保持干净'}]}
        return json.dumps({'choices': [{'message': {'content': json.dumps(answer, ensure_ascii=False)}}]}).encode(), {}

    def image_job(view, project_id, payload, request):
        project = core.get_project(project_id)
        calls.append({'kind': 'image', 'prompt': project['customDamageIdea'], 'reference': project['reference']['url'],
                      'provider': payload['provider'], 'projectId': project_id})
        job = {'id': 'job-text-mock-' + str(len(calls)), 'projectId': project_id, 'status': 'failed',
               'message': 'Mock transport captured the prompt; no image provider was contacted'}
        core.write_json(core.DATA / 'jobs' / job['id'] / 'job.json', job)
        return job

    co_design._request = assistant_transport
    quick_draft.create_draft_job = image_job

    @core.app.get('/api/test-text/calls')
    def recorded_calls():
        return {'calls': calls}

    # app.py ends in a catch-all static mount, so test diagnostics go before it.
    diagnostic_route = core.app.router.routes.pop()
    core.app.router.routes.insert(0, diagnostic_route)

    return core, calls


def checks(core, calls):
    from PIL import Image
    from check_node_studio_backend import LocalRouteClient, node
    from node_studio.store import validate_workflow
    from node_studio.text_inputs import text_input
    from node_studio.adapters import current_base
    folder = core.DATA / 'uploads' / 'upload-text-fixture'
    folder.mkdir(parents=True)
    Image.new('RGB', (64, 96), '#638184').save(folder / 'image.png')
    asset = {'id': folder.name, 'url': '/data/uploads/' + folder.name + '/image.png', 'width': 64, 'height': 96}
    flow = {'title': 'Text integration fixture', 'nodes': [node('input', 'garment_input', {'front': asset}),
            node('intent', 'intent_assist', {'intent': '绿色血迹，保留领巾'}), node('image', 'image_generate', {'intent': '袖口不要添加痕迹'})],
            'order': ['input', 'intent', 'image']}
    client = LocalRouteClient(core.app)
    saved = client.post('/api/node-studio/workflows', json=flow).json()['workflow']
    identifier = saved['id']

    def run(nid, params=None):
        nonlocal saved
        response = client.post(f'/api/node-studio/workflows/{identifier}/nodes/{nid}/run',
                               json={'expectedRevision': saved['revision'], 'params': params or {}})
        if response.status_code == 200:
            saved = response.json()['workflow']
        return response

    assert run('input').status_code == 200
    planned = run('intent')
    assert planned.status_code == 200, planned.text
    result = planned.json()['result']
    assert result['text'] == '效果：披风下摆少量绿色飞溅\n保留：白色领巾保持干净' and result['textVersionId']
    assert len(calls) == 1
    assert core.app.state.node_studio_store.get(identifier)['nodes'][1]['output']['text'] == result['text']
    generated = run('image')
    assert generated.status_code == 200, generated.text
    assert calls[-1]['provider'] == 'local_openai'  # blank node selection follows global
    assert result['text'] in calls[-1]['prompt'] and '袖口不要添加痕迹' in calls[-1]['prompt']
    assert calls[-1]['reference'] == asset['url']
    report = ['assistant produces persisted readable text', 'actual image job receives inherited text and extra requirements',
              'default image service follows global local connection without cloud consent', 'garment survives textual node']

    # Editing the output is a local save, with no model request.
    modified = copy.deepcopy(saved)
    modified['nodes'][1]['output']['text'] = '改为蓝色浸染，领巾留白'
    before = len(calls)
    response = client.put(f'/api/node-studio/workflows/{identifier}', json={'expectedRevision': saved['revision'], 'workflow': modified})
    assert response.status_code == 200, response.text
    saved = response.json()['workflow']
    assert saved['nodes'][2]['status'] == 'stale' and len(calls) == before
    assert run('image').status_code == 200
    assert '蓝色浸染' in calls[-1]['prompt'] and '袖口不要添加痕迹' in calls[-1]['prompt'] and '绿色飞溅' not in calls[-1]['prompt']
    report.append('editing saved output invalidates downstream and next explicit generation uses new text')

    # A draft edit is not an updated text artifact; block a stale saved plan.
    modified = copy.deepcopy(saved); modified['nodes'][1]['params']['intent'] = '尚未重新整理的新要求'
    saved = client.put(f'/api/node-studio/workflows/{identifier}', json={'expectedRevision': saved['revision'], 'workflow': modified}).json()['workflow']
    before = len(calls); denied = run('image')
    assert denied.status_code == 409 and len(calls) == before
    report.append('stale upstream text cannot silently submit a charged image request')

    attached = copy.deepcopy(saved)
    attached['order'] = ['input', 'image']; attached['nodes'][0]['attachments']['bottom'] = ['intent']
    attached['nodes'][1]['status'] = 'completed'
    image = attached['nodes'][2]
    assert text_input(attached, image)['sources'][0]['nodeId'] == 'intent'
    attached['nodes'][0]['attachments']['bottom'] = []
    image['attachments']['bottom'] = ['intent']
    assert text_input(attached, image)['text'] == '改为蓝色浸染，领巾留白'
    report.append('host-side and receiving-node-side assistants both supply text')

    branch = copy.deepcopy(attached)
    branch['nodes'][2]['attachments']['bottom'] = []
    branch['nodes'] += [node('input-b', 'garment_input', {'front': asset}), node('image-b', 'image_generate')]
    branch['routes'] = [{'id': 'island', 'label': '独立路线', 'order': ['input-b', 'intent', 'image-b'], 'x': 1, 'y': 2}]
    assert not text_input(branch, branch['nodes'][2])['text']
    assert text_input(branch, branch['nodes'][-1])['text'] == '改为蓝色浸染，领巾留白'
    report.append('independent image routes do not borrow text')

    forks = {'nodes': [node('input', 'garment_input', {'front': asset}), node('fork', 'branch_create'),
              node('merge', 'branch_merge', {'forkId': 'fork'}), node('plan-a', 'intent_assist', output={'kind': 'intent', 'text': '只属于A'}),
              node('gen-a', 'image_generate'), node('gen-b', 'image_generate')],
             'order': ['input', 'fork', 'merge'], 'branches': [{'id': 'a', 'forkId': 'fork', 'label': 'A', 'order': ['plan-a', 'gen-a']},
             {'id': 'b', 'forkId': 'fork', 'label': 'B', 'order': ['gen-b']}]}
    assert text_input(forks, forks['nodes'][-2])['text'] == '只属于A' and not text_input(forks, forks['nodes'][-1])['text']
    report.append('sibling branches do not borrow text')
    legacy = copy.deepcopy(attached); legacy['nodes'][1]['output'] = {'kind': 'intent', 'items': [{'label': '目标', 'value': '旧版整理'}]}
    assert text_input(legacy, legacy['nodes'][2])['text'] == '目标：旧版整理'
    report.append('legacy structured intent upgrades without rerunning a model')
    print(json.dumps({'passed': True, 'checks': report, 'paidCalls': 0, 'userImagesUsed': False}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--data-dir', type=Path)
    parser.add_argument('--port', type=int, default=18013)
    args = parser.parse_args()
    if args.serve:
        if not args.data_dir:
            raise SystemExit('--data-dir required for isolated browser fixture')
        core, calls = application(args.data_dir)
        import uvicorn
        uvicorn.run(core.app, host='127.0.0.1', port=args.port, log_level='warning')
    else:
        parent = ROOT / 'work' / 'text-flow-check'; parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as scratch:
            core, calls = application(Path(scratch))
            checks(core, calls)
