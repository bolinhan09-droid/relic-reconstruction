"""Blend editable effects on one shared garment, keeping images and provenance intact."""
from __future__ import annotations
import copy
import hashlib
import json
import uuid
from pathlib import Path
from PIL import Image
import brush_workflow as brush
from .store import fail


def blend_editable(core, workflow, node, task):
    from .adapters import local_image_path
    nodes = {item["id"]: item for item in workflow["nodes"]}
    candidates = []
    digest = None
    surface_signature = None
    for identifier in task["candidateIds"]:
        output = nodes[identifier].get("output") or {}
        project = copy.deepcopy(output.get("projectSnapshot") or (core.get_project(output["projectId"]) if output.get("projectId") else {}))
        if output.get('imageSemantics') == 'raster_base' or output.get("rasterized") or output.get("editableStrokes") is False or not project:
            fail("候选中包含已生成的整张图片，请使用图像融合。实时笔触融合需要同一底图的可编辑方案。")
        reference = project.get("reference") or output.get("reference") or {}
        project["reference"] = copy.deepcopy(reference)
        path = local_image_path(core, reference.get("url"))
        current_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest and digest != current_hash: fail("候选底图不一致，请使用图像融合，避免错位叠画。")
        digest = current_hash
        project["brushStrokes"] = brush.validate_brush_strokes(output.get("brushStrokes", project.get("brushStrokes", [])))
        if 'protectedRects' in output:
            project['protectedRects'] = copy.deepcopy(output['protectedRects'])
        if 'surfaceOptions' in output:
            project['surfaceOptions'] = copy.deepcopy(output['surfaceOptions'])
        surface = project.get('surfaceOptions') or {}
        signature = json.dumps({k: v for k, v in surface.items() if k != 'backgroundVisible'}
                               if surface.get('enabled') else None, sort_keys=True)
        if surface_signature is not None and signature != surface_signature:
            fail('候选使用不同的褶皱贴合设置，请先统一表面设置，或使用图像融合，避免痕迹被错误重投影。')
        surface_signature = signature
        if project.get("damageItems"): fail("候选包含旧版区域效果，请先转换为笔触，或使用图像融合。")
        if any(stroke["type"] == "erase" for stroke in project["brushStrokes"]): fail("候选包含独立擦除层，请先整理图层，或使用图像融合。")
        candidates.append((identifier, project, path))
    base_id = task["baseNodeId"]
    base = next(project for identifier, project, _ in candidates if identifier == base_id)
    base_path = next(path for identifier, _, path in candidates if identifier == base_id)
    result = copy.deepcopy(base); result.pop("id", None); result.pop("revision", None)
    scope = task.get("effectScope", "all")
    included = {"blood"} if scope == "blood" else {"wear", "slash", "burn"} if scope == "wear" else {"blood", "wear", "slash", "burn"}
    choices = task.get("featureSources", {})
    # Shared ancestors often occur in every branch. Painting one unchanged
    # translucent stroke twice changes its opacity even when weights sum to 1.
    # Match equal strokes across candidates by content plus occurrence ordinal;
    # duplicates deliberately present within one candidate remain separate.
    groups = {}
    for index, (identifier, project, _) in enumerate(candidates):
        occurrences = {}
        for stroke in project["brushStrokes"]:
            content = json.dumps({k: v for k, v in stroke.items() if k != 'id'}, sort_keys=True, separators=(',', ':'))
            ordinal = occurrences.get(content, 0)
            occurrences[content] = ordinal + 1
            effect = stroke["type"]
            if effect not in included:
                weight = 1 if identifier == base_id else 0
            elif choices.get(effect): weight = 1 if choices[effect] == identifier else 0
            else: weight = task["weights"][index]
            if weight <= 0: continue
            key = (content, ordinal)
            if key not in groups:
                groups[key] = {'stroke': copy.deepcopy(stroke), 'weight': 0.}
            groups[key]['weight'] = min(1., groups[key]['weight'] + weight)
    strokes = []
    for group in groups.values():
        value, weight = group['stroke'], group['weight']
        value['id'] = 'blend-' + str(len(strokes))
        value["opacity"] = round(value["opacity"] * weight, 6); strokes.append(value)
        for shape in value["shapes"]:
            shape["alpha"] = round(shape["alpha"] * weight, 6)
    if not strokes: fail("候选没有可融合的笔触。")
    result["brushStrokes"] = brush.validate_brush_strokes(strokes)
    result["protectedRects"] = []
    for _, project, _ in candidates:
        for rect in project.get("protectedRects", []):
            if rect not in result["protectedRects"]:
                result["protectedRects"].append(rect)
    folder = Path(core.DATA) / "node-studio" / "blends" / ("blend-" + uuid.uuid4().hex[:16]); folder.mkdir(parents=True)
    with Image.open(base_path) as source:
        preview = brush.render_brush_guide(source, result); preview.save(folder / "preview.png")
    return {"kind": "garment", "imageUrl": core.data_url(folder / "preview.png"), "reference": result["reference"],
            "projectSnapshot": result, "brushStrokes": strokes, "protectedRects": result["protectedRects"],
            "imageSemantics": "editable_preview", "editableStrokes": True, "rasterized": False,
            "generatedBy": "local_editable_blend", "candidateIds": task["candidateIds"], "weights": task["weights"],
            "featureSources": choices, "apiRequest": False,
            "message": "已按比例混合可编辑痕迹并保留各候选保护区；可以继续精修。"}
