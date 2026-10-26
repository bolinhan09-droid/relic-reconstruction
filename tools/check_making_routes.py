"""Isolated making-node HTTP boundary checks with synthetic garment artifacts.

Uses real mapping, workflow storage, inspection and execution handlers. No
personal photographs, network, model calls, or existing projects are used.
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tools'))

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from PIL import Image

from check_node_studio_backend import LocalRouteClient, node
from garment_mapping import create_mapping, source_bundle
from node_studio.routes import register_node_studio_routes


def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_fixture(core, data):
    """Create an isolated synthetic real mapping; caller sets core.DATA first.

    Returns workflow, project, mapping, assets and control points for API/browser
    tests. Existing upload-source/upload-flat paths are intentionally rejected.
    """
    data = Path(data)
    assert Path(core.DATA).resolve() == data.resolve(), 'Set isolated core.DATA before building fixture'
    assets = {}
    for name, color in (('source', '#bcc4c6'), ('flat', '#e5e0cf')):
        path = data / 'uploads' / ('upload-' + name) / 'image.png'
        path.parent.mkdir(parents=True)
        Image.new('RGB', (180, 240), color).save(path)
        assets[name] = {'id': 'upload-' + name, 'url': '/data/uploads/upload-' + name + '/image.png',
                        'width': 180, 'height': 240, 'uploaded': True}
    strokes = [
        {'id': 'contact-blood', 'type': 'blood', 'effectSubtype': 'contact', 'size': .1,
         'opacity': .8, 'seed': 41, 'points': [{'x': .32, 'y': .4}], 'shapes': [
             {'kind': 'ellipse', 'cx': .32, 'cy': .4, 'rx': .1, 'ry': .08, 'color': '#842e24', 'alpha': .8}]},
        {'id': 'burn-area', 'type': 'burn', 'size': .1, 'opacity': .6, 'seed': 42,
         'points': [{'x': .68, 'y': .65}], 'shapes': [
             {'kind': 'ellipse', 'cx': .68, 'cy': .65, 'rx': .09, 'ry': .11, 'color': '#342b29', 'alpha': .6}]},
    ]
    project = {'id': 'project-making-fixture', 'revision': 1, 'reference': assets['source'],
               'brushStrokes': strokes, 'damageItems': [], 'protectedRects': []}
    points = [{'x': x, 'y': y} for x, y in ((0., 0.), (1., 0.), (1., 1.), (0., 1.))]
    project_path = data / 'projects' / project['id'] / 'project.json'
    core.write_json(project_path, project)
    mapping = json.loads(json.dumps(create_mapping(core, project, {'revision': 1, 'sourceMode': 'brush',
        'targetUploadId': assets['flat']['id'], 'componentName': '合成领巾',
        'sourcePoints': points, 'targetPoints': points,
        'sourceBoundary': points, 'targetBoundary': points, 'physicalWidthCm': 18})))
    source_output = {'kind': 'garment', 'imageUrl': mapping['resultUrl'], 'coordinateSpace': 'flatlay',
        'artifactKind': 'observed_mapping', 'mapping': mapping, 'mappingSourceProject': project,
        'effectLayerUrl': mapping['effectLayerUrl'], 'imageSemantics': 'raster_base',
        'editableStrokes': False, 'brushStrokes': [], 'projectId': project['id'], 'revision': 1}
    settings = {'sourceMappingId': mapping['id'], 'flatConfirmed': True, 'scaleConfirmed': True,
                'widthMm': 180, 'heightMm': 240, 'minFeatureMm': 2, 'bridgeMm': 2,
                'material': 'unknown', 'side': 'front'}
    sample = {'schemaVersion': 1, 'title': '制作节点隔离验证', 'nodes': [
        node('input', 'garment_input', {'front': assets['source']}),
        node('paint', 'precision_edit', output={'kind': 'garment', 'imageUrl': mapping['source']['sourceGuideUrl'],
             'projectId': project['id'], 'projectSnapshot': project, 'imageSemantics': 'editable_preview'}),
        node('mapped', 'flatten_map', output=source_output),
        node('make', 'stencil_export', settings)],
        'order': ['input', 'paint', 'mapped', 'make'], 'stash': [], 'context': {}, 'assets': [assets['source']]}
    for entry in sample['nodes']:
        if entry['output']: entry['status'] = 'succeeded'
    return {'workflow': sample, 'project': project, 'mapping': mapping, 'assets': assets, 'points': points}


def main():
    import app as core

    checks = []
    scratch_parent = ROOT / 'work' / 'making-route-checks'
    scratch_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='synthetic-', dir=scratch_parent) as temporary:
        data = Path(temporary)
        with patch.object(core, 'DATA', data):
            fixture = build_fixture(core, data)
            sample, project, mapping, assets, points = (fixture[key] for key in ('workflow', 'project', 'mapping', 'assets', 'points'))
            server = FastAPI()
            store = register_node_studio_routes(server, core)
            client = LocalRouteClient(server)

            def create(value=None):
                result = client.post('/api/node-studio/workflows', json={'workflow': value or sample})
                assert result.status_code == 200, result.text
                return result.json()['workflow']

            def inspect(saved, nid='make'):
                return client._request('GET', f'/api/node-studio/workflows/{saved["id"]}/nodes/{nid}/making-input')

            def run(saved, nid='make', **payload):
                return client.post(f'/api/node-studio/workflows/{saved["id"]}/nodes/{nid}/run',
                                   json={'expectedRevision': saved['revision'], **payload})

            def blocked(value, status=422):
                saved = create(value)
                result = run(saved)
                assert result.status_code == status, result.text
                assert store.get(saved['id']) == saved, 'Rejected operation modified workflow'
                return saved

            immutable = {path: file_hash(path) for name in ('uploads', 'projects') for path in (data/name).rglob('*') if path.is_file()}
            saved = create()
            status = inspect(saved)
            assert status.status_code == 200 and status.json()['ready'], status.text
            assert status.json()['sourceNodeId'] == 'mapped'
            assert status.json()['source']['mappingId'] == mapping['id']
            assert status.json()['source']['strokeCount'] == 2
            assert store.get(saved['id']) == saved
            checks.append('inspection reads real saved mapping and brush groups without modifying workflow')

            generated = run(saved)
            assert generated.status_code == 200, generated.text
            body = generated.json()
            kit = body['result']
            assert kit['kind'] == 'making_kit' and kit['sourceNodeId'] == 'mapped'
            assert kit['mappingId'] == mapping['id']
            assert kit['semanticAI'] is False and kit['apiRequest'] is False
            assert len(kit['parts']) == 1 and len(kit['parts'][0]['effects']) == 2
            assert kit['stages'] and all(stage['actions'] and stage['checkpoint'] for stage in kit['stages'])
            saved_after = body['workflow']
            assert saved_after['revision'] == saved['revision'] + 1
            assert next(n for n in saved_after['nodes'] if n['id'] == 'make')['output'] == kit
            checks.append('run persists one coherent kit with part-effect-step hierarchy and provenance')

            # Exercise the same StaticFiles path resolver used by /data, then
            # read the archive bytes. This does not claim a browser download.
            static = StaticFiles(directory=data)
            download = kit['downloadUrl']
            assert download.startswith('/data/')
            path, stat = static.lookup_path(download[len('/data/'):])
            archive_path = Path(path)
            assert stat and archive_path.resolve().is_relative_to(data.resolve())
            with zipfile.ZipFile(archive_path) as archive:
                assert archive.testzip() is None
                names = archive.namelist()
                assert 'manifest.json' in names and any(name.endswith('.html') for name in names)
                assert any(name.endswith('.svg') for name in names) and any(name.endswith('.dxf') for name in names)
                assert all(not Path(name).is_absolute() and '..' not in Path(name).parts for name in names)
                manifest = json.loads(archive.read('manifest.json'))
                assert manifest['mappingId'] == mapping['id'] and len(manifest['stages']) == len(kit['stages'])
                for item in kit['files']:
                    if not item['name'].endswith('.zip'):
                        assert item['name'] in names, item
            checks.append('download URL resolves to complete, readable ZIP with manifest and all exported files')
            assert all(path.exists() and file_hash(path) == digest for path, digest in immutable.items())
            checks.append('source photographs, project and mapping assets remain byte-for-byte unchanged')

            bad = copy.deepcopy(sample); bad['nodes'][2]['output'] = None
            failed = blocked(bad)
            assert inspect(failed).json()['ready'] is False
            checks.append('unfinished mapping blocks inspection and fabrication without borrowing an older image')

            bad = copy.deepcopy(sample); bad['nodes'][2]['status'] = 'stale'
            failed = blocked(bad, 409)
            assert inspect(failed).json()['ready'] is False
            checks.append('stale mapped output is rejected rather than silently fabricated')

            bad = copy.deepcopy(sample)
            bad['nodes'].append(node('new-image', 'precision_edit', output={'imageUrl': assets['source']['url']}))
            bad['order'].insert(-1, 'new-image')
            blocked(bad)
            checks.append('a changed image after mapping must be remapped; no scan back to an old mapped result')

            bad = copy.deepcopy(sample)
            bad['nodes'][3]['params'] = {'sourceMappingId': mapping['id']}
            blocked(bad)
            bad = copy.deepcopy(sample); bad['nodes'][3]['params']['sourceMappingId'] = 'mapping-earlier'
            blocked(bad)
            bad = copy.deepcopy(sample); bad['nodes'][3]['params']['heightMm'] = 180
            blocked(bad)
            checks.append('missing scale consent, previous mapping calibration and distorted aspect ratio are rejected')

            bad = copy.deepcopy(sample)
            bad['nodes'].append(node('reference', 'image_reference', {'references': [assets['source']]}))
            bad['order'] = ['input', 'paint']
            bad['routes'] = [{'id': 'reference-route', 'label': '仅参考', 'order': ['reference', 'mapped', 'make'], 'x': 0, 'y': 500}]
            blocked(bad)
            checks.append('reference-only routes cannot borrow real-garment authority from the mainline')

            bad = copy.deepcopy(sample)
            bad['nodes'].extend([node('fork', 'branch_create'), node('merge', 'branch_merge', {'forkId': 'fork'})])
            bad['order'] = ['input', 'paint', 'fork', 'merge']
            bad['branches'] = [{'id': 'lane-mapped', 'forkId': 'fork', 'label': '已映射', 'order': ['mapped']},
                               {'id': 'lane-other', 'forkId': 'fork', 'label': '另一方案', 'order': ['make']}]
            blocked(bad)
            checks.append('mapping on a sibling branch cannot leak into the active fabrication route')

            # A genuine inferred flatlay receipt cannot be made printable by
            # changing client metadata or supplying apparently valid dimensions.
            meta = source_bundle(core, project)[0]
            model_folder = data / 'flatlay-jobs' / 'flatlay-synthetic'
            core.write_json(model_folder / 'job.json', {'projectId': project['id'], 'projectRevision': 1,
                'status': 'succeeded', 'sourceHash': meta['sourceHash']})
            (model_folder / 'model-output').mkdir(parents=True)
            Image.new('RGB', (180, 240), '#ddd8cc').save(model_folder / 'model-output' / 'flatlay.png')
            ai_mapping = json.loads(json.dumps(create_mapping(core, project, {'revision': 1, 'sourceMode': 'brush',
                'flatlayJobId': 'flatlay-synthetic', 'componentName': 'AI参考', 'sourcePoints': points,
                'targetPoints': points, 'sourceBoundary': points, 'targetBoundary': points})))
            bad = copy.deepcopy(sample)
            bad['nodes'][2]['output'].update(mapping=ai_mapping, imageUrl=ai_mapping['resultUrl'])
            bad['nodes'][2]['output']['mapping']['inferredHidden'] = False
            bad['nodes'][2]['output']['mapping']['semanticAI'] = False
            bad['nodes'][3]['params']['sourceMappingId'] = ai_mapping['id']
            failed = blocked(bad)
            assert inspect(failed).json()['ready'] is False
            checks.append('server-side AI target provenance overrides forged client flatlay flags')

            old = run(saved, expectedRevision=saved['revision'])
            assert old.status_code == 409 and store.get(saved['id']) == saved_after
            checks.append('outdated workflow revisions cannot replace a completed making kit')
            wrong_node = inspect(saved_after, 'paint')
            assert wrong_node.status_code == 422
            checks.append('making-input endpoint validates the requested node type')

    print(json.dumps({'passed': True, 'count': len(checks), 'checks': checks,
        'fixtures': 'synthetic images only', 'paidApiCalls': 0,
        'boundary': 'registered HTTP handlers and StaticFiles path resolution; no browser download'}, ensure_ascii=True))


if __name__ == '__main__':
    main()
