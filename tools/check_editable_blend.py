"""Pixel-level checks for effect blending; synthetic fixtures, no models or cloud."""
import copy
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from PIL import Image
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from node_studio.blend_tools import blend_editable
from brush_workflow import render_brush_guide


def stroke(identifier, kind, x, color):
    return dict(id=identifier, type=kind, size=.1, opacity=.8, seed=12,
                points=[dict(x=x,y=.5)], shapes=[dict(kind='ellipse',cx=x,cy=.5,rx=.1,ry=.15,color=color,alpha=.8)])


def main():
    checks = []
    scratch=Path(__file__).resolve().parents[1]/'work'; scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='blend-check-',dir=scratch) as directory:
        data = Path(directory); (data/'uploads').mkdir()
        source = data/'uploads/base.png'; Image.new('RGB',(100,120),'#eeeeee').save(source)
        url='/data/uploads/base.png'; core=SimpleNamespace(DATA=data, ROOT=data, RESOURCES=data, data_url=lambda p:'/data/'+Path(p).relative_to(data).as_posix())
        base=dict(reference=dict(url=url), brushStrokes=[stroke('a','blood',.3,'#772020')],damageItems=[], protectedRects=[dict(x=.2,y=.45,w=.05,h=.1)])
        other=dict(reference=dict(url=url),brushStrokes=[stroke('b','blood',.7,'#335577'),stroke('c','wear',.5,'#444444')],damageItems=[],protectedRects=[])
        flow=dict(nodes=[dict(id='a',output=dict(projectSnapshot=base)),dict(id='b',output=dict(projectSnapshot=other))])
        original=copy.deepcopy(flow)
        task=dict(candidateIds=['a','b'],baseNodeId='a',weights=[1,0],effectScope='all',featureSources={})
        def run(**changes):
            result=blend_editable(core,flow,{},dict(task,**changes))
            with Image.open(data/result['imageUrl'][6:]) as image: pixels=image.convert('RGB').copy()
            return result,pixels
        a,ai=run(); expected=render_brush_guide(Image.open(source),base)
        assert ai.tobytes()==expected.convert('RGB').tobytes(); checks.append('100% A reproduces A pixels')
        mixed,mi=run(weights=[.5,.5]); assert mi.tobytes()!=ai.tobytes()
        assert mixed['brushStrokes'][0]['shapes'][0]['alpha']==.4
        assert mi.getpixel((30,60)) != ai.getpixel((30,60)); checks.append('weight changes actual shape alpha and pixels')
        assert mi.getpixel((22,60))==(238,238,238); checks.append('protected pixels remain unchanged')
        fixed,fi=run(weights=[0,1],featureSources={'blood':'a'})
        assert [s['type'] for s in fixed['brushStrokes']]==['blood','wear']; assert fixed['brushStrokes'][0]['shapes'][0]['alpha']==.8
        checks.append('per-feature source overrides overall weight')
        assert flow==original; checks.append('candidate projects remain unchanged')
        # The newly adopted project must be independently renderable for further edits.
        assert render_brush_guide(Image.open(source),mixed['projectSnapshot']).convert('RGB').tobytes()==mi.tobytes()
        checks.append('saved project replays the same preview')
        prior = copy.deepcopy(flow)
        flow['nodes'][1]['output']['projectSnapshot'] = copy.deepcopy(base)
        flow['nodes'][1]['output']['projectSnapshot']['brushStrokes'][0]['id'] = 'same-visual-different-id'
        shared, shared_pixels = run(weights=[.5, .5])
        assert len(shared['brushStrokes']) == 1
        assert shared_pixels.tobytes() == expected.convert('RGB').tobytes()
        shared2, shared_pixels2 = run(weights=[.3, .7])
        assert shared_pixels2.tobytes() == shared_pixels.tobytes()
        checks.append('shared unchanged translucent stroke remains pixel-identical at every blend ratio')
        for item in flow['nodes']:
            item['output']['projectSnapshot']['brushStrokes'].append(copy.deepcopy(item['output']['projectSnapshot']['brushStrokes'][0]))
            item['output']['projectSnapshot']['brushStrokes'][1]['id'] += '-intentional-copy'
        repeated, repeated_pixels = run(weights=[.5, .5])
        assert len(repeated['brushStrokes']) == 2
        repeated_expected = render_brush_guide(Image.open(source), flow['nodes'][0]['output']['projectSnapshot']).convert('RGB')
        assert repeated_pixels.tobytes() == repeated_expected.tobytes()
        checks.append('intentional duplicate strokes within one candidate are preserved')
        flow = copy.deepcopy(prior)
        flow['nodes'][1]['output']['imageSemantics'] = 'raster_base'
        try: run(); raise AssertionError('raster semantics should be rejected without other flags')
        except HTTPException as e: assert e.status_code == 422
        del flow['nodes'][1]['output']['imageSemantics']
        flow['nodes'][1]['output']['projectSnapshot']['surfaceOptions'] = {'enabled': True, 'analysisId': 'surface-test', 'strength': .7}
        try: run(); raise AssertionError('different displacement fields should be rejected')
        except HTTPException as e: assert e.status_code == 422
        del flow['nodes'][1]['output']['projectSnapshot']['surfaceOptions']
        checks.append('raster semantics and incompatible surface fields rejected explicitly')
        flow['nodes'][1]['output']['rasterized']=True
        try: run(); raise AssertionError('raster should be rejected')
        except HTTPException as e: assert e.status_code==422
        del flow['nodes'][1]['output']['rasterized']; Image.new('RGB',(100,120),'#333333').save(data/'uploads/other.png')
        flow['nodes'][1]['output']['projectSnapshot']['reference']['url']='/data/uploads/other.png'
        try: run(); raise AssertionError('different base should be rejected')
        except HTTPException as e: assert e.status_code==422
        checks.append('raster outputs and mismatched bases rejected')
    print(json.dumps(dict(passed=True,checks=checks),ensure_ascii=False,indent=2))

if __name__=='__main__': main()
