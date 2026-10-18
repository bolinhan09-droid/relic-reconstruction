"""Conservative, editable silhouette correspondence for one visible cloth panel.

The only public operation returns normalized landmark pairs, never a flattened
garment or a physical cloth solution. A user-selected polygon identifies a panel;
without one, only an isolated foreground on a uniform border is considered. The
foreground heuristic cannot identify clothing, people, layers or hidden folds.
Pillow and the Python standard library are the complete runtime dependencies.
"""
from __future__ import annotations

from collections import Counter, deque
import math
from statistics import median

from PIL import Image, ImageDraw, ImageFilter

__all__ = ["suggest_correspondence"]
METHOD = "silhouette_cross_sections_v1"
EDGE = 384
BASE_WARNING = "这是同一可见衣片的轮廓近似对应，不是物理展开；褶皱、叠穿、背面和遮挡内容没有被恢复。"


def _cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _intersects(a, b, c, d):
    eps = 1e-10
    values = (_cross(a, b, c), _cross(a, b, d), _cross(c, d, a), _cross(c, d, b))
    if values[0] * values[1] < -eps and values[2] * values[3] < -eps:
        return True
    def on(p, q, r):
        return abs(_cross(p, q, r)) <= eps and min(p[0], q[0]) - eps <= r[0] <= max(p[0], q[0]) + eps and min(p[1], q[1]) - eps <= r[1] <= max(p[1], q[1]) + eps
    return on(a, b, c) or on(a, b, d) or on(c, d, a) or on(c, d, b)


def _boundary(value):
    if not isinstance(value, (list, tuple)) or not 3 <= len(value) <= 128:
        raise ValueError("衣片边界需要 3–128 个点")
    result = []
    for point in value:
        if isinstance(point, dict) and set(point) == {"x", "y"}:
            point = (point["x"], point["y"])
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            raise ValueError("边界点需要 x、y 坐标")
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1 for v in point):
            raise ValueError("边界坐标需要在 0–1 范围")
        result.append(tuple(float(v) for v in point))
    if result[-1] == result[0]:
        result.pop()
    if len(result) < 3 or len(set(result)) != len(result):
        raise ValueError("衣片边界存在重复点")
    area = abs(sum(p[0] * result[(i + 1) % len(result)][1] - result[(i + 1) % len(result)][0] * p[1] for i, p in enumerate(result))) / 2
    if area < 0.0001:
        raise ValueError("衣片边界面积太小")
    for i in range(len(result)):
        for j in range(i + 2, len(result)):
            if i == 0 and j == len(result) - 1:
                continue
            if _intersects(result[i], result[(i + 1) % len(result)], result[j], result[(j + 1) % len(result)]):
                raise ValueError("衣片边界不能自交")
    return result


def _json_points(points):
    return [{"x": round(x, 7), "y": round(y, 7)} for x, y in points]


def _scaled(image):
    if not isinstance(image, Image.Image) or min(image.size) < 24:
        raise ValueError("图片尺寸太小")
    result = image.convert("RGB")
    result.thumbnail((EDGE, EDGE), Image.Resampling.LANCZOS)
    return result


def _components(mask):
    width, height = mask.size
    data = bytearray(mask.tobytes())
    components = []
    for start, value in enumerate(data):
        if not value:
            continue
        data[start] = 0
        pending = deque([start])
        component = []
        while pending:
            index = pending.popleft()
            component.append(index)
            x, y = index % width, index // width
            for near in ((index - 1 if x else -1), (index + 1 if x + 1 < width else -1), (index - width if y else -1), (index + width if y + 1 < height else -1)):
                if near >= 0 and data[near]:
                    data[near] = 0
                    pending.append(near)
        components.append(component)
    return sorted(components, key=len, reverse=True)


def _mask(image, boundary):
    width, height = image.size
    if boundary is not None:
        polygon = _boundary(boundary)
        mask = Image.new("L", image.size)
        ImageDraw.Draw(mask).polygon([(round(x * (width - 1)), round(y * (height - 1))) for x, y in polygon], fill=255)
        return mask, polygon, "user_polygon", []

    # Only uniform, empty image borders permit this low-level foreground guess.
    pixels = image.load()
    edge = [pixels[x, y] for x in range(width) for y in (0, height - 1)] + [pixels[x, y] for y in range(1, height - 1) for x in (0, width - 1)]
    background = tuple(median(p[c] for p in edge) for c in range(3))
    distance = lambda p: math.sqrt(sum((p[c] - background[c]) ** 2 for c in range(3)))
    clean = sum(distance(p) <= 15 for p in edge) / len(edge)
    if clean < 0.985:
        raise ValueError("背景不够单一，无法可靠区分衣片、人物和背景；请圈选同一衣片")
    threshold = max(25, median(distance(p) for p in edge) * 5)
    raw = Image.new("L", image.size)
    raw.putdata([255 if distance(p) > threshold else 0 for p in image.getdata()])
    raw = raw.filter(ImageFilter.MedianFilter(3))
    components = _components(raw)
    if not components or len(components[0]) / (width * height) < 0.035:
        raise ValueError("没有足够明确的衣片前景，请手动圈选")
    largest = components[0]
    if len(largest) / (width * height) > 0.82:
        raise ValueError("前景占满图片，无法确认完整衣片边界，请手动圈选")
    if len(components) > 1 and len(components[1]) > len(largest) * 0.055:
        raise ValueError("存在多个显著前景／可能叠穿，不能自动决定对应衣片，请分别圈选")
    mask = Image.new("L", image.size)
    mask_data = bytearray(width * height)
    for index in largest:
        mask_data[index] = 255
    mask.frombytes(bytes(mask_data))
    bounds = mask.getbbox()
    if min(bounds[0], bounds[1], width - bounds[2], height - bounds[3]) < 3:
        raise ValueError("衣片可能被图片边缘裁切，请补充完整照片或手动圈选")
    return mask, None, "uniform_background_foreground", ["自动范围仅依据背景颜色，不识别衣服语义；请确认没有把身体、道具或内搭包含在同一衣片内。"]


def _profile(mask, segmentation):
    width, height = mask.size
    bounds = mask.getbbox()
    if not bounds:
        raise ValueError("圈选范围为空")
    left, top, right, bottom = bounds
    data = mask.tobytes()
    rows = []
    for y in range(top, bottom):
        positions = [x for x in range(left, right) if data[y * width + x]]
        if not positions:
            rows.append(None)
            continue
        # A gap over two pixels is an unsupported neckline, separate sleeve,
        # leg or overlap. Never bridge it just by taking an enclosing box.
        gap = any(b - a > 3 for a, b in zip(positions, positions[1:]))
        rows.append(None if gap or positions[-1] - positions[0] < max(9, (right - left) * 0.10) else (positions[0], positions[-1]))
    runs, run_start = [], None
    for index, row in enumerate(rows + [None]):
        if row is not None and run_start is None:
            run_start = index
        if row is None and run_start is not None:
            runs.append((run_start, index - 1))
            run_start = None
    if not runs:
        raise ValueError("衣片没有足够连续的可见区域，请分开圈选主衣片与袖子")
    if segmentation != "user_polygon" and sum(row is None for row in rows) / len(rows) > 0.10:
        raise ValueError("自动前景存在显著分叉／间隙，可能是人物或多个衣片；请圈选一片衣物")
    begin, end = max(runs, key=lambda r: r[1] - r[0])
    if end - begin < max(18, (bottom - top) * 0.62):
        raise ValueError("衣片有多处分叉／遮挡，不能把多个层次连成一块；请仅圈选一片连续可见衣片")
    segment = rows[begin:end + 1]
    widths = [b - a for a, b in segment]
    abrupt = max(abs(a - b) for a, b in zip(widths, widths[1:])) / max(widths)
    if abrupt > 0.30:
        raise ValueError("轮廓存在明显袖子／层次分叉，请把主衣片与袖子分开映射")
    # A pronounced small head followed by broad shoulders is not a verified
    # garment silhouette. Explicit user polygons can still identify a panel.
    first = median(widths[:max(3, len(widths) // 8)])
    if segmentation != "user_polygon" and first < median(widths) * 0.40:
        raise ValueError("自动前景可能包含头部或其他物体，无法确认衣片，请手动圈选")
    trim = max(1, round((end - begin) * 0.025))
    begin += trim
    end -= trim
    if end - begin < 12:
        raise ValueError("连续区域过窄，无法建立衣片对应")
    def row_at(t):
        position = begin + t * (end - begin)
        index = min(end, max(begin, round(position)))
        nearby = rows[max(begin, index - 1):min(end, index + 1) + 1]
        a = median(r[0] for r in nearby)
        b = median(r[1] for r in nearby)
        return a / (width - 1), b / (width - 1), (top + position) / (height - 1)
    total_pixels = sum(1 for value in data if value)
    represented_pixels = sum(sum(1 for value in data[y * width:(y + 1) * width] if value) for y in range(top + begin, top + end + 1))
    boundary = []
    for t in (0., .125, .25, .375, .5, .625, .75, .875, 1.):
        a, b, y = row_at(t)
        boundary.append((a, y))
    for t in (1., .875, .75, .625, .5, .375, .25, .125, 0.):
        a, b, y = row_at(t)
        boundary.append((b, y))
    return {"row": row_at, "boundary": boundary, "areaFraction": represented_pixels / total_pixels,
            "yRange": [(top + begin) / (height - 1), (top + end) / (height - 1)]}


def _delaunay(points):
    # The desktop mapper also triangulates target controls. Check that its
    # unconstrained topology will not fold when transported back to the source.
    count = len(points)
    vertices = list(points) + [(-16., -16.), (16., -16.), (0., 16.)]
    triangles = [(count, count + 1, count + 2)]
    for index in range(count):
        p = vertices[index]
        bad = []
        for tri in triangles:
            a, b, c = [vertices[i] for i in tri]
            ax, ay, bx, by, cx, cy = a[0] - p[0], a[1] - p[1], b[0] - p[0], b[1] - p[1], c[0] - p[0], c[1] - p[1]
            det = (ax * ax + ay * ay) * (bx * cy - by * cx) - (bx * bx + by * by) * (ax * cy - ay * cx) + (cx * cx + cy * cy) * (ax * by - ay * bx)
            if det * _cross(a, b, c) > 1e-13:
                bad.append(tri)
        edges = Counter(tuple(sorted(pair)) for tri in bad for pair in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])))
        triangles = [tri for tri in triangles if tri not in bad]
        for (a, b), frequency in edges.items():
            if frequency == 1 and abs(_cross(vertices[a], vertices[b], p)) > 1e-10:
                triangles.append((a, b, index) if _cross(vertices[a], vertices[b], p) > 0 else (b, a, index))
    return [tri for tri in triangles if max(tri) < count]


def _compatible(source, target):
    triangles = _delaunay(target)
    if not triangles or len({i for tri in triangles for i in tri}) != len(target):
        return False
    if any(_cross(*(source[i] for i in tri)) * _cross(*(target[i] for i in tri)) <= 1e-10 for tri in triangles):
        return False
    edges = sorted({tuple(sorted((tri[i], tri[(i + 1) % 3]))) for tri in triangles for i in range(3)})
    for index, (a, b) in enumerate(edges):
        for c, d in edges[index + 1:]:
            if {a, b} & {c, d}:
                common = next(iter({a, b} & {c, d}))
                va, vb = source[b if a == common else a], source[d if c == common else c]
                p = source[common]
                if abs(_cross(p, va, vb)) <= 1e-10 and (va[0] - p[0]) * (vb[0] - p[0]) + (va[1] - p[1]) * (vb[1] - p[1]) > 1e-10:
                    return False
            elif _intersects(source[a], source[b], source[c], source[d]):
                return False
    return True


def suggest_correspondence(source, target, source_boundary=None, target_boundary=None, max_points=21):
    """Return editable paired controls for one upright, visible cloth panel.

    Images are Pillow images. Optional polygons contain normalized ``{x,y}``
    mappings or pairs. ``status=needs_selection`` returns no suggested points;
    it means a user must identify a less ambiguous panel. ``suggested`` always
    requires confirmation and never denotes validated anatomical accuracy.
    Correspondences preserve image-left/image-right; they do not infer front
    versus back, left versus right sleeve, garment identity, or hidden texture.
    """
    result = {"status": "needs_selection", "method": METHOD, "sourcePoints": [], "targetPoints": [],
              "sourceBoundary": [], "targetBoundary": [], "warnings": [BASE_WARNING],
              "confirmationRequired": True, "automaticGarmentIdentification": False,
              "physicalUnfolding": False, "hiddenAreaRecovered": False, "accuracyMeasured": False,
              "confidence": "not_estimated", "supportedRegion": None}
    if isinstance(max_points, bool) or not isinstance(max_points, int) or not 6 <= max_points <= 24:
        result["reason"] = "max_points 需要为 6–24 的整数"
        return result
    profiles, segmentations = [], []
    for name, image, boundary in (("source", source, source_boundary), ("target", target, target_boundary)):
        try:
            reduced = _scaled(image)
            mask, polygon, segmentation, warnings = _mask(reduced, boundary)
            profile = _profile(mask, segmentation)
            profile["selectedBoundary"] = polygon
            profiles.append(profile)
            segmentations.append(segmentation)
            result["warnings"].extend(f"{'穿着图' if name == 'source' else '平铺图'}：{warning}" for warning in warnings)
        except (ValueError, TypeError) as exc:
            result["reason"] = f"{'穿着图' if name == 'source' else '平铺图'}：{exc}"
            result["selectionRequiredFor"] = name
            return result
    rows = max(2, min(8, max_points // 3))
    source_profile, target_profile = profiles
    row_times = [index / (rows - 1) for index in range(rows)]
    source_points, target_points = [], []
    for profile, output in ((source_profile, source_points), (target_profile, target_points)):
        for t in row_times:
            left, right, y = profile["row"](t)
            for fraction in (.06, .5, .94):
                output.append((round(left + fraction * (right - left), 7), round(y, 7)))
    # Remove whole interior cross-sections if a changed silhouette would fold
    # the desktop mapper's Delaunay chart. Four outer controls remain convex.
    reduced_grid = False
    while not _compatible(source_points, target_points) and len(source_points) > 6:
        row_count = len(source_points) // 3
        middle = row_count // 2
        del source_points[middle * 3:(middle + 1) * 3]
        del target_points[middle * 3:(middle + 1) * 3]
        reduced_grid = True
    if not _compatible(source_points, target_points):
        source_points = [source_points[i] for i in (0, 2, len(source_points) - 1, len(source_points) - 3)]
        target_points = [target_points[i] for i in (0, 2, len(target_points) - 1, len(target_points) - 3)]
        reduced_grid = True
    if not _compatible(source_points, target_points):
        result["reason"] = "两张衣片轮廓的差异会导致网格翻折，请分别选择更小的同一衣片"
        return result
    if reduced_grid:
        result["warnings"].append("两张轮廓差异较大，已减少对应点以避免网格交叉；请补充肩线、缝线等真实对应点后确认。")
    result["warnings"].extend(["对应按图片上下、左右顺序建立；请确认照片方向一致，正反面与左右袖不能混用。",
                               "轮廓无法判断血迹跨越了哪条褶皱；看不见的面积仍是未知，不能当成实际展开尺寸。"])
    result.update({"status": "suggested", "sourcePoints": _json_points(source_points), "targetPoints": _json_points(target_points),
                   "sourceBoundary": _json_points(source_profile["selectedBoundary"] or source_profile["boundary"]),
                   "targetBoundary": _json_points(target_profile["selectedBoundary"] or target_profile["boundary"]),
                   "segmentation": {"source": segmentations[0], "target": segmentations[1]},
                   "confidence": "user_confirmation_required", "supportedRegion": {
                       "sourceYRange": source_profile["yRange"], "targetYRange": target_profile["yRange"],
                       "sourceVisibleMaskFraction": source_profile["areaFraction"], "targetVisibleMaskFraction": target_profile["areaFraction"],
                       "unknown": "网格外、袖子分叉、褶皱遮挡及背面均未建立真实对应"}})
    return result
