"""Synthetic generation jobs through real routes; no model network or user assets."""
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
    import quick_draft
    from PIL import Image, ImageDraw
    calls = []
    core.cloud_provider._ACTIVE = 'openai_compatible'
    core.cloud_provider._SETTINGS['openai_compatible'].update(baseUrl='https://mock.invalid/v1', model='fixture-image', quality='auto', apiKey='fixture-not-a-real-key')

    def image_job(view, project_id, payload, request):
        project = core.get_project(project_id)
        identifier = 'job-autoversion-' + str(len(calls) + 1)
        calls.append({'jobId': identifier, 'provider': payload['provider'], 'reference': project['reference']['url'], 'prompt': project['customDamageIdea'], 'brushIds': [stroke['id'] for stroke in project.get('brushStrokes', [])]})
        job = {'id': identifier, 'projectId': project_id, 'status': 'queued', 'progress': 0, 'message': 'Fixture queued'}
        folder = core.DATA / 'jobs' / identifier
        core.write_json(folder / 'job.json', job)
        image = Image.new('RGB', (360, 540), '#d7d2c8')
        draw = ImageDraw.Draw(image)
        draw.polygon([(100, 80), (260, 80), (310, 210), (240, 220), (250, 480), (110, 480), (120, 220), (50, 210)], fill='#37515a')
        draw.ellipse((120, 220, 190, 300), fill='#87352f' if len(calls) % 2 else '#365d87')
        image.save(folder / 'result.png')
        return job

    quick_draft.create_draft_job = image_job

    @core.app.get('/api/test-generation/calls')
    def recorded_calls():
        return {'calls': calls}

    @core.app.post('/api/test-generation/finish/{job_id}')
    def finish(job_id: str, payload: dict):
        assert any(row['jobId'] == job_id for row in calls)
        path = core.DATA / 'jobs' / job_id / 'job.json'
        job = core.read_json(path)
        job.update(status=payload.get('status', 'succeeded'), progress=1, message='Fixture finished')
        if job['status'] == 'succeeded':
            job['outputUrl'] = f'/data/jobs/{job_id}/result.png'
        core.write_json(path, job)
        return job

    diagnostics = core.app.router.routes[-2:]
    del core.app.router.routes[-2:]
    core.app.router.routes[0:0] = diagnostics
    return core, calls, finish


def checks(core, calls, finish):
    from PIL import Image
    from check_node_studio_backend import LocalRouteClient, node
    folder = core.DATA / 'uploads' / 'fixture-generation'
    folder.mkdir(parents=True)
    Image.new('RGB', (64, 96), '#638184').save(folder / 'image.png')
    asset = {'id': folder.name, 'url': '/data/uploads/' + folder.name + '/image.png', 'width': 64, 'height': 96}
    client = LocalRouteClient(core.app)
    saved = client.post('/api/node-studio/workflows', json={'nodes': [node('input', 'garment_input', {'front': asset}), node('image', 'image_generate', {'intent': '少量飞溅'})], 'order': ['input', 'image']}).json()['workflow']
    def run(identifier, confirmed=False):
        nonlocal saved
        response = client.post(f"/api/node-studio/workflows/{saved['id']}/nodes/{identifier}/run", json={'expectedRevision': saved['revision'], 'confirmedExternal': confirmed})
        if response.status_code == 200:
            saved = response.json()['workflow']
        return response
    assert run('input').status_code == 200 and not calls
    assert run('image').status_code == 409 and not calls
    assert run('image', True).status_code == 200 and len(calls) == 1
    first = calls[0]['jobId']
    finish(first, {'status': 'succeeded'})
    output = copy.deepcopy(saved['nodes'][1]['output'])
    output.update(kind='garment', imageUrl=f'/data/jobs/{first}/result.png', jobStatus='succeeded')
    output.pop('jobId')
    output.pop('generationSource', None)
    output.pop('generationPreviousOutput', None)
    output['sourceBrushStrokes'] = [{'id': 'old-source'}]
    output['originalProjectSnapshot'] = {'id': 'old-snapshot', 'brushStrokes': [{'id': 'old-source'}]}
    saved['nodes'][1]['output'] = output
    saved['nodes'][1]['status'] = 'succeeded'
    marks = [{'id': 'new-source', 'type': 'blood', 'size': .05, 'opacity': .5, 'seed': 42, 'points': [{'x': .5, 'y': .5}], 'shapes': [{'kind': 'ellipse', 'cx': .5, 'cy': .5, 'rx': .03, 'ry': .03, 'color': '#880000', 'alpha': .5}]}]
    project = core.create_project({'title': 'Synthetic newly edited source', 'reference': asset, 'uploadId': asset['id'], 'brushStrokes': marks})
    source_snapshot = core.get_project(project['id'])
    saved['nodes'][0]['output'].update(projectId=project['id'], brushStrokes=marks, projectSnapshot=source_snapshot)
    saved = client.put(f"/api/node-studio/workflows/{saved['id']}", json={'expectedRevision': saved['revision'], 'workflow': saved}).json()['workflow']
    previous = saved['nodes'][1]['output']['imageUrl']
    assert run('image', True).status_code == 200 and len(calls) == 2
    assert saved['nodes'][1]['output']['imageUrl'] == previous
    assert calls[1]['reference'] == asset['url']
    pending = saved['nodes'][1]['output']
    assert calls[1]['brushIds'] == ['new-source']
    assert pending['sourceBrushStrokes'] == [{'id': 'old-source'}]
    assert pending['originalProjectSnapshot']['id'] == 'old-snapshot'
    assert pending['generationSource']['brushStrokes'][0]['id'] == 'new-source'
    assert pending['generationSource']['projectSnapshot']['id'] == project['id']
    assert pending['generationPreviousOutput']['sourceBrushStrokes'] == [{'id': 'old-source'}]
    assert pending['generationPreviousOutput']['originalProjectSnapshot']['id'] == 'old-snapshot'
    assert any(v['output']['imageUrl'] == previous for v in saved['nodes'][1]['versions'])
    finish(calls[-1]['jobId'], {'status': 'failed'})
    assert core.app.state.node_studio_store.get(saved['id'])['nodes'][1]['output']['imageUrl'] == previous
    print(json.dumps({'passed': True, 'checks': ['opening and unconfirmed request make no image call', 'one deliberate request submits one mock job', 'new attempt preserves current picture', 'previous output saved in version history', 'failure keeps displayed output', 'pending provenance captures actual new upstream marks while old output stays intact'], 'paidCalls': 0, 'userImagesUsed': False}, indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--data-dir', type=Path)
    parser.add_argument('--port', type=int, default=18016)
    args = parser.parse_args()
    if args.serve:
        assert args.data_dir
        core, calls, finish = application(args.data_dir)
        import uvicorn
        uvicorn.run(core.app, host='127.0.0.1', port=args.port, log_level='warning')
    else:
        parent = ROOT / 'work' / 'generation-results-check'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as scratch:
            checks(*application(Path(scratch)))
