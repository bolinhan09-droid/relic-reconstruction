"""Making-kit provenance/metric/print/geometry checks on isolated synthetic data."""
from __future__ import annotations
import copy
import json
from pathlib import Path
import re
import sys
import tempfile
from types import SimpleNamespace
import xml.etree.ElementTree as ET
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from PIL import Image,ImageDraw,ImageChops
import garment_mapping as mapping
from node_studio import making_geometry as geo
from node_studio.making_kit import build_making_kit,inspect_making_input,_load,_render_groups
from node_studio.making_recipes import recipe, LABELS


def main():
    checked=[]
    def check(label,test):
        assert test,label
        checked.append(label)
    def rejects(fn,status=422):
        try: fn()
        except HTTPException as e: assert e.status_code==status,(e.status_code,e.detail)
        else: raise AssertionError('expected refusal')
    # Ring hole must remain attached to surrounding stencil, not drop out.
    ring=Image.new('L',(200,200))
    draw=ImageDraw.Draw(ring)
    draw.ellipse((35,35,165,165),fill=255)
    draw.ellipse((75,75,125,125),fill=0)
    paths,details,mask=geo.prepare_mask(ring,200,200,2,3)
    check('white islands receive actual connecting strips',bool(details['supportBridges']) and geo.connected_islands(mask)==0)
    check('non rectangular alpha yields detailed contours',len(paths[0])>8)
    check('cut bounds preserve 10mm sheet margin',all(10<=x<=210 and 10<=y<=210 for p in paths for x,y in p))
    # Never round-trip a photograph bbox as a fake stencil.
    tiny=Image.new('L',(200,200))
    ImageDraw.Draw(tiny).point((100,100),fill=255)
    check('sub-resolution isolated dots are omitted from cut layer',not geo.prepare_mask(tiny,200,200,3,2)[0])
    allowed=Image.new('L',(200,200))
    ImageDraw.Draw(allowed).rectangle((60,60,140,140),fill=255)
    _,_,protected=geo.prepare_mask(ring,200,200,2,2,'protection',allowed)
    box=protected.getbbox()
    check('protection dilation never leaves confirmed mapping coverage',box is None or (box[0]>=60*3 and box[1]>=60*3 and box[2]<=141*3 and box[3]<=141*3))
    # SVG and DXF share actual coordinates; DXF Y points upward.
    test_path=[[(12,25),(28,25),(28,40),(12,40)]]
    svg=geo.svg(100,150,test_path,'<test>',True)
    dxf=geo.dxf(100,150,test_path)
    root=ET.fromstring(svg)
    check('SVG declares real physical page dimensions',root.attrib['width']=='120mm' and root.attrib['height']=='170mm')
    check('DXF millimetres and flipped coordinates match SVG', '$INSUNITS\n70\n4' in dxf and '10\n12.000000\n20\n145.000000' in dxf)
    check('mark geometry cannot masquerade as cutting layer','\nCUT\n' not in geo.dxf(100,150,test_path,False) and '\nMARK\n' in geo.dxf(100,150,test_path,False))
    # Each registered subtype has an explicit usable recipe; unknown future ones are manual.
    check('all supported detailed brushes have craft instructions',all(recipe(k,s)[0]['actions'] for k,subs in LABELS.items() for s in subs))
    check('unknown future effect does not invent automatic cut method',recipe('alien','unknown')[0]['geometry']=='mark')
    base=Path(__file__).resolve().parents[1]
    (base/'work').mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='making-kit-check-',dir=base/'work') as temp:
        data=Path(temp)
        def read(p,default=None): return json.loads(p.read_text(encoding='utf-8')) if p.is_file() else copy.deepcopy(default)
        def write(p,value):
            p.parent.mkdir(parents=True,exist_ok=True)
            p.write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8')
        def sid(value):
            if not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',value): raise HTTPException(422,'bad id')
            return value
        for name in ('source','flat'):
            p=data/f'uploads/{name}/image.png'
            p.parent.mkdir(parents=True)
            Image.new('RGB',(180,240),'#c8c9ca').save(p)
        def stroke(identifier,kind,subtype,x,y,rx=.08):
            return {'id':identifier,'type':kind,'effectSubtype':subtype,'size':.1,'opacity':.8,'seed':1,
                    'points':[{'x':x,'y':y}],
                    'shapes':[{'kind':'ellipse','cx':x,'cy':y,'rx':rx,'ry':.07,'alpha':.8,'color':'#741f25'}]}
        project={'id':'project-test','revision':4,'reference':{'id':'source'},'protectedRects':[],
                 'brushStrokes':[stroke('blood','blood','splatter',.3,.4),stroke('soak','blood','soak',.6,.45),
                                 stroke('burn','burn','char',.6,.7),stroke('wear','wear','scuff',.35,.7)]}
        core=SimpleNamespace(DATA=data,ROOT=base,safe_id=sid,read_json=read,write_json=write,now=lambda:'2026-10-25',
                             load_rgb=lambda p:Image.open(p).convert('RGB'),local_image=lambda p:data/'uploads'/p['reference']['id']/'image.png',
                             data_url=lambda p:'/data/'+p.relative_to(data).as_posix(),get_project=lambda _:project,current_generation=lambda _:None)
        vertices=[{'x':.05,'y':.05},{'x':.95,'y':.05},{'x':.95,'y':.95},{'x':.05,'y':.95}]
        request={'targetUploadId':'flat','sourcePoints':vertices,'targetPoints':vertices,'sourceBoundary':vertices,'targetBoundary':vertices,
                 'componentName':'测试领巾','physicalWidthCm':18}
        receipt=mapping.create_mapping(core,project,request)
        output={'coordinateSpace':'flatlay','mapping':receipt,'mappingSourceProject':copy.deepcopy(project)}
        params={'sourceMappingId':receipt['id'],'flatConfirmed':True,'scaleConfirmed':True,'widthMm':180,'heightMm':240}
        readiness=inspect_making_input(core,output)
        check('readiness reads real mapping and classifies recorded brush subtypes',readiness['ready'] and len(readiness['effects'])==4)
        check('scale suggestion describes image frame not garment width',readiness['source']['physicalWidthMm']==180)
        kit=build_making_kit(core,output,params,data/'kit','Test <kit>')
        check('part effect step hierarchy contains all four effects',len(kit['parts'])==1 and len(kit['parts'][0]['effects'])==4 and len(kit['stages'])==6)
        check('physical operations are globally ordered before painting',kit['stages'][0]['effectLabel']=='擦伤')
        check('soak produces marking rather than hard edge stencil',all(not s['template']['cuttable'] for s in kit['stages'] if s['effectLabel']=='血迹浸染'))
        check('success does not claim material physics or AI inference',not kit['physicalValidated'] and not kit['semanticAI'])
        manual=(data/'kit/manual.html').read_text(encoding='utf-8')
        check('manual images and stencil previews are embedded for standalone viewing','data:image/png;base64,' in manual and 'data:image/svg+xml;base64,' in manual and '&lt;kit&gt;' in manual)
        print_html=next((data/'kit').glob('effect*-print.html')).read_text(encoding='utf-8')
        check('A4 print tiles preserve physical scale and overlap','@page{size:A4;margin:10mm}' in print_html and '重叠 10 mm' in print_html and 'width:200mm;height:260mm' in print_html)
        check('standalone print HTML embeds stencil instead of depending on neighbour files','data:image/svg+xml;base64,' in print_html)
        check('placement SVG embeds actual flatlay photograph','data:image/png;base64,' in (data/'kit/placement.svg').read_text(encoding='utf-8'))
        with zipfile.ZipFile(data/'kit/making-kit.zip') as archive:
            check('portable kit contains manual source image and all templates','manual.html' in archive.namelist() and 'flatlay.png' in archive.namelist() and len([n for n in archive.namelist() if n.endswith('.dxf')])==6)
        rejects(lambda:build_making_kit(core,output,{**params,'sourceMappingId':'mapping-old'},data/'bad'))
        rejects(lambda:build_making_kit(core,output,{**params,'scaleConfirmed':False},data/'bad'))
        rejects(lambda:build_making_kit(core,output,{**params,'widthMm':float('nan')},data/'bad'))
        rejects(lambda:build_making_kit(core,output,{**params,'heightMm':500},data/'bad'))
        checked.append('stale confirmation missing scale nonfinite dimension and aspect distortion rejected')
        check('wearing source is rejected',not inspect_making_input(core,{**output,'coordinateSpace':'source_photo'})['ready'])
        record_path=data/'projects/project-test/mappings'/receipt['id']/'receipt.json'
        original=read(record_path)
        write(record_path,{**original,'semanticAI':True,'inferredHidden':True})
        check('AI-invented flatlay cannot produce physical templates',not inspect_making_input(core,output)['ready'])
        write(record_path,{**original,'layerMode':'embedded_visible_pixels'})
        check('baked image never becomes fabricated extracted stain contours',not inspect_making_input(core,output)['ready'])
        write(record_path,original)
        # A source snapshot is authoritative; modifying it must fail before new files.
        snapshot_path=record_path.parent/'source-brush-snapshot.json'
        saved_snapshot=read(snapshot_path,copy.deepcopy(project))
        altered=copy.deepcopy(saved_snapshot)
        altered['brushStrokes'][0]['shapes'][0]['cx']=.8
        write(snapshot_path,altered)
        rejects(lambda:build_making_kit(core,output,params,data/'mismatched'),409)
        checked.append('mismatched saved stroke snapshot rejected before output')
        write(snapshot_path,saved_snapshot)
        check('source project not modified by kit generation',project['revision']==4 and project['brushStrokes'][0]['shapes'][0]['cx']==.3)
        project['protectedRects']=[{'x':.63,'y':.67,'w':.06,'h':.05}]
        eraser=stroke('withdraw','erase','',.3,.4,.025)
        eraser.pop('effectSubtype')
        eraser['shapes'][0]['ry']=.025
        project['brushStrokes'].append(eraser)
        moved_request={**request,'targetPoints':[{'x':p['x']+.02,'y':p['y']} for p in vertices],
                       'targetBoundary':[{'x':p['x']+.02,'y':p['y']} for p in vertices]}
        moved=mapping.create_mapping(core,project,moved_request)
        moved_output={'coordinateSpace':'flatlay','mapping':moved,'mappingSourceProject':copy.deepcopy(project)}
        loaded=_load(core,moved_output)
        rec,snap,ss,ff,sf=loaded
        groups,forbidden=_render_groups(core,rec,snap,ss,ff,sf)
        check('exclusion follows same source-to-flat coordinate shift',forbidden.getpixel((round(.32*179),round(.4*239)))>0)
        check('absolute protection is also mapped to target frame',forbidden.getpixel((round(.67*179),round(.69*239)))>0)
        blood_group=next(layer for (kind,sub),_,layer in groups if kind=='blood' and sub=='splatter')
        allowed=ImageChops.subtract(Image.open(ff/'coverage.png').convert('L'),forbidden)
        _,_,expanded=geo.prepare_mask(blood_group.getchannel('A'),180,240,2,2,'protection',allowed)
        px=round(round(.32*179)*expanded.width/180)
        py=round(round(.4*239)*expanded.height/240)
        check('protection aperture cannot reopen an intentionally erased region',expanded.getpixel((px,py))==0)
    print(json.dumps({'passed':len(checked),'checks':checked},ensure_ascii=False,indent=2))


if __name__=='__main__': main()
