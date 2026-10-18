"""Deterministic brush guides and protected AI refinement of their exact mask.

Persist shapes rather than regenerating random splatter. Shape alpha is final
visual alpha; opacity is retained as a UI setting and is not multiplied again.
Any positive-alpha erase fully withdraws the covered edit area and guide paint.
"""
from __future__ import annotations

import copy
import hashlib
import io
import math
import re
import uuid
import zipfile
from pathlib import Path

from fastapi import File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from PIL import Image, ImageChops, ImageDraw, ImageOps, ImageFilter, ImageMath

import manual_workflow as manual

BRUSH_TYPES = {"blood", "slash", "wear", "burn", "erase"}
LABELS = {"blood": "血迹", "slash": "刀痕", "wear": "磨损", "burn": "焦痕", "erase": "擦除"}
EFFECT_SUBTYPES = {
    "blood": {"splatter": "定向飞溅", "soak": "浸染", "drip": "流淌", "contact": "接触擦抹"},
    "slash": {"slit": "刀口", "frayed": "撕裂毛边", "hole": "破洞"},
    "wear": {"scuff": "擦伤", "fade": "磨白褪色", "mud_splatter": "泥点", "mud_smear": "泥污",
             "dust": "积尘", "water_stain": "干后水渍汗渍"},
    "burn": {"char": "仿炭化", "smoke": "烟熏", "scorched_edge": "焦边过渡"},
}
MAX_STROKES, MAX_SHAPES, MAX_POINTS = 80, 20_000, 2_000
MAX_POLYGON_POINTS, MAX_VERTICES = 256, 200_000
MAX_RASTER_AREA = 250_000_000
SETTINGS = ("provider", "model", "quality", "region", "workspaceId", "baseUrl")


def _fail(message="画笔数据格式不正确，请重新绘制或恢复有效草稿"):
    raise HTTPException(422, message)


def _number(value, minimum=0., maximum=1.) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        _fail("画笔坐标、大小与透明度须为有限的 0–1 数值")
    return float(value)


def _points(value, maximum, minimum=0):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        _fail("画笔点数超限或形状顶点不完整")
    output = []
    for point in value:
        if not isinstance(point, dict) or set(point) != {"x", "y"}:
            _fail()
        output.append({"x": _number(point["x"]), "y": _number(point["y"])})
    return output


def _color(value):
    if not isinstance(value, str) or not re.fullmatch(r"#[A-Fa-f0-9]{3}(?:[A-Fa-f0-9]{3})?", value):
        _fail("画笔颜色须为 #RGB 或 #RRGGBB")
    value = value.lower()
    return "#" + "".join(c * 2 for c in value[1:]) if len(value) == 4 else value


def _polygon(value):
    points = _points(value, MAX_POLYGON_POINTS, 3)
    if points[0] == points[-1]:
        points.pop()
    if len(points) < 3:
        _fail("许可区域至少需要三个不同顶点")
    area = abs(sum(p["x"] * points[(i + 1) % len(points)]["y"] - points[(i + 1) % len(points)]["x"] * p["y"] for i, p in enumerate(points))) / 2
    if area < 1e-8:
        _fail("许可区域面积太小，请重新圈选")
    def cross(a, b, c):
        return (b["x"] - a["x"]) * (c["y"] - a["y"]) - (b["y"] - a["y"]) * (c["x"] - a["x"])
    for i, a in enumerate(points):
        b = points[(i + 1) % len(points)]
        for j in range(i + 2, len(points)):
            if i == 0 and j == len(points) - 1:
                continue
            c, d = points[j], points[(j + 1) % len(points)]
            if cross(a, b, c) * cross(a, b, d) < -1e-14 and cross(c, d, a) * cross(c, d, b) < -1e-14:
                _fail("许可区域不能自交，请重新圈选")
    return points


def _blood_metadata(stroke, points):
    """V2 controls describe recorded user input, not physical blood behaviour.

    The source of geometry remains saved ellipse/polygon shapes. Metadata is
    bounded and validated rather than used to execute commands, fetch images or
    regenerate geometry with a different random sequence.
    """
    names = {"bloodVersion", "bloodBehavior", "bloodParameters"}
    if not names.intersection(stroke):
        return {}
    if (stroke["type"] != "blood" or not names.issubset(stroke)
            or isinstance(stroke["bloodVersion"], bool) or not isinstance(stroke["bloodVersion"], int) or stroke["bloodVersion"] != 2
            or not isinstance(stroke["bloodBehavior"], str) or stroke["bloodBehavior"] not in {"splatter", "soak"}
            or not isinstance(stroke["bloodParameters"], dict)):
        _fail("新版血迹须保存 bloodVersion:2、飞溅或浸染类型，以及完整的对应参数")
    value, behaviour = stroke["bloodParameters"], stroke["bloodBehavior"]
    if behaviour == "splatter":
        if set(value) != {"origin", "target", "force", "spread", "amount"}:
            _fail("飞溅参数只接受起点、终点、力度、散布和染色量")
        ends = _points([value["origin"], value["target"]], 2, 2)
        if points != ends:
            _fail("飞溅记录的起点与终点须与已保存笔触一致")
        clean = {"origin": ends[0], "target": ends[1],
                 **{name: _number(value[name]) for name in ("force", "spread", "amount")}}
    else:
        if set(value) != {"flow", "edgeSoftness", "pressures"}:
            _fail("浸染参数只接受流量、边缘柔和度和已记录的压力列表")
        pressures = value["pressures"]
        if not 1 <= len(points) <= 1200 or not isinstance(pressures, list) or len(pressures) != len(points):
            _fail("浸染压力须与笔触点逐一对应，最多1200点")
        clean = {"flow": _number(value["flow"]), "edgeSoftness": _number(value["edgeSoftness"]),
                 "pressures": [_number(number) for number in pressures]}
    return {"bloodVersion": 2, "bloodBehavior": behaviour, "bloodParameters": clean}


def validate_brush_options(project):
    mode = project.get("brushRefineMode", "strict")
    if not isinstance(mode, str) or mode not in {"strict", "natural"}:
        _fail("精修模式须为 strict 或 natural")
    entries = project.get("brushEditRegions", [])
    if not isinstance(entries, list) or len(entries) > 30:
        _fail("每份方案最多30个许可区域")
    result, identifiers = [], set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"id", "points", "type"}:
            _fail("许可区域须包含 id、points 和 type")
        identifier = entry["id"]
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", identifier) or identifier in identifiers:
            _fail("许可区域编号须有效且不重复")
        if not isinstance(entry["type"], str) or entry["type"] not in BRUSH_TYPES - {"erase"}:
            _fail("许可区域类型须为血迹、刀痕、磨损或焦痕")
        identifiers.add(identifier)
        result.append({"id": identifier, "points": _polygon(entry["points"]), "type": entry["type"]})
    return {"brushRefineMode": mode, "brushEditRegions": result}


def validate_brush_strokes(value) -> list[dict]:
    if not isinstance(value, list) or len(value) > MAX_STROKES:
        _fail("每份方案最多保存 80 笔画笔，请合并或清理后再保存")
    output, identifiers, shape_count, vertex_count = [], set(), 0, 0
    required = {"id", "type", "size", "opacity", "seed", "points", "shapes"}
    optional = {"color", "mode", "spread", "direction", "region", "bloodVersion", "bloodBehavior", "bloodParameters", "effectSubtype", "effectParameters"}
    for stroke in value:
        if not isinstance(stroke, dict) or not required.issubset(stroke) or set(stroke) - required - optional:
            _fail("每笔须包含 id、type、size、opacity、seed、points 与 shapes")
        identifier = stroke["id"]
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", identifier) or identifier in identifiers:
            _fail("画笔编号须为不重复的有效编号")
        identifiers.add(identifier)
        if not isinstance(stroke["type"], str) or stroke["type"] not in BRUSH_TYPES:
            _fail("画笔仅支持血迹、刀痕、磨损、焦痕和擦除")
        seed = stroke["seed"]
        if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2 ** 32 - 1:
            _fail("画笔随机种子须为有效的 uint32 整数")
        size, opacity = _number(stroke["size"]), _number(stroke["opacity"])
        extras = {}
        if "effectSubtype" in stroke:
            subtype = stroke["effectSubtype"]
            if not isinstance(subtype, str) or subtype not in EFFECT_SUBTYPES.get(stroke["type"], {}):
                _fail("痕迹子类型与当前画笔不匹配")
            extras["effectSubtype"] = subtype
        if "effectParameters" in stroke:
            params = stroke["effectParameters"]
            if "effectSubtype" not in extras or not isinstance(params, dict) or set(params) - {"detail", "age", "wetness"}:
                _fail("详细笔刷仅接受 detail、age、wetness 参数，并须指定子类型")
            extras["effectParameters"] = {name: _number(number) for name, number in params.items()}
        if "color" in stroke:
            extras["color"] = _color(stroke["color"])
        if "mode" in stroke:
            if not isinstance(stroke["mode"], str) or stroke["mode"] not in {"free", "edge", "area"}:
                _fail("笔触模式须为 free、edge 或 area")
            extras["mode"] = stroke["mode"]
        if "spread" in stroke:
            extras["spread"] = _number(stroke["spread"])
        if "direction" in stroke:
            extras["direction"] = _number(stroke["direction"], -2 * math.pi, 2 * math.pi)
        if "region" in stroke:
            if not isinstance(stroke["region"], dict) or set(stroke["region"]) != {"points"}:
                _fail("圈区笔触范围须为 points 多边形")
            extras["region"] = {"points": _polygon(stroke["region"]["points"])}
        if extras.get("mode") == "area" and "region" not in extras:
            _fail("圈区笔触须保存完整的圈选范围")
        points = _points(stroke["points"], MAX_POINTS)
        extras.update(_blood_metadata(stroke, points))
        if not isinstance(stroke["shapes"], list):
            _fail()
        shape_count += len(stroke["shapes"])
        if shape_count > MAX_SHAPES:
            _fail("方案形状总数超过 20000，请清理后再保存")
        shapes = []
        for shape in stroke["shapes"]:
            if not isinstance(shape, dict):
                _fail()
            kind = shape.get("kind", shape.get("type"))
            tag = "kind" if "kind" in shape else "type"
            fields = {tag, "cx", "cy", "rx", "ry", "color", "alpha"} if kind == "ellipse" else {tag, "points", "color", "alpha"}
            if not isinstance(kind, str) or kind not in {"ellipse", "polygon"} or set(shape) != fields:
                _fail("画笔形状须为 ellipse 或 polygon，不能包含未知字段")
            color = _color(shape["color"])
            entry = {"kind": kind, "color": color, "alpha": _number(shape["alpha"])}
            if kind == "ellipse":
                entry.update({name: _number(shape[name]) for name in ("cx", "cy", "rx", "ry")})
            else:
                entry["points"] = _points(shape["points"], MAX_POLYGON_POINTS, 3)
                vertex_count += len(entry["points"])
                if vertex_count > MAX_VERTICES:
                    _fail("多边形顶点总数超限，请简化画笔方案")
            shapes.append(entry)
        output.append({"id": identifier, "type": stroke["type"], "size": size, "opacity": opacity,
                       "seed": seed, "points": points, "shapes": shapes, **extras})
    return output


def _protected(project, size):
    entries = project.get("protectedRects", [])
    if not isinstance(entries, list) or len(entries) > 30:
        _fail("保护区域格式不正确")
    width, height = size
    output = Image.new("L", size, 0)
    draw = ImageDraw.Draw(output)
    for entry in entries:
        if not isinstance(entry, dict):
            _fail("保护区域格式不正确")
        rect = entry.get("rect", entry)
        if not isinstance(rect, dict) or not {"x", "y", "w", "h"}.issubset(rect):
            _fail("保护区域格式不正确")
        x, y, w, h = (_number(rect[name]) for name in ("x", "y", "w", "h"))
        if w <= 0 or h <= 0 or x + w > 1.000001 or y + h > 1.000001:
            _fail("保护区域须位于原图范围内")
        left, top = int(x * width), int(y * height)
        right, bottom = min(width, math.ceil((x + w) * width)), min(height, math.ceil((y + h) * height))
        draw.rectangle((left, top, max(left, right - 1), max(top, bottom - 1)), fill=255)
    return output


def _shape_patch(shape, size):
    width, height = size
    if shape["kind"] == "ellipse":
        cx, cy, rx, ry = shape["cx"] * width, shape["cy"] * height, shape["rx"] * width, shape["ry"] * height
        if rx == 0 or ry == 0:
            return None
        extents = cx - rx, cy - ry, cx + rx, cy + ry
    else:
        points = [(point["x"] * width, point["y"] * height) for point in shape["points"]]
        extents = min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)
    left, top = max(0, math.floor(extents[0])), max(0, math.floor(extents[1]))
    right, bottom = min(width, math.ceil(extents[2]) + 1), min(height, math.ceil(extents[3]) + 1)
    if right <= left or bottom <= top:
        return None
    coverage = Image.new("L", (right - left, bottom - top), 0)
    draw = ImageDraw.Draw(coverage)
    if shape["kind"] == "ellipse":
        draw.ellipse((cx - rx - left, cy - ry - top, cx + rx - left, cy + ry - top), fill=255)
    else:
        draw.polygon([(x - left, y - top) for x, y in points], fill=255)
    return (left, top, right, bottom), coverage


def _polygon_mask(points, size):
    result = Image.new("L", size, 0)
    width, height = size
    ImageDraw.Draw(result).polygon([(p["x"] * width, p["y"] * height) for p in points], fill=255)
    return result


def shade_blood_layer(paint: Image.Image, source: Image.Image) -> Image.Image:
    """Drape pigment colour over original photo lightness; preserve paint alpha.

    Shared with Canvas as integer sRGB-byte arithmetic, a display heuristic, not
    a linear-light, spectral-pigment, cloth-flow or material-absorption model:
      Y = (77*R + 150*G + 29*B + 128) // 256
      C' = (C * (7140 + 72*Y) + 12750) // 25500
    i.e. C' rounds C * (0.28 + 0.72*Y/255). Original source is sampled, never an
    already tinted preview, so repeated redraws do not progressively darken.
    """
    if paint.size != source.size:
        _fail("血迹图层与原始照片尺寸不一致")
    paint = paint.convert("RGBA")
    red, green, blue = (band.convert("I") for band in source.convert("RGB").split())
    luma = ImageMath.lambda_eval(lambda v: (77*v["r"] + 150*v["g"] + 29*v["b"] + 128) / 256,
                                 r=red, g=green, b=blue)
    bands = []
    for channel in paint.split()[:3]:
        band = ImageMath.lambda_eval(lambda v: (v["c"] * (7140 + 72*v["y"]) + 12750) / 25500,
                                     c=channel.convert("I"), y=luma)
        bands.append(band.convert("L"))
    return Image.merge("RGBA", (*bands, paint.getchannel("A")))


def _raster(project, size, with_paint=False, source=None):
    width, height = size
    if not isinstance(width, int) or not isinstance(height, int) or min(size) < 1 or width * height > manual.MAX_PIXELS:
        _fail("画笔画布尺寸无效或超过平台限制")
    strokes = validate_brush_strokes(project.get("brushStrokes", []))
    mask = Image.new("L", size, 0)
    layer = Image.new("RGBA", size, (0, 0, 0, 0)) if with_paint else None
    raster_area = 0
    for stroke in strokes:
        v2 = with_paint and stroke["type"] == "blood" and stroke.get("bloodVersion") == 2
        if v2 and (source is None or source.size != size):
            _fail("新版血迹预览须使用尺寸一致的原始照片")
        stroke_layer = Image.new("RGBA", size, (0, 0, 0, 0)) if v2 else layer
        area_limit = _polygon_mask(stroke["region"]["points"], size) if stroke.get("mode") == "area" else None
        for shape in stroke["shapes"]:
            if shape["alpha"] <= 0:
                continue
            patch = _shape_patch(shape, size)
            if patch is None:
                continue
            box, coverage = patch
            if area_limit is not None:
                coverage = ImageChops.multiply(coverage, area_limit.crop(box))
            raster_area += coverage.width * coverage.height
            if raster_area > MAX_RASTER_AREA:
                _fail("笔划覆盖面积过多，请撤销或简化部分笔划后再生成")
            if stroke["type"] == "erase":
                mask.paste(0, box, coverage)
                if layer is not None:
                    previous = layer.crop(box)
                    previous.putalpha(ImageChops.subtract(previous.getchannel("A"), coverage))
                    layer.paste(previous, box)
            else:
                mask.paste(255, box, coverage)
                if layer is not None:
                    paint = Image.new("RGBA", coverage.size, shape["color"])
                    # alpha is already final; never multiply stroke.opacity again.
                    paint.putalpha(coverage.point(lambda value: round(shape["alpha"] * value)))
                    stroke_layer.alpha_composite(paint, dest=(box[0], box[1]))
        if v2:
            bounds = stroke_layer.getbbox()
            if bounds:
                shaded = shade_blood_layer(stroke_layer.crop(bounds), source.crop(bounds))
                layer.alpha_composite(shaded, dest=(bounds[0], bounds[1]))
    from surface_workflow import render_surface
    mask, layer = render_surface(project, mask, layer)
    # Geometry may move pigment across a protected edge; protection wins after
    # displacement too, and the AI edit mask follows the very same geometry.
    mask = ImageChops.subtract(mask, _protected(project, size))
    if layer is not None:
        layer.putalpha(ImageChops.multiply(layer.getchannel("A"), mask))
    return mask, layer


def brush_mask(project: dict, size: tuple[int, int]) -> Image.Image:
    """L binary union in stroke order, erasures and protected rectangles removed."""
    return _raster(project, size)[0]


def effective_brush_mask(core, project: dict, size: tuple[int, int], existing_brush_mask=None) -> Image.Image:
    """Brushes plus legacy design rectangles, then one shared protection pass.

    Erasers cancel brush paint, not independent rectangle selections. A selected
    rectangle must be deleted to withdraw its edit permission.
    """
    options = validate_brush_options(project)
    if options["brushRefineMode"] == "natural":
        strokes = validate_brush_strokes(project.get("brushStrokes", []))
        regions = list(options["brushEditRegions"])
        linked = {entry["id"] for entry in regions}
        # Area drawing itself is an explicit region selection; keep its boundary.
        for stroke in strokes:
            if stroke.get("mode") == "area" and stroke["id"] not in linked:
                regions.append({"id": stroke["id"], "points": stroke["region"]["points"], "type": stroke["type"]})
                linked.add(stroke["id"])
        unbounded = {**project, "brushStrokes": [s for s in strokes if s["id"] not in linked or s["type"] == "erase"]}
        free = brush_mask(unbounded, size)
        radius = max(1, min(15, round(min(size) * .009)))
        combined = free.filter(ImageFilter.MaxFilter(radius * 2 + 1))
        # Small gaps can join locally. This is geometry, never cloth segmentation.
        combined = combined.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
        for region in regions:
            combined = ImageChops.lighter(combined, _polygon_mask(region["points"], size))
    else:
        combined = existing_brush_mask.copy() if existing_brush_mask is not None else brush_mask(project, size)
    if project.get("damageItems"):
        for item in core.damage_items(project["damageItems"]):
            combined = ImageChops.lighter(combined, core.mask_for(item, [], size))
    if options["brushRefineMode"] == "natural":
        withdrawn = Image.new("L", size, 0)
        for stroke in validate_brush_strokes(project.get("brushStrokes", [])):
            for shape in stroke["shapes"]:
                patch = _shape_patch(shape, size) if shape["alpha"] > 0 else None
                if patch:
                    box, coverage = patch
                    if stroke.get("mode") == "area":
                        coverage = ImageChops.multiply(coverage, _polygon_mask(stroke["region"]["points"], size).crop(box))
                    withdrawn.paste(255 if stroke["type"] == "erase" else 0, box, coverage)
        hard = ImageChops.subtract(ImageChops.subtract(combined, withdrawn), _protected(project, size))
        softened = hard.filter(ImageFilter.GaussianBlur(max(.75, min(6., min(size) * .004))))
        # Blur is clipped back to permission. No pixel outside hard can change.
        return ImageChops.multiply(softened, hard)
    return ImageChops.subtract(combined, _protected(project, size))


def _mask_source(project):
    if project.get("brushRefineMode") == "natural":
        return "brush_permission_regions_and_local_expansion" if project.get("brushEditRegions") or any(s.get("mode") == "area" for s in project.get("brushStrokes", [])) else "brush_local_expansion"
    return "brush_shapes_and_regions" if project.get("damageItems") else "brush_shapes"


def render_brush_assets(source: Image.Image, project: dict) -> tuple[Image.Image, Image.Image]:
    mask, layer = _raster(project, source.size, with_paint=True, source=source)
    guide = source.convert("RGBA")
    guide.alpha_composite(layer)
    return mask, guide.convert("RGB")


def render_brush_guide(source: Image.Image, project: dict) -> Image.Image:
    """Original plus deterministic paint. A guide, never an AI or physical result."""
    return render_brush_assets(source, project)[1]


def _prompt(core, project, size, has_reference):
    options = validate_brush_options(project)
    active = sorted({stroke["type"] for stroke in project.get("brushStrokes", []) if stroke["type"] != "erase"} | {r["type"] for r in options["brushEditRegions"]})
    lines = ["编辑第一张真实 Cos 服装原图，将第二张画笔引导图的痕迹融合成自然的布料外观。生成单张完整图片，不输出框、编号、文字或说明。",
             "第二张图是用户绘制的位置与外观草图，不是 AI 成品，也不是材料物理模拟。按其痕迹分布、方向和相对程度精修，不把色块当作服装原来的配色。",
             f"保持原图 {size[0]}×{size[1]} 的构图、视角、朝向、宽高比例与人物姿势，不裁切。",
             "只在给出的可编辑范围内改变衣物痕迹；保护区与范围外保留原图。白色二值范围允许编辑，黑色保留；透明蒙版中透明允许、不透明保留。",
             "血迹：使用用户笔触指定的颜色与配套深浅色；仅未指定其他颜色时默认干燥暗红，绿色、蓝色或其他戏剧假血必须保留其指定颜色，不擅自统一改成红色。干燥、哑光、细滴飞溅，附着布面并随褶皱变化，不湿亮流淌，不在皮肤或人体上制造伤口。",
             "刀痕：可辨认的织物断口、自然少量毛边和内层衣料，不把人画成受伤，不改变衣服整体款式。",
             "磨损：局部织物褪色、擦痕、轻度毛化，保留接缝与关键图案，不把磨损自动变成烧焦。",
             "焦痕：局部褐黑焦边或表面熏痕，贴合用户草图；不加火焰、不烧皮肤，不预测真实面料燃烧过程。",
             "对画笔部分，仅精修引导图中实际绘制的类型：" + "、".join(LABELS[name] for name in active) + "。未绘制的类型不要自行添加；下文独立矩形区按其指定类型处理。",
             "保持角色服装廓形、主配色、徽章、扣件、飘带、披风原生轮廓，以及人物身份、脸、手、皮肤和背景。"]
    if options["brushRefineMode"] == "natural":
        lines.append("当前为自然融合：草图表达痕迹意图而非每个斑点的精确终形。在许可圈区中连贯调整飞溅、焦褐渐变和纤维细节；未圈区的自由笔触仅有平台给出的小范围扩展。不能越过最终蒙版或保护区，不进行自动布料分割。灰度蒙版边缘是本地融合过渡，不表示物理损伤强度。")
    else:
        lines.append("当前为严格范围：只精修实际画笔形状和独立矩形范围，不自行扩大痕迹覆盖。")
    blood_v2 = [s for s in project.get("brushStrokes", []) if s.get("type") == "blood" and s.get("bloodVersion") == 2]
    if blood_v2:
        lines.append("新版血迹草图用原照片明暗调色，属于视觉引导，不是布料渗透预测。以第一张原图的纤维、布褶和明暗为准，痕迹要随同一布面起伏，不把颜色盖成平面贴纸；无亮面胶膜、无凸起珠滴。")
        lines.append("血迹具体形态按各笔类型执行，优先于上文默认细滴飞溅：飞溅 splatter 允许分离大小滴点和有方向的短尾；浸染 soak 是连贯、不规则、边缘有深浅过渡的染痕，不要把浸染改成满片圆点或均匀色块。保持用户指定的色组；干燥哑光，不制造湿亮流淌或人体伤口。")
    for stroke in project.get("brushStrokes", []):
        if stroke["type"] == "erase":
            continue
        tones = sorted({shape["color"] for shape in stroke["shapes"] if shape["alpha"] > 0})[:8]
        base = stroke.get("color") or ("、".join(tones) if tones else "以引导图为准")
        lines.append(f"笔触 {stroke['id']}：{LABELS[stroke['type']]}，基色/色组 {base}；方式 {stroke.get('mode', 'free')}；延伸偏好 {stroke.get('spread', .45):.0%}；干燥哑光。")
        if stroke.get("effectSubtype"):
            params = stroke.get("effectParameters", {})
            subtype = EFFECT_SUBTYPES[stroke["type"]][stroke["effectSubtype"]]
            state = "湿润外观，允许适度表面光泽" if params.get("wetness", 0) > .5 else "干后哑光外观"
            lines.append(f"本笔详细意图优先于以上默认概述：{subtype}；{state}；陈旧程度 {params.get('age', 0):.0%}，细节 {params.get('detail', .55):.0%}。流淌保留沿轨迹的连续流痕，接触擦抹保留方向性擦抹纹理；泥点、泥污、积尘和水渍不可改成血迹或烧焦。以上为视觉偏好，不是物理预测。")
        if stroke.get("type") == "blood" and stroke.get("bloodVersion") == 2:
            behaviour = "飞溅 splatter：按起点至终点保留分布方向，以分散滴点为主" if stroke["bloodBehavior"] == "splatter" else "浸染 soak：沿保存的轨迹做连贯染痕，以有纹理与深浅的污渍为主，不额外铺满飞溅圆点"
            lines.append(f"该笔血迹形态：{behaviour}。参数仅表达用户草图偏好，不解释为真实液体速度、吸收率或材料实验结果。")
    for index, region in enumerate(options["brushEditRegions"], 1):
        lines.append(f"许可圈区 {index}（{region['id']}）：仅允许 {LABELS[region['type']]}的视觉调整；多边形归一化顶点 {manual._readable(region['points'])}。")
    preparation = project.get("preparation") if isinstance(project.get("preparation"), dict) else {}
    material = preparation.get("materialKind") or project.get("uploadMaterial") or project.get("material") or "unknown"
    lines += ["用户确认的表面类别（不是纤维鉴定）：" + str(material)[:100],
              "材料查询依据：" + manual._readable(preparation.get("materialEvidence") or project.get("materialEvidence") or []),
              "资料不足时不能由照片断言纤维成分；仅让视觉痕迹贴合照片可见纹理，不预测渗透、清洗或燃烧。"]
    if project.get("damageItems"):
        lines.append("此外，下列矩形设计区域也允许编辑，坐标以第一张原图左上为原点并归一化。引导图未画矩形框，不要将标注框画进成品。保护区优先保留；擦除只撤销画笔，不撤销独立矩形区域。")
        for index, item in enumerate(core.damage_items(project["damageItems"]), 1):
            rect = item["rect"]
            lines.append(f"矩形 {index}：{LABELS.get(item['type'], item['type'])}，x={rect['x']:.3f}, y={rect['y']:.3f}, w={rect['w']:.3f}, h={rect['h']:.3f}；视觉编辑程度 {item['intensity']:.0%}；{item.get('notes') or '按该类型自然处理'}。")
        lines.append("以上程度是视觉偏好，不代表物理损伤或颜料用量；这些矩形中可按指定类型添加痕迹。")
    if has_reference:
        lines.append("第三张二维参考只提供用户选择的外观方向，不把角色绘画的脸、体型、背景或服装结构替换进第一张照片。")
    if project.get("scenarioId"):
        scene = core.scenario_for(project)
        lines += ["用户已选择的情境：" + str(scene.get("title") or "已选择情境"),
                  "有依据的背景：" + manual._readable(scene.get("verifiedClaims") or scene.get("canonFacts") or []),
                  "痕迹具体位置与形态为视觉设计推演，不宣称是原作事实。"]
    else:
        lines.append("用户没有指定剧情，以照片与画笔草图为准，不自动套用任何角色故事或攻击事实。")
    lines += ["用户补充：" + str(project.get("customDamageIdea") or "无")[:4000],
              "这是衣服照片的视觉方案；真实渗色、手感、破口强度、清洗与恢复必须通过面料小样确认。"]
    return "\n".join(lines) + "\n"


def _assets(core, project):
    path, raw, original = manual._source(core, project)
    validate_brush_strokes(project.get("brushStrokes", []))
    stroke_mask, guide = render_brush_assets(original, project)
    mask = effective_brush_mask(core, project, original.size, stroke_mask)
    if mask.getbbox() is None:
        _fail("没有可精修的画笔区域：笔划可能已擦除、透明或被保护区覆盖。请先绘制痕迹。")
    reference = manual._concept_source(core, project)
    return path, raw, original, mask, guide, reference


def _aligned(generated, original):
    difference = abs((generated.width / generated.height) / (original.width / original.height) - 1)
    if difference > .05:
        _fail("精修图片与原图宽高比差异超过 5%，无法可靠对齐笔划。请使用相同构图与比例重新生成。")
    resized = generated.size != original.size
    result = generated.resize(original.size, Image.Resampling.LANCZOS) if resized else generated.copy()
    return result, {"inputSize": list(generated.size), "sourceSize": list(original.size), "outputSize": list(original.size),
                    "resizedToSource": resized, "aspectRatioDeviation": difference,
                    "compositedLocally": True, "editableMaskApplied": True,
                    "message": "结果按精确笔划范围合成；" + ("尺寸不一致，已缩放至原图，需检查边缘与痕迹比例。" if resized else "尺寸一致，仍需人工检查痕迹与服装结构。")}


def _check_current(core, project, path, raw):
    current = core.get_project(project["id"])
    if current != project:
        raise HTTPException(409, "读取图片期间方案或笔划版本已修改，请重新生成对应版本。")
    current_path, current_raw, _ = manual._source(core, current)
    if current_path.resolve() != path.resolve() or current_raw != raw:
        raise HTTPException(409, "服装原图已变化，结果不能作为当前版本保存。")


def _validation(passed=None, mask_source="brush_shapes"):
    return {"kind": "pixel_protection", "passed": passed, "semanticAI": False,
            "outsideMaskUnchanged": passed, "protectedRegionsUnchanged": passed, "maskSource": mask_source,
            "physicalSimulation": False,
            "message": "本地检查仅确认最终许可编辑范围外与保护区像素保留；范围内衣物结构、角色还原、痕迹自然程度与边缘衔接仍须人工检查。"}


def _save_result(core, folder, original, generated, mask, receipt, mask_source="brush_shapes", project=None):
    final = Image.composite(generated, original, mask)
    difference = ImageChops.difference(final, original)
    support = mask.point(lambda value: 255 if value > 0 else 0)
    intact = Image.composite(difference, Image.new("RGB", original.size), ImageOps.invert(support)).getbbox() is None
    if not intact:
        raise HTTPException(500, "画笔范围外像素检查未通过，未保存最终结果")
    (folder / "result.png").write_bytes(manual._png(final))
    raw_path = folder / "generated-original.png"
    if not raw_path.exists():
        raw_path.write_bytes(manual._png(generated))
    refine_mode = (project or {}).get("brushRefineMode", "strict")
    receipt.update({"refineMode": refine_mode, "permissionFeathered": refine_mode == "natural",
                    "rawOutputPreserved": True, "automaticClothSegmentation": False,
                    "message": ("自然融合：在已许可圈区和自由笔触的小范围扩展内向内羽化；" if refine_mode == "natural" else "严格融合：按实际笔触二值范围合成；") + "范围外与保护区保留原图。原始生成图另存，可对比检查；视觉方案不是材料物理模拟。"})
    validation = _validation(True, mask_source)
    core.write_json(folder / "validation.json", validation)
    url = core.data_url(folder / "result.png")
    return {"status": "succeeded", "progress": 1., "completedAt": core.now(), "outputUrl": url, "previewUrl": url,
            "result": {"url": url, "rawOutputUrl": core.data_url(raw_path)}, "rawOutputUrl": core.data_url(raw_path), "guidePreviewUrl": core.data_url(folder / "brush-guide.png"),
            "maskUrl": core.data_url(folder / "mask.png"), "validation": validation, "importReceipt": receipt,
            "message": "画笔痕迹已精修并按编辑范围合成，请检查服装结构与自然程度。"}


def _job(core, project, identifier, mode, provider, model=None, quality=None):
    return {"id": identifier, "projectId": project["id"], "projectRevision": project["revision"], "artifactKind": "costume",
            "mode": mode, "provider": provider, "model": model, "quality": quality,
            "generatedBy": "manual_external_image" if mode == "manual_brush_import" else provider + "_image_api",
            "status": "queued", "progress": 0., "message": "画笔精修已排队", "steps": [],
            "createdAt": core.now(), "updatedAt": core.now(), "validation": _validation(mask_source=_mask_source(project)),
            "brushStrokeCount": len(project.get("brushStrokes", [])), "semanticAI": False}


def _persist_inputs(core, folder, project, original, mask, guide):
    for filename, value in (("original.png", original), ("mask.png", mask), ("brush-guide.png", guide)):
        (folder / filename).write_bytes(manual._png(value))
    core.write_json(folder / "project-snapshot.json", project)


def build_brush_handoff(core, project_id, project_revision=None):
    with core.LOCK:
        project = copy.deepcopy(core.get_project(project_id))
        if project_revision is not None and project["revision"] != manual._revision(project_revision):
            raise HTTPException(409, "笔划方案版本已修改，请刷新并重新保存当前版本后再导出。")
        _, raw, original, mask, guide, reference = _assets(core, project)
        prompt = _prompt(core, project, original.size, reference is not None)
    transparent = Image.new("RGBA", original.size, (255, 255, 255, 255))
    transparent.putalpha(ImageOps.invert(mask))
    manifest = {"schemaVersion": "brush-handoff-1", "artifactKind": "costume", "projectId": project_id,
                "projectRevision": project["revision"], "sourceSize": list(original.size), "sourceSha256": hashlib.sha256(raw).hexdigest(),
                "brushStrokes": validate_brush_strokes(project.get("brushStrokes", [])),
                **validate_brush_options(project),
                "damageItems": project.get("damageItems", []), "maskSource": _mask_source(project), "apiRequest": False,
                "guideIsAIResult": False, "physicalSimulation": False, "semanticAI": False}
    instructions = (f"项目：{project_id}\n版本：{project['revision']}\n\n"
        "1. 解压，在 ChatGPT 网页上传原图、画笔引导、蒙版；可选上传二维参考，复制提示词生成一张图。\n"
        "2. 画笔引导是用户草图，不是 AI 成品或材料模拟。透明蒙版透明允许编辑、不透明保留；灰度图白色允许、黑色保留，灰边仅表示本地融合过渡。\n"
        "3. 此包不自动登录账号或调用 API。下载图片后导回画笔精修；须对应以上项目版本，修改笔划后需重新导出。\n"
        "4. 比例差异超过 5% 拒绝导回；其他尺寸变化会记录缩放。严格模式按笔划合成；自然模式按许可圈区及自由笔触的小范围扩展向内羽化；保护区与范围外保留原图，原始生成图另存可比较。\n"
        "5. 独立矩形设计区若仍存在，也包含在允许编辑范围中；画笔擦除不会撤销矩形，请删除矩形来撤销该区。\n"
        "6. 像素检查不证明外观质量、角色还原或材料可实施性。检查边缘与结构，制作前仍需实际面料小样。\n")
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for filename, value in (("01_服装原图.png", original), ("02_画笔引导.png", guide),
                                ("04_可编辑区域.png", mask), ("05_透明编辑蒙版.png", transparent)):
            archive.writestr(filename, manual._png(value))
        if reference is not None:
            archive.writestr("03_二维参考.png", manual._png(reference))
        archive.writestr("提示词.txt", prompt.encode("utf-8-sig"))
        archive.writestr("操作说明.txt", instructions.encode("utf-8-sig"))
        archive.writestr("交接记录.json", manual._json_bytes(manifest))
    return Response(output.getvalue(), media_type="application/zip", headers={
        "Content-Disposition": f'attachment; filename="{project_id}-revision-{project["revision"]}-brush-handoff.zip"',
        "X-Project-Revision": str(project["revision"]), "X-Artifact-Kind": "costume", "Cache-Control": "no-store"})


async def import_brush_result(core, project_id, file, project_revision):
    try:
        revision = manual._revision(project_revision)
        with core.LOCK:
            project = copy.deepcopy(core.get_project(project_id))
            if project["revision"] != revision:
                raise HTTPException(409, "笔划方案版本已修改，请重新下载生成包并生图。")
            path, raw, original, mask, guide, _ = _assets(core, project)
        content = await file.read(core.MAX_UPLOAD + 1)
        if len(content) > core.MAX_UPLOAD:
            raise HTTPException(413, "导回图片不应超过 20 MB")
        decoded = manual._decode(content)
        generated, receipt = _aligned(decoded, original)
        receipt["externalProviderVerified"] = False
        with core.LOCK:
            _check_current(core, project, path, raw)
            identifier = "job-brush-manual-" + uuid.uuid4().hex[:16]
            folder = core.DATA / "jobs" / identifier
            folder.mkdir(parents=True, exist_ok=False)
            _persist_inputs(core, folder, project, original, mask, guide)
            (folder / "imported-image.png").write_bytes(manual._png(decoded))
            (folder / "generated-original.png").write_bytes(manual._png(decoded))
            core.write_json(folder / "configuration.json", {"artifactKind": "costume", "mode": "manual_brush_import",
                "provider": "manual_external_import", "model": None, "apiRequest": False, "automaticAccountAccess": False,
                "externalProviderVerified": False, "sourceSha256": hashlib.sha256(raw).hexdigest(),
                "importedSha256": hashlib.sha256(content).hexdigest(), "importReceipt": receipt,
                "maskSource": _mask_source(project), "physicalSimulation": False, "semanticAI": False,
                "originalFileName": Path(file.filename or "brush-image").name[:200]})
            job = _job(core, project, identifier, "manual_brush_import", "manual_external_import")
            job.update(_save_result(core, folder, original, generated, mask, receipt, _mask_source(project), project), externalProviderVerified=False, updatedAt=core.now())
            core.write_json(folder / "job.json", job)
            return job
    finally:
        await file.close()


def _generate(core, identifier, project, settings, key, path, raw, original, mask, guide, reference):
    folder, provider = core.DATA / "jobs" / identifier, core.cloud_provider
    try:
        core.update_job(identifier, status="running", progress=.1, message="正在把画笔引导融合为自然布料痕迹")
        _persist_inputs(core, folder, project, original, mask, guide)
        working, working_guide = original.copy(), guide.copy()
        working.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
        working_guide = working_guide.resize(working.size, Image.Resampling.LANCZOS)
        images = [manual._png(working), manual._png(working_guide)]
        if reference is not None:
            reference = reference.copy()
            reference.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
            images.append(manual._png(reference))
        transparent = Image.new("RGBA", working.size, (255, 255, 255, 255))
        transparent.putalpha(ImageOps.invert(mask.resize(working.size, Image.Resampling.NEAREST)))
        prompt = _prompt(core, project, original.size, reference is not None)
        server_mask = settings["provider"] in {"openai", "openai_compatible", "local_openai"}
        core.write_json(folder / "configuration.json", {**settings, "artifactKind": "costume", "mode": "cloud_brush_refine",
            "prompt": prompt, "maskSource": _mask_source(project), "guideIsAIResult": False, "requestCount": 1,
            "automaticRetry": False, "inputImageCount": len(images), "serverMask": server_mask, "physicalSimulation": False,
            "sourceSha256": hashlib.sha256(raw).hexdigest()})
        content, metadata = provider.edit(images, prompt, manual._png(transparent) if server_mask else None, settings, key)
        if len(content) > 48 * 1024 * 1024:
            raise provider.CloudError("接口图片超过平台大小限制，未再次调用接口。")
        decoded = manual._decode(content)
        (folder / "api-output.png").write_bytes(manual._png(decoded))
        (folder / "generated-original.png").write_bytes(manual._png(decoded))
        safe_metadata = {name: metadata[name] for name in ("provider", "model", "quality", "requestId", "usage", "baseUrl") if name in metadata}
        core.write_json(folder / "generation-source.json", {**safe_metadata, "artifactKind": "costume", "maskSource": _mask_source(project),
                       "requestCount": 1, "serverMask": server_mask, "physicalSimulation": False})
        generated, receipt = _aligned(decoded, original)
        with core.LOCK:
            _check_current(core, project, path, raw)
            result = _save_result(core, folder, original, generated, mask, receipt, _mask_source(project), project)
            core.update_job(identifier, **result, usage=provider.safe_usage(metadata.get("usage", {})))
    except Exception as exc:
        message = str(exc) if isinstance(exc, provider.CloudError) else str(exc.detail) if isinstance(exc, HTTPException) else "画笔精修未完成，请检查图片与图像服务；平台未自动重试。"
        core.update_job(identifier, status="failed", message=message, error=message, completedAt=core.now(), validation=_validation(mask_source=_mask_source(project)))


def create_brush_job(core, project_id, payload, request):
    core.require_local_origin(request)
    if not isinstance(payload, dict):
        _fail("请提交当前笔划方案版本")
    revision = manual._revision(payload.get("projectRevision"))
    with core.LOCK:
        project = copy.deepcopy(core.get_project(project_id))
        if project["revision"] != revision:
            raise HTTPException(409, "笔划方案已经修改，请先保存当前版本再生成")
        path, raw, original, mask, guide, reference = _assets(core, project)
        active = [core.read_json(path) for path in (core.DATA / "jobs").glob("*/job.json")]
        if any(job and job.get("status") in {"queued", "running"} for job in active):
            raise HTTPException(409, "已有图像任务正在执行，请等待完成后再精修")
        try:
            public, key = core.cloud_provider.credentials(payload.get("provider"))
        except (ValueError, core.cloud_provider.CloudError) as exc:
            raise HTTPException(422, str(exc)) from None
        settings = {name: public.get(name) for name in SETTINGS}
        identifier = "job-brush-" + uuid.uuid4().hex[:16]
        job = _job(core, project, identifier, "cloud_brush_refine", settings["provider"], settings["model"], settings["quality"])
        core.write_json(core.DATA / "jobs" / identifier / "job.json", job)
        try:
            core.EXECUTOR.submit(_generate, core, identifier, project, settings, key, path, raw, original, mask, guide, reference)
        except Exception:
            core.update_job(identifier, status="failed", message="任务未能启动，未调用图像接口，请稍后再试。", completedAt=core.now())
        return job


def register_brush_routes(app, core):
    @app.post("/api/projects/{project_id}/brush-jobs")
    def brush_jobs(request: Request, project_id: str, payload: dict):
        return create_brush_job(core, project_id, payload, request)

    @app.get("/api/projects/{project_id}/brush-handoff")
    def brush_handoff(project_id: str, projectRevision: str | None = None):
        return build_brush_handoff(core, project_id, projectRevision)

    @app.post("/api/projects/{project_id}/import-brush-result")
    async def brush_import(request: Request, project_id: str, file: UploadFile = File(...), projectRevision: str = Form(...)):
        try:
            manual._require_local(core, request)
        except Exception:
            await file.close()
            raise
        return await import_brush_result(core, project_id, file, projectRevision)
