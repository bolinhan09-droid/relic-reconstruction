"""Coverage persistence and real renderer check, using synthetic fixtures only."""
from __future__ import annotations
import copy
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / 'work/v0116-blood-check'
os.environ['RELIC_DATA_DIR'] = str(OUT / 'backend-isolated-data')
sys.path.insert(0, str(ROOT))
import brush_workflow as brush
from fastapi import HTTPException
from PIL import Image, ImageChops, ImageStat

samples = json.loads((OUT / 'coverage-samples.json').read_text(encoding='utf-8'))
wide = samples['wide']
source = Image.open(OUT / 'renderer-source.png').convert('RGB')
checks = []
clean = brush.validate_brush_strokes([wide])[0]
assert clean == wide and clean is not wide and clean['bloodParameters']['coverage'] == .92
checks.append('current wide geometry and coverage survive strict backend validation without regeneration')
legacy = copy.deepcopy(wide)
legacy['bloodParameters'].pop('coverage')
assert brush.validate_brush_strokes([legacy]) == [legacy]
base = {'brushStrokes': [wide], 'protectedRects': []}
actual = brush.render_brush_guide(source, base)
assert actual.tobytes() == brush.render_brush_guide(source, {'brushStrokes': [legacy], 'protectedRects': []}).tobytes()
checks.append('missing coverage remains valid for old v2 records and leaves their saved appearance unchanged')
for value in [True, -.1, 1.1, float('nan'), 'wide', None]:
    invalid = copy.deepcopy(wide)
    invalid['bloodParameters']['coverage'] = value
    try:
        brush.validate_brush_strokes([invalid])
    except HTTPException as error:
        assert error.status_code == 422
    else:
        raise AssertionError(f'Invalid coverage accepted: {value!r}')
checks.append('non-numeric, non-finite and out-of-range coverage rejected')
assert actual.tobytes() == brush.render_brush_guide(source, base).tobytes()
actual.save(OUT / 'backend-wide.png')
frontend = Image.open(OUT / 'renderer-wide.png').convert('RGB')
mean = sum(ImageStat.Stat(ImageChops.difference(frontend, actual)).mean) / 3
# Canvas and Pillow rasterize edges differently. The saved shapes are identical,
# while this bound catches an alpha/blending or coordinate-space mismatch.
assert mean < .6, mean
checks.append('Python export and browser guide agree within sub-pixel rasterization tolerance')
protected = {**base, 'protectedRects': [{'x': .2, 'y': .27, 'w': .08, 'h': .07}]}
protected_image = brush.render_brush_guide(source, protected)
region = (int(source.width*.2)+2, int(source.height*.27)+2, int(source.width*.28)-2, int(source.height*.34)-2)
assert ImageChops.difference(protected_image.crop(region), source.crop(region)).getbbox() is None
checks.append('protected pixels remain exact after backend export')
report = {'passed': True, 'checks': checks, 'browserExportMeanChannelDifference': mean, 'syntheticImagesOnly': True, 'paidRequests': 0}
(OUT / 'backend-coverage-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False))
