"""Build an auditable, local making kit from a verified flatlay mapping.

No photograph segmentation, inferred fabric chemistry, paid model, or automatic
machine cutting is involved. Geometry comes only from recorded brush shapes,
their erasures/protection, and the confirmed correspondence saved upstream.
"""
from __future__ import annotations

import copy
import base64
import html
import json
import math
from pathlib import Path
import shutil
import zipfile

from fastapi import HTTPException
from PIL import Image, ImageChops, ImageStat

import brush_workflow as brush
import garment_mapping as mapping
from .fabrication import number
from .store import fail, safe_id
from . import making_geometry as geometry
from .making_recipes import LABELS, effect_key, recipe


def _load(core, output):
    if not isinstance(output, dict) or output.get('coordinateSpace') != 'flatlay':
        fail('请连接已完成痕迹映射的真实平铺服装')
    incoming = output.get('mapping')
    if not isinstance(incoming, dict): fail('上游缺少映射记录，请重新保存映射结果')
    identifier, project_id = safe_id(incoming.get('id')), safe_id(incoming.get('projectId'))
    folder = Path(core.DATA) / 'projects' / project_id / 'mappings' / identifier
    record = core.read_json(folder / 'receipt.json', {})
    if not record or record.get('id') != identifier or record.get('projectId') != project_id:
        fail('映射记录已丢失，请重新完成映射')
    if incoming.get('source', {}).get('sourceHash') != record.get('source', {}).get('sourceHash'):
        fail('节点中的映射记录与本机记录不一致，请重新保存映射输出', 409)
    if record.get('inferredHidden') or record.get('semanticAI'):
        fail('AI 生成的平铺外观不能直接制作实物模板；请使用真实平铺照片重新映射')
    if record.get('layerMode') != 'recorded_alpha_layer' or record.get('source', {}).get('sourceKind') not in {
        'recorded_brush_layer', 'recovered_brush_snapshot', 'approved_patch_with_recorded_support'}:
        fail('这张图没有可追溯的独立笔触，不能把照片中的颜色或阴影当成模板；请回精修节点保存笔触再映射')
    tag = safe_id(record.get('source', {}).get('tag'))
    source_folder = Path(core.DATA) / 'projects' / project_id / 'mapping-sources' / tag
    snapshot = core.read_json(folder / 'source-brush-snapshot.json', None)
    if not isinstance(snapshot, dict): snapshot = core.read_json(source_folder / 'brush-snapshot.json', None)
    if not isinstance(snapshot, dict): snapshot = output.get('mappingSourceProject')
    if not isinstance(snapshot, dict) or not snapshot.get('brushStrokes'):
        fail('缺少映射时的笔触快照，请回映射节点重新生成并保存')
    strokes = brush.validate_brush_strokes(snapshot['brushStrokes'])
    if not any(s['type'] != 'erase' for s in strokes): fail('没有可制作的痕迹笔触')
    for path in (source_folder/'original.png', source_folder/'effects.png', folder/'target.png', folder/'mapped-effects.png', folder/'coverage.png'):
        if not path.is_file(): fail('映射所需图层缺失，请重新生成映射')
    size = record.get('targetSize')
    if not isinstance(size, list) or len(size) != 2 or any(isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= 1600 for n in size):
        fail('映射目标尺寸无效')
    return record, snapshot, strokes, folder, source_folder


def inspect_making_input(core, source_output, params=None):
    result = {'ready':False, 'checks':[], 'source':{}, 'issues':[], 'warnings':[]}
    try:
        record, snapshot, strokes, folder, source_folder = _load(core, source_output)
        grouped = {}
        for stroke in strokes:
            if stroke['type'] == 'erase': continue
            kind, sub = effect_key(stroke)
            group = grouped.setdefault((kind, sub), {'type':kind,'subtype':sub,
                'label':LABELS.get(kind, {}).get(sub, '待确认痕迹'), 'strokeCount':0})
            group['strokeCount'] += 1
        width, height = record['targetSize']
        physical = record.get('physicalWidthCm')
        result['source'] = {'componentName':record.get('componentName') or '当前衣片',
            'flatImageUrl':core.data_url(folder/'target.png'), 'mappedImageUrl':core.data_url(folder/'mapped-result.png'),
            'effectImageUrl':core.data_url(folder/'mapped-effects.png'), 'width':width, 'height':height,
            'physicalWidthMm':physical * 10 if physical else None, 'brushSummary':list(grouped.values()),
            'strokeCount':sum(g['strokeCount'] for g in grouped.values()), 'mappingId':record['id']}
        result['checks'] = [{'id':key,'label':label,'ok':True,'ready':True,'message':message} for key,label,message in (
            ('flat','真实平铺照片','使用实物平铺照片作为定位底图'),
            ('mapping','对应映射已完成','读取本机保存的对应点与覆盖范围'),
            ('brushes','笔刷可追溯','有独立笔触快照，生成时会复核与映射图层的一致性'))]
        result['warnings'] = list(record.get('warnings', []))
        if not record.get('targetBoundary'):
            result['warnings'].append('未提供精确衣片边界，模板仅使用已映射覆盖范围；生成后请对照衣边确认')
        if record['source'].get('sourceKind') == 'approved_patch_with_recorded_support':
            result['warnings'].append('AI 精修图仅作外观参考；工序依据保存的笔触范围，不能精确分离 AI 新增纹理')
        result['ready'] = True
    except HTTPException as error:
        result['issues'] = [str(error.detail)]
        result['checks'] = [{'id':'source','label':'平铺与映射来源','ok':False,'ready':False,'message':str(error.detail)}]
    # Aliases keep callers simple and make this useful outside the node UI.
    result.update({k:v for k,v in result['source'].items() if k in {'flatImageUrl','mappedImageUrl','effectImageUrl','strokeCount'}})
    result['effects'] = [{'id':f"{g['type']}-{g['subtype']}",'label':g['label'],'count':g['strokeCount']} for g in result['source'].get('brushSummary',[])]
    return result


def _matching_alpha(expected, actual, label):
    if actual.size != expected.size: fail(f'{label}尺寸已变化，请重新映射', 409)
    diff = ImageChops.difference(expected.getchannel('A'), actual.getchannel('A'))
    if ImageStat.Stat(diff).mean[0] > .15 or sum(diff.histogram()[16:]) > expected.width * expected.height * .001:
        fail(f'{label}与保存笔触不一致，请重新映射后制作，不能沿用旧坐标', 409)


def _render_groups(core, record, snapshot, strokes, folder, source_folder):
    original = core.load_rgb(source_folder/'original.png')
    clean = copy.deepcopy(snapshot)
    clean['brushStrokes'] = strokes
    _, entire = brush._raster(clean, original.size, with_paint=True, source=original)
    saved_source = Image.open(source_folder/'effects.png').convert('RGBA')
    approved = record['source'].get('sourceKind') == 'approved_patch_with_recorded_support'
    if approved:
        expected_support = entire.copy()
        expected_support.putalpha(entire.getchannel('A').point(lambda n:255 if n else 0))
        _matching_alpha(saved_source, expected_support, '精修笔触支持范围')
    else:
        _matching_alpha(saved_source, entire, '源笔触图层')
    source = original.copy()
    source.thumbnail((mapping.MAX_EDGE, mapping.MAX_EDGE), Image.Resampling.LANCZOS)
    src = mapping.points(record['sourcePoints'])
    dst = mapping.points(record['targetPoints'])
    src_boundary = mapping.points(record['sourceBoundary']) if record.get('sourceBoundary') else None
    dst_boundary = mapping.points(record['targetBoundary']) if record.get('targetBoundary') else None
    target_size = tuple(record['targetSize'])
    def warp(layer):
        return mapping.warp_layers(source, layer.resize(source.size, Image.Resampling.LANCZOS), src, dst,
                                   target_size, src_boundary, dst_boundary)[1]
    _matching_alpha(Image.open(folder/'mapped-effects.png').convert('RGBA'), warp(saved_source), '目标映射图层')
    keys = list(dict.fromkeys(effect_key(s) for s in strokes if s['type'] != 'erase'))
    groups = []
    for key in keys:
        selected = [s for s in strokes if s['type'] == 'erase' or effect_key(s) == key]
        project = {**clean, 'brushStrokes':selected}
        _, layer = brush._raster(project, original.size, with_paint=True, source=original)
        mapped = warp(layer)
        if not mapped.getchannel('A').getbbox(): continue
        groups.append((key, [s for s in selected if s['type'] != 'erase'], mapped))
    if not groups: fail('所有笔触都已擦除、受保护或位于当前映射部件之外，没有可输出的制作范围')
    # Expansion for a splatter protection aperture must not reopen an explicit
    # erasure or protected garment region. Replay withdrawal in original order,
    # through the same surface deformation, then apply absolute protection.
    inverse_strokes = []
    for stroke in strokes:
        value = {k:copy.deepcopy(v) for k,v in stroke.items() if k in
                 {'id','size','opacity','seed','points','shapes','mode','region'}}
        value['type'] = 'wear' if stroke['type'] == 'erase' else 'erase'
        inverse_strokes.append(value)
    withdrawn, _ = brush._raster({**clean,'protectedRects':[],'brushStrokes':inverse_strokes}, original.size)
    forbidden = ImageChops.lighter(withdrawn,brush._protected(clean,original.size))
    permission = Image.new('RGBA',original.size)
    permission.putalpha(forbidden)
    mapped_forbidden = warp(permission).getchannel('A').point(lambda n:255 if n else 0)
    return groups, mapped_forbidden


def _print_page(svg_name, width, height, title, folder):
    pw, ph = width+20, height+20
    usable_w, usable_h, overlap = 190., 267., 10.
    columns = max(1, math.ceil((pw-overlap)/(usable_w-overlap)))
    rows = max(1, math.ceil((ph-overlap)/(usable_h-overlap)))
    embedded_svg = 'data:image/svg+xml;base64,'+base64.b64encode((folder/svg_name).read_bytes()).decode('ascii')
    pages = []
    for row in range(rows):
        for col in range(columns):
            left, top = col*(usable_w-overlap), row*(usable_h-overlap)
            pages.append(f'<section class="page"><header>{html.escape(title)} · 行 {row+1}/{rows} 列 {col+1}/{columns} · 100% 实际大小 · 重叠 10 mm</header>'
                         f'<div class="tile"><img src="{embedded_svg}" style="width:{pw:g}mm;height:{ph:g}mm;left:-{left:g}mm;top:-{top:g}mm"></div></section>')
    return ('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>'+html.escape(title)+'</title><style>'
            '@page{size:A4;margin:10mm}body{margin:0;font-family:system-ui;background:#ddd}.page{width:190mm;height:277mm;box-sizing:border-box;margin:10mm auto;background:white;break-after:page}'
            'header{height:10mm;font-size:9pt;box-sizing:border-box;padding-top:2mm}.tile{position:relative;width:190mm;height:267mm;overflow:hidden;outline:0.2mm solid #888}.tile img{position:absolute;max-width:none}'
            '@media print{body{background:white}.page{margin:0}.page:last-child{break-after:auto}button,p{display:none}}</style>'
            '<button onclick="window.print()">打印 A4 拼页</button><p>打印比例选择 100%，关闭页眉页脚；先测量 SVG 上的毫米校验线。按页边界对齐 10 mm 重叠区域后拼接。</p>' + ''.join(pages)+'</html>')


def _manual(kit, folder):
    esc = lambda value:html.escape(str(value), quote=True)
    def embedded(name, mime):
        return 'data:'+mime+';base64,'+base64.b64encode((folder/name).read_bytes()).decode('ascii')
    rows = []
    for stage in kit['stages']:
        links = ' · '.join(f'<a href="{esc(f["name"])}">{esc(f["label"])}</a>' for f in stage['files'])
        actions = ''.join(f'<li>{esc(a)}</li>' for a in stage['actions'])
        rows.append(f'<article><h2>{stage["order"]:02d} {esc(stage["title"])}</h2><p>{esc(stage["partName"])} / {esc(stage["effectLabel"])} · {esc(stage["templateKind"])}</p>'
                    f'<img class="preview" src="{embedded(stage["template"]["svgName"],"image/svg+xml")}"><p><b>工具：</b>{esc("、".join(stage["tools"]))}</p><ol>{actions}</ol>'
                    f'<p><b>检查：</b>{esc(stage["checkpoint"])}</p><p><b>下一步：</b>{esc(stage["next"])}</p><p>{links}</p></article>')
    warnings = ''.join(f'<li>{esc(v)}</li>' for v in kit['warnings'])
    material = {'unknown':'材料未确认：先做同材质小样，不直接推断加热、砂磨或固色条件',
                'fabric':'普通织物：仍需根据颜料说明和小样确认适配性与干燥方式',
                'coated':'皮革或涂层：先验证附着、弯折和擦拭，默认不使用砂磨、熨烫或渗染配方'}[kit['material']]
    return ('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>战损制作说明书</title><style>'
            'body{font:16px/1.65 system-ui,sans-serif;max-width:1000px;margin:32px auto;padding:24px;color:#283332;background:#f5f3ed}h1,h2{line-height:1.3}article{background:white;padding:24px;margin:24px 0;border:1px solid #ccd0c8;break-inside:avoid}.preview{width:100%;max-height:390px;object-fit:contain;background:#eee}a{color:#8a352b}.pair{display:flex;gap:20px}.pair img{width:48%;object-fit:contain;max-height:420px}@media print{body{background:white;font-size:11pt;margin:0}button{display:none}.preview{max-height:220px}article{padding:12px}}</style>'
            f'<h1>{esc(kit["title"])}</h1><p>部件 → 痕迹 → 工序 → 对齐与检查</p><button onclick="window.print()">打印说明书</button>'
            f'<div class="pair"><img src="{embedded("flatlay.png","image/png")}" alt="真实平铺定位"><img src="{embedded("mapped-preview.png","image/png")}" alt="映射后目标"></div>'
            f'<p>{esc(material)}</p><p>照片画幅：{kit["calibration"]["widthMm"]:g} × {kit["calibration"]["heightMm"]:g} mm；模板四周另留 10 mm。所有模板共用同一外框与四角定位十字。</p>'
            '<p>固定衣片并垫好衣层 → 打印定位图核对 → 在同材质小样试验 → 按下列顺序施工 → 按颜料说明等待与固色。换模板时衣片不移动；制作区外保留保护材料。</p>'
            '<p><a href="placement.svg">查看定位图</a> · <a href="placement-print.html">定位图 A4 拼页</a> · <a href="manifest.json">制作记录</a></p>'
            '<p>说明书已内嵌预览，单独保存即可阅读；模板与拼页链接需先解压完整制作包。</p>'
            '<p>黑色 CUT 区域可镂空；MARK 为描线参考，REGISTRATION 为定位，均不应自动切割。所有机器文件应先由加工方检查材料、尺寸和图层。该制作包未经过实物效果验证。</p>'
            + ''.join(rows)+f'<h2>本次范围与限制</h2><ul>{warnings}</ul></html>')


def build_making_kit(core, source_output, params, folder:Path, title='战损制作包'):
    record, snapshot, strokes, mapping_folder, source_folder = _load(core, source_output)
    if params.get('sourceMappingId') != record['id']:
        fail('映射来源已更新，请重新确认位置与尺寸')
    if params.get('flatConfirmed') is not True or params.get('scaleConfirmed') is not True:
        fail('请确认目标是真实平铺衣物，并用实测尺寸校准整张照片画幅')
    width = number(params.get('widthMm'), 20, 2000, '平铺照片画幅宽度（毫米）')
    height = number(params.get('heightMm'), 20, 2000, '平铺照片画幅高度（毫米）')
    tw, th = record['targetSize']
    if abs(width/height/(tw/th)-1) > .03:
        fail('宽高比例与平铺照片不符；尺寸应是整张照片画幅，不是衣服局部宽高')
    min_feature = number(params.get('minFeatureMm',2), .5, 10, '最小细节（毫米）')
    bridge = number(params.get('bridgeMm',2), 1, 10, '连接桥宽度（毫米）')
    material = params.get('material','unknown')
    if material not in {'unknown','fabric','coated'}: fail('材料选项无效')
    side = params.get('side','front')
    if side not in {'front','back'}: fail('请选择衣片正面或背面')
    groups, forbidden = _render_groups(core, record, snapshot, strokes, mapping_folder, source_folder)
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    shutil.copy2(mapping_folder/'target.png',folder/'flatlay.png')
    shutil.copy2(mapping_folder/'mapped-result.png',folder/'mapped-preview.png')
    warnings = inspect_making_input(core,source_output)['warnings']
    warnings.extend(['这是基于已记录笔触和对应点生成的制作计划，不是缝纫纸样或真实材料模拟',
                     '照片的颜色、透明度和数字笔刷力度不能直接换算成颜料配方或手工力度，先试同材质小样',
                     '细小特征会被移除或改为手工补点；连接桥保留的空隙可在移除模板后补拍',
                     '不补出没有映射依据的隐藏区域；每个制作包只对应当前部件与这一面'])
    kit = {'schemaVersion':1,'kind':'making_kit','title':str(title)[:150], 'mappingId':record['id'],
           'material':material,'physicalValidated':False,'physicalSimulation':False,'semanticAI':False,
           'calibration':{'widthMm':width,'heightMm':height,'pageWidthMm':width+20,'pageHeightMm':height+20,
                          'minFeatureMm':min_feature,'bridgeMm':bridge,'units':'mm','marginMm':10,'source':'user_measured_image_frame'},
           'parts':[], 'stages':[], 'files':[], 'warnings':warnings}
    part = {'id':'part-1','name':record.get('componentName') or '当前衣片','side':side,'effects':[]}
    kit['parts'].append(part)
    allowed = ImageChops.subtract(Image.open(mapping_folder/'coverage.png').convert('L'),forbidden)
    boundary = mapping.points(record['targetBoundary']) if record.get('targetBoundary') else None
    if boundary: allowed = ImageChops.multiply(allowed,mapping.polygon_mask(boundary,(tw,th)))
    placement_paths = []
    def file(label,name,kind):
        return {'label':label,'name':name,'kind':kind,'url':core.data_url(folder/name)}
    for group_index, ((kind, subtype), group_strokes, layer) in enumerate(groups,1):
        effect_id = f'effect-{group_index:02d}'
        alpha = layer.getchannel('A')
        label = LABELS.get(kind,{}).get(subtype,'待确认痕迹')
        effect = {'id':effect_id,'type':kind,'subtype':subtype,'label':label,
                  'strokeIds':[s['id'] for s in group_strokes],'steps':[],
                  'colors':list(dict.fromkeys(shape['color'] for s in group_strokes for shape in s['shapes']))[:12]}
        layer_name = effect_id+'-mapped.png'
        layer.save(folder/layer_name)
        effect['mappedLayerUrl'] = core.data_url(folder/layer_name)
        part['effects'].append(effect)
        reference_paths, _, _ = geometry.prepare_mask(alpha,width,height,min_feature,bridge,'mark',allowed)
        placement_paths.extend(reference_paths)
        for step_index, method in enumerate(recipe(kind,subtype,material),1):
            stage_id = f'{effect_id}-step-{step_index}'
            mode = method.pop('geometry')
            paths, metrics, _ = geometry.prepare_mask(alpha,width,height,min_feature,bridge,mode,allowed)
            if not paths:
                # Do not invent a large polygon when all points are below cut resolution.
                mode = 'mark'
                paths = reference_paths
                method.update(method='manual',templateKind='定位描线',
                              title=method['title']+'（小细节手工补绘）',
                              actions=['该范围细节低于可切割阈值，按定位图手工点染，不生成放大的假轮廓']+method['actions'])
            cut = mode != 'mark'
            svg_name,dxf_name,print_name = stage_id+'.svg',stage_id+'.dxf',stage_id+'-print.html'
            step_title = f'{part["name"]} / {label} / {method["title"]}'
            (folder/svg_name).write_text(geometry.svg(width,height,paths,step_title,cut,boundary),encoding='utf-8')
            (folder/dxf_name).write_text(geometry.dxf(width,height,paths,cut),encoding='ascii')
            (folder/print_name).write_text(_print_page(svg_name,width,height,step_title,folder),encoding='utf-8')
            files = [file('SVG 镂空模板' if cut else 'SVG 描线图',svg_name,'svg'),
                     file('DXF 切割轮廓' if cut else 'DXF 标记层（不切割）',dxf_name,'dxf'),file('A4 拼页打印',print_name,'print')]
            template = {'previewUrl':core.data_url(folder/svg_name),'svgUrl':core.data_url(folder/svg_name),
                        'dxfUrl':core.data_url(folder/dxf_name),'printUrl':core.data_url(folder/print_name),'svgName':svg_name,'cuttable':cut}
            # Large contour arrays stay in the portable audit file, not repeated
            # inside every node document and its effects/stages hierarchy.
            (folder/(stage_id+'-geometry.json')).write_text(json.dumps({
                'units':'mm','layer':'CUT' if cut else 'MARK','metrics':metrics,
                'contoursMm':[[[round(x,6),round(y,6)] for x,y in p] for p in paths]},ensure_ascii=False),encoding='utf-8')
            stage = {**method,'id':stage_id,'partId':part['id'],'partName':part['name'], 'effectId':effect_id,
                     'effectLabel':label,'files':files,'template':template,'geometry':metrics}
            effect['steps'].append(stage)
            kit['stages'].append(stage)
            kit['files'].extend(files)
    kit['stages'].sort(key=lambda step:step['phase'])
    for i,stage in enumerate(kit['stages']):
        stage['order'] = i+1
        stage['next'] = kit['stages'][i+1]['title'] if i+1<len(kit['stages']) else '按产品说明完成干燥与固色，检查擦拭转移和衣片背面'
        stage['check'] = stage['checkpoint']
    embedded_flatlay = 'data:image/png;base64,'+base64.b64encode((folder/'flatlay.png').read_bytes()).decode('ascii')
    (folder/'placement.svg').write_text(geometry.svg(width,height,placement_paths,'位置参考 · 标记而非裁衣',False,boundary,embedded_flatlay),encoding='utf-8')
    (folder/'placement-print.html').write_text(_print_page('placement.svg',width,height,'位置参考',folder),encoding='utf-8')
    kit['files'] = [file('完整制作包 ZIP','making-kit.zip','zip'),file('制作说明书','manual.html','manual'),
                    file('部件定位图','placement.svg','svg'),file('定位图 A4 拼页','placement-print.html','print'),
                    file('制作记录','manifest.json','json')]+kit['files']
    kit.update(downloadUrl=core.data_url(folder/'making-kit.zip'),manualUrl=core.data_url(folder/'manual.html'),
               previewUrl=core.data_url(folder/'placement.svg'),flatImageUrl=core.data_url(folder/'flatlay.png'),
               mappedImageUrl=core.data_url(folder/'mapped-preview.png'),
               message=f'已按 {len(part["effects"])} 类痕迹生成 {len(kit["stages"])} 道工序；先打印定位图并试做小样')
    # Portable manifest names are useful without this installation's /data route.
    (folder/'manifest.json').write_text(json.dumps(kit,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    (folder/'manual.html').write_text(_manual(kit,folder),encoding='utf-8')
    with zipfile.ZipFile(folder/'making-kit.zip','w',zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(folder.iterdir()):
            if path.is_file() and path.name != 'making-kit.zip': archive.write(path,path.name)
    return kit
