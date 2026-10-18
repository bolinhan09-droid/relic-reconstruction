"""Metric stencil export from user-confirmed convex cut regions.

This is deliberately not a sewing-pattern generator. SVG and DXF use the same
millimetre polygons, including optional support strips. No image inference or
unverified photo-to-pattern conversion is performed here.
"""
from __future__ import annotations

import html
import json
import math
from pathlib import Path

from .store import fail


def number(value, minimum, maximum, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        fail(f"{label}须为 {minimum}–{maximum} 的有限数值")
    return float(value)


def _polygon(value, width, height):
    if not isinstance(value, list) or not 3 <= len(value) <= 256:
        fail("每个模板轮廓须有 3–256 个点")
    points = []
    for point in value:
        if not isinstance(point, dict):
            fail("模板轮廓点格式无效")
        points.append((number(point.get("x"), 0, 1, "横坐标") * width,
                       number(point.get("y"), 0, 1, "纵坐标") * height))
    if points[0] == points[-1]:
        points.pop()
    if len(points) < 3 or len(set(points)) != len(points):
        fail("模板轮廓须包含三个不同的有效点")
    cross = []
    for i, a in enumerate(points):
        b, c = points[(i + 1) % len(points)], points[(i + 2) % len(points)]
        cross.append((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]))
    nonzero = [v for v in cross if abs(v) > 1e-8]
    if not nonzero or any(v * nonzero[0] < 0 for v in nonzero):
        fail("首版模板只接受简单凸轮廓；复杂形状请拆成多个不相交区域")
    # Convexity also requires a simple boundary; a star can have same-sign turns.
    for i, a in enumerate(points):
        b = points[(i + 1) % len(points)]
        for j in range(i + 2, len(points)):
            if i == 0 and j == len(points) - 1:
                continue
            c, d = points[j], points[(j + 1) % len(points)]
            def turn(p, q, r):
                return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
            if turn(a, b, c) * turn(a, b, d) < -1e-10 and turn(c, d, a) * turn(c, d, b) < -1e-10:
                fail("模板轮廓不能自交")
    area = abs(sum(a[0] * points[(i + 1) % len(points)][1] - points[(i + 1) % len(points)][0] * a[1]
                   for i, a in enumerate(points))) / 2
    if area < 1:
        fail("模板镂空面积不足 1 平方毫米，请放大或移除该区域")
    if any(x < 5 or y < 5 or x > width - 5 or y > height - 5 for x, y in points):
        fail("模板轮廓距纸板边缘至少保留 5 毫米")
    return points


def _clip_y(points, edge, upper):
    output = []
    for index, current in enumerate(points):
        previous = points[index - 1]
        inside = current[1] <= edge if upper else current[1] >= edge
        prior_inside = previous[1] <= edge if upper else previous[1] >= edge
        if inside != prior_inside:
            t = (edge - previous[1]) / (current[1] - previous[1])
            output.append((previous[0] + t * (current[0] - previous[0]), edge))
        if inside:
            output.append(current)
    return output


def _svg(width, height, paths, title):
    cut = []
    for points in paths:
        coords = " ".join(f"{x:.4f},{y:.4f}" for x, y in points)
        cut.append(f'<polygon points="{coords}"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:g}mm" height="{height:g}mm" viewBox="0 0 {width:g} {height:g}">\n'
            f'<title>{html.escape(title)}</title>\n<desc>Millimetre cut geometry. User-confirmed stencil, not a sewing pattern. Black shapes are cut-out areas.</desc>\n'
            f'<g id="cut" fill="black">{"".join(cut)}</g>\n'
            '<g id="registration" fill="none" stroke="#888" stroke-width="0.2">'
            '<path d="M1,3H5M3,1V5"/>'
            f'<path d="M{width-5:g},3H{width-1:g}M{width-3:g},1V5"/>'
            f'<path d="M1,{height-3:g}H5M3,{height-5:g}V{height-1:g}"/></g>\n</svg>')


def _dxf(width, height, paths):
    lines = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "4", "9", "$MEASUREMENT", "70", "1", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"]
    for points in paths:
        lines += ["0", "LWPOLYLINE", "100", "AcDbEntity", "8", "CUT", "100", "AcDbPolyline", "90", str(len(points)), "70", "1"]
        for x, y in points:
            # SVG's Y axis points down; flip into CAD's upward Y direction.
            lines += ["10", f"{x:.6f}", "20", f"{height-y:.6f}"]
    lines += ["0", "ENDSEC", "0", "EOF", ""]
    return "\n".join(lines)


def export_stencil(params, folder: Path, title="服装局部制作模板"):
    if params.get("flatConfirmed") is not True or params.get("scaleConfirmed") is not True:
        fail("请先确认真实平铺定位与实际尺寸；未校准图片不能直接输出加工模板")
    width = number(params.get("widthMm"), 20, 2000, "模板宽度（毫米）")
    height = number(params.get("heightMm"), 20, 2000, "模板高度（毫米）")
    bridge = number(params.get("bridgeMm", 2), 0, 10, "支撑桥宽度（毫米）")
    raw = params.get("polygons", [])
    if not isinstance(raw, list) or not 1 <= len(raw) <= 200:
        fail("请绘制 1–200 个明确的模板镂空区域")
    polygons = [_polygon(value, width, height) for value in raw]
    paths, bridges = [], []
    for polygon in polygons:
        ys = [point[1] for point in polygon]
        middle = (min(ys) + max(ys)) / 2
        if bridge and max(ys) - min(ys) >= bridge * 4:
            pieces = [_clip_y(polygon, middle - bridge / 2, True), _clip_y(polygon, middle + bridge / 2, False)]
            paths.extend(piece for piece in pieces if len(piece) >= 3)
            bridges.append({"yMm": middle, "widthMm": bridge})
        else:
            paths.append(polygon)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "stencil.svg").write_text(_svg(width, height, paths, title), encoding="utf-8")
    (folder / "stencil.dxf").write_text(_dxf(width, height, paths), encoding="ascii")
    receipt = {"kind": "user_confirmed_metric_stencil", "widthMm": width, "heightMm": height,
               "units": "mm", "flatConfirmed": True, "scaleConfirmed": True,
               "inputRegionCount": len(polygons), "cutContourCount": len(paths), "supportBridges": bridges,
               "cutContoursMm": [[[round(x, 6), round(y, 6)] for x, y in polygon] for polygon in paths],
               "isSewingPattern": False, "physicalSimulation": False,
               "notes": ["黑色区域表示镂空，灰色定位标记不属于 DXF 切割层。",
                         "支撑桥在大型凸轮廓中央保留横向连接；复杂轮廓暂不自动求解。",
                         "加工前请先按 100% 尺寸打印纸样，对照真实衣物确认定位、孔宽与板材参数。"]}
    (folder / "calibration.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    return receipt
