"""Meaningful deterministic checks of garment extraction and coordinate changes."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace

from fastapi import HTTPException
from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from node_studio import garment_tools as garment


def reject(function, status=422):
    try:
        function()
    except HTTPException as error:
        assert error.status_code == status, (error.status_code, error.detail)
    else:
        raise AssertionError('invalid operation succeeded')


def main():
    checks = []
    with tempfile.TemporaryDirectory(prefix='garment-tools-', dir=ROOT / 'work') as temporary:
        root = Path(temporary)
        data, resources = root / 'data', root / 'resources'
        data.mkdir(); resources.mkdir()
        def url(path):
            return '/data/' + Path(path).relative_to(data).as_posix()
        def write(path, value):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(value), encoding='utf8')
        core = SimpleNamespace(DATA=data, RESOURCES=resources, ROOT=root, data_url=url,
                               read_json=lambda path, default=None: json.loads(path.read_text()) if path.is_file() else default,
                               write_json=write,
                               local_image=lambda project: garment._local(core, project['reference']['url']),
                               load_rgb=lambda path: Image.open(path).convert('RGB'))
        source = Image.new('RGB', (200, 300), '#6483a2')
        draw = ImageDraw.Draw(source)
        draw.rectangle((50, 60, 149, 239), fill='#bbbbbb')
        draw.rectangle((80, 100, 90, 110), fill='#9a1621')
        source_path = data / 'source.png'
        source.save(source_path)
        original = source_path.read_bytes()
        polygon = [{'x': .25, 'y': .2}, {'x': .75, 'y': .2}, {'x': .75, 'y': .8}, {'x': .25, 'y': .8}]
        result = garment.segment(core, '/data/source.png', {'method': 'polygon', 'polygon': polygon, 'padding': 0})
        image = Image.open(garment._local(core, result['imageUrl']))
        assert image.size == source.size and image.mode == 'RGBA'
        assert image.getpixel((85, 105)) == (154, 22, 33, 255)
        assert image.getpixel((0, 0))[3] == 0
        assert ImageChops.multiply(ImageChops.difference(image.convert('RGB'), source).convert('L'), image.getchannel('A')).getbbox() is None
        assert result['coordinateSpace'] == 'source_full_size' and result['semanticAI'] is False
        checks.append('selected original pixels and blood location are exact; outside region is transparent')
        crop = Image.open(garment._local(core, result['croppedUrl']))
        crop.load()
        assert crop.width < source.width and crop.height < source.height
        assert source_path.read_bytes() == original
        checks.append('cropped output is separate from same-coordinate output; source bytes immutable')
        removed = garment.segment(core, '/data/source.png', {'method': 'polygon', 'polygon': polygon, 'padding': 0,
            'excludePolygons': [[{'x': .39, 'y': .32}, {'x': .48, 'y': .32}, {'x': .48, 'y': .4}, {'x': .39, 'y': .4}]]})
        assert Image.open(garment._local(core, removed['imageUrl'])).getpixel((85, 105))[3] == 0
        checks.append('negative correction actually removes pixels')
        quad = [{'x': 0., 'y': 0.}, {'x': 1., 'y': 0.}, {'x': 1., 'y': 1.}, {'x': 0., 'y': 1.}]
        flat = garment.flatten(core, '/data/source.png', {'method': 'geometry', 'quad': quad, 'outputWidth': 200, 'outputHeight': 300})
        same = Image.open(garment._local(core, flat['imageUrl']))
        assert ImageChops.difference(same.convert('RGB'), source).getbbox() is None
        assert flat['inferredHidden'] is False and flat['exactGeometry'] is False
        assert flat['coordinateSpace'] == 'rectified_visible_surface'
        checks.append('identity quad preserves visible texture and declares no hidden reconstruction')
        cropped_flat = garment.flatten(core, '/data/source.png', {'method': 'geometry', 'quad': polygon, 'outputWidth': 100, 'outputHeight': 180})
        rectified = Image.open(garment._local(core, cropped_flat['imageUrl']))
        r, g, b, a = rectified.getpixel((35, 45))
        assert r > 100 and g < 50 and b < 60 and a == 255
        checks.append('blood visibly moves to corresponding rectified coordinates')
        reject(lambda: garment.segment(core, '/data/../resources/outside.png', {'method': 'polygon', 'polygon': polygon}))
        reject(lambda: garment.segment(core, '/data/source.png', {'method': 'polygon', 'polygon': [polygon[0], polygon[2], polygon[1], polygon[3]]}))
        reject(lambda: garment.segment(core, '/data/source.png', {'points': [{'x': .5, 'y': .5, 'label': 0}]}))
        reject(lambda: garment.segment(core, '/data/source.png', {'points': [{'x': float('nan'), 'y': .5}]}))
        reject(lambda: garment.segment(core, '/data/source.png', {'box': {'x': .9, 'y': 0, 'width': .2, 'height': 1}}))
        reject(lambda: garment.flatten(core, '/data/source.png', {'method': 'geometry', 'quad': [quad[0], quad[3], quad[2], quad[1]]}))
        reject(lambda: garment.segment(core, '/data/source.png', {'points': [{'x': .5, 'y': .5}]}), 503)
        checks.append('unsafe paths, invalid geometry/prompts and missing models fail without fake outputs')
        original_project = {'reference': {'url': '/data/source.png'}, 'brushStrokes': [], 'damageItems': [],
                            'protectedRects': [{'x': .1, 'y': .1, 'width': .1, 'height': .1}]}
        before = copy.deepcopy(original_project)
        folder = data / 'assistant-candidate'
        folder.mkdir()
        action = garment.assistant_tools()['garment_flatten'](core, original_project,
                    {'method': 'geometry', 'quad': quad, 'outputWidth': 200, 'outputHeight': 300}, folder)
        assert original_project == before and action['project']['protectedRects'] == []
        assert action['project']['reference']['url'].startswith('/data/uploads/')
        assert action['validation']['requiresProtectionReselection'] is True
        assert action['output']['editableStrokes'] is False
        checks.append('assistant uses independent uploaded raster; coordinate change clears stale protection and strokes')
        updated_image = Image.new('RGB', source.size, '#1177aa')
        updated_image.save(data / 'updated-raster.png')
        stale_project = {'reference': {'url': '/data/updated-raster.png'}, 'uploadId': 'old-upload',
                         'brushStrokes': [], 'damageItems': [], 'protectedRects': []}
        core.local_image = lambda project: source_path
        moved = garment.assistant_tools()['garment_split'](core, stale_project,
                    {'method': 'polygon', 'polygon': polygon}, folder)
        with Image.open(garment._local(core, moved['output']['imageUrl'])) as result:
            assert result.getpixel((85, 105)) == (17, 119, 170, 255)
        checks.append('local assistant tool honors current raster reference instead of an inherited upload ID')
    print(json.dumps({'status': 'passed', 'checks': checks}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
