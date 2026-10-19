"""Real asynchronous garment job boundary, stale-input and downstream checks."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tools'))
from fastapi import FastAPI
from PIL import Image, ImageChops
from check_node_studio_backend import LocalRouteClient, node
from node_studio.garment_jobs import register_garment_job_routes, get_job
from node_studio.routes import register_node_studio_routes
from node_studio.adapters import ensure_project


def main():
    import app as core
    checks = []
    with tempfile.TemporaryDirectory(prefix='garment-api-', dir=ROOT / 'work') as temporary:
        data = Path(temporary)
        upload = data / 'uploads/upload-test'
        upload.mkdir(parents=True)
        original_path = upload / 'image.png'
        Image.new('RGB', (180, 260), '#728a9b').save(original_path)
        original_bytes = original_path.read_bytes()
        asset = {'id': 'upload-test', 'url': '/data/uploads/upload-test/image.png', 'width': 180, 'height': 260}
        sample = {'schemaVersion': 1, 'title': 'Garment jobs test', 'nodes': [
            node('input', 'garment_input', {'front': asset}), node('split', 'garment_split'),
            node('flatten', 'garment_flatten'), node('edit', 'precision_edit')],
            'order': ['input', 'split', 'flatten', 'edit'], 'stash': [], 'selectedNodeId': 'input', 'assets': [asset], 'context': {}}
        polygon = [{'x': .25, 'y': .2}, {'x': .75, 'y': .2}, {'x': .75, 'y': .8}, {'x': .25, 'y': .8}]
        with patch.object(core, 'DATA', data):
            server = FastAPI()
            store = register_node_studio_routes(server, core)
            register_garment_job_routes(server, core)
            client = LocalRouteClient(server)
            saved = client.post('/api/node-studio/workflows', json={'workflow': sample}).json()['workflow']
            identifier = saved['id']
            def submit(operation='segment', params=None, target='split'):
                return client.post('/api/node-garments/jobs', json={'workflowId': identifier, 'nodeId': target,
                    'expectedRevision': saved['revision'], 'operation': operation,
                    'params': params or {'method': 'polygon', 'polygon': polygon}})
            def finished(response):
                assert response.status_code == 200, response.text
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    job = get_job(core, response.json()['id'])
                    if job['status'] not in {'queued', 'running'}:
                        assert job['status'] == 'completed', job
                        return job
                    time.sleep(.02)
                raise AssertionError('garment job did not complete')
            def adopt(job, target='split', **extra):
                nonlocal saved
                response = client.post(f'/api/node-studio/workflows/{identifier}/nodes/{target}/run',
                    json={'expectedRevision': saved['revision'], 'jobId': job['id'], **extra})
                if response.status_code == 200:
                    saved = response.json()['workflow']
                return response
            job = finished(submit())
            assert store.get(identifier) == saved
            checks.append('asynchronous processing creates candidate without changing node or workflow')
            adopted = adopt(job)
            assert adopted.status_code == 200, adopted.text
            output = adopted.json()['result']
            assert output['projectId'] is None and output['projectSnapshot'] is None
            assert output['brushStrokes'] == [] and output['editableStrokes'] is False
            path = data / output['imageUrl'].removeprefix('/data/')
            with Image.open(path) as image:
                assert image.size == (180, 260) and image.getpixel((0, 0))[3] == 0
                assert image.getpixel((90, 130))[3] == 255
            checks.append('adopted full-size part is genuinely transparent and explicitly raster-based')
            another = finished(submit(params={'method': 'polygon', 'name': '第二片', 'polygon': [
                {'x': .1, 'y': .1}, {'x': .4, 'y': .1}, {'x': .4, 'y': .4}, {'x': .1, 'y': .4}]}))
            second = adopt(another, crop=True)
            assert second.status_code == 200, second.text
            output = second.json()['result']
            assert len(output['parts']) == 2 and output['coordinateSpace'] == 'cropped_part'
            assert output['width'] < 180 and output['height'] < 260
            checks.append('multiple parts accumulate against one source; cropped result reports new dimensions')
            bad = adopt(another, partId='part-not-from-this-source')
            assert bad.status_code == 422
            pending = finished(submit())
            Image.new('RGB', (180, 260), 'red').save(original_path)
            assert adopt(pending).status_code == 409
            original_path.write_bytes(original_bytes)
            checks.append('changed source bytes and unrelated part identifiers cannot be adopted')
            # A changed brush document on the same reference URL must also stale
            # the candidate. Use the real renderer to detect duplicate painting.
            project = {'id': 'project-test', 'revision': 1, 'reference': asset, 'uploadId': 'upload-test',
                       'brushStrokes': [], 'damageItems': [], 'protectedRects': []}
            import brush_workflow
            project['brushStrokes'] = [{'id': 'blood-one', 'type': 'blood', 'size': .1, 'opacity': .5, 'seed': 42,
                'points': [{'x': .5, 'y': .5}], 'shapes': [{'kind': 'ellipse', 'cx': .5, 'cy': .5,
                    'rx': .1, 'ry': .12, 'color': '#880000', 'alpha': .5}]}]
            original_image = Image.open(original_path).convert('RGBA')
            _, paint = brush_workflow._raster(project, original_image.size, with_paint=True, source=original_image.convert('RGB'))
            expected_preview = original_image.copy(); expected_preview.alpha_composite(paint)
            expected_preview.save(data / 'already-painted-preview.png')
            editable = copy.deepcopy(sample)
            editable['nodes'].insert(1, node('paint', 'precision_edit', output={'kind': 'garment', 'imageUrl': '/data/already-painted-preview.png',
                                       'projectId': project['id'], 'imageSemantics': 'editable_preview'}))
            editable['order'].insert(1, 'paint')
            saved = store.create(editable); identifier = saved['id']
            with patch.object(core, 'get_project', lambda _id: copy.deepcopy(project)):
                pending = finished(submit())
                with Image.open(data / pending['inputImageUrl'].removeprefix('/data/')) as snapshot:
                    assert snapshot.convert('RGBA').tobytes() == expected_preview.tobytes()
                project['revision'] = 2
                assert adopt(pending).status_code == 409
            checks.append('editable preview rasterizes clean reference exactly once; same-image revision changes invalidate candidates')
            # The raster output must suppress a stale projectId inherited from a
            # previous edit node. No project lookup is permitted here.
            raster = copy.deepcopy(editable)
            raster['nodes'][1]['output'].update(imageSemantics='raster_base', rasterized=True, editableStrokes=False)
            saved = store.create(raster); identifier = saved['id']
            with patch.object(core, 'get_project', side_effect=AssertionError('raster must not reload old strokes')):
                pending = finished(submit())
                accepted = adopt(pending)
                assert accepted.status_code == 200, accepted.text
            checks.append('raster source never reuses inherited editable strokes')
            quad = [{'x': 0, 'y': 0}, {'x': 1, 'y': 0}, {'x': 1, 'y': 1}, {'x': 0, 'y': 1}]
            flat = finished(submit(operation='flatten', params={'method': 'geometry', 'quad': quad,
                                    'outputWidth': 180, 'outputHeight': 260}, target='flatten'))
            flat_adopted = adopt(flat, target='flatten')
            assert flat_adopted.status_code == 200, flat_adopted.text
            output = flat_adopted.json()['result']
            assert output['protectedRects'] == [] and output['view'] == 'flat_reference'
            assert output['exactGeometry'] is False and output['inferredHidden'] is False
            checks.append('independent flatten output explicitly changes coordinates without inventing hidden cloth')
            assert original_path.read_bytes() == original_bytes
            hostile = client.post('/api/node-garments/jobs', json={'workflowId': identifier}, headers={'origin': 'https://example.org'})
            assert hostile.status_code == 403
            checks.append('original remains immutable and remote-origin mutations are rejected')
    print(json.dumps({'status': 'passed', 'checks': checks}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
