"""Dependency-light, metric manufacturing geometry from recorded alpha masks.

The raster is a bounded engineering approximation, not cloth simulation. Every
SVG and DXF is written from the same millimetre contours. Closed white islands
are connected to the sheet by explicit support strips before contour extraction.
"""
from __future__ import annotations

from collections import defaultdict, deque
import html
import math

from PIL import Image, ImageDraw, ImageFilter

MARGIN = 10.0


def _components(mask, foreground=True):
    w, h = mask.size
    data = mask.tobytes()
    seen = bytearray(w * h)
    for start, value in enumerate(data):
        if seen[start] or bool(value) != foreground:
            continue
        queue = deque([start])
        seen[start] = 1
        component, border = [], False
        while queue:
            i = queue.popleft()
            component.append(i)
            x, y = i % w, i // w
            border |= x == 0 or y == 0 or x == w - 1 or y == h - 1
            for j in (i - 1 if x else -1, i + 1 if x < w - 1 else -1,
                      i - w if y else -1, i + w if y < h - 1 else -1):
                if j >= 0 and not seen[j] and bool(data[j]) == foreground:
                    seen[j] = 1
                    queue.append(j)
        yield component, border


def connected_islands(mask):
    return sum(1 for _, border in _components(mask, False) if not border)


def outlines(mask):
    """Trace exact pixel cell boundaries; do not replace detail with bounding boxes."""
    w, h = mask.size
    data = mask.tobytes()
    edges = defaultdict(list)
    for i, value in enumerate(data):
        if not value:
            continue
        x, y = i % w, i // w
        if y == 0 or not data[i - w]: edges[(x, y)].append((x + 1, y))
        if x == w - 1 or not data[i + 1]: edges[(x + 1, y)].append((x + 1, y + 1))
        if y == h - 1 or not data[i + w]: edges[(x + 1, y + 1)].append((x, y + 1))
        if x == 0 or not data[i - 1]: edges[(x, y + 1)].append((x, y))
    result = []
    while edges:
        first = next(iter(edges))
        path, current = [first], first
        while True:
            candidates = edges[current]
            # At diagonal contacts, prefer a right turn to keep loops separate.
            if len(candidates) > 1 and len(path) > 1:
                prev = path[-2]
                dx, dy = current[0] - prev[0], current[1] - prev[1]
                candidates.sort(key=lambda p: -(dx * (p[1] - current[1]) - dy * (p[0] - current[0])))
            following = candidates.pop(0)
            if not candidates: del edges[current]
            if following == first: break
            path.append(following)
            current = following
        # Lossless collinear compression leaves an exact, closed boundary.
        compressed = []
        for i, p in enumerate(path):
            a, b = path[i - 1], path[(i + 1) % len(path)]
            if (p[0]-a[0])*(b[1]-p[1]) != (p[1]-a[1])*(b[0]-p[0]): compressed.append(p)
        if len(compressed) >= 3: result.append(compressed)
    return result


def prepare_mask(alpha, width, height, min_feature=2., bridge=2., mode="cut", allowed=None):
    ppm = min(3., 720. / max(width, height))
    size = max(16, round(width * ppm)), max(16, round(height * ppm))
    sx, sy = width / size[0], height / size[1]
    raster = alpha.resize(size, Image.Resampling.LANCZOS).point(lambda v: 255 if v >= 30 else 0)
    radius = max(1, math.ceil(min_feature / max(sx, sy) / 2))
    kernel = radius * 2 + 1
    removed = 0
    if mode in {"cut", "accent"}:
        raster = raster.filter(ImageFilter.MinFilter(kernel)).filter(ImageFilter.MaxFilter(kernel))
    elif mode == "protection":
        # A generous, organic protection opening, not one hole per small droplet.
        spread = max(2, math.ceil(8. / max(sx, sy)))
        raster = raster.filter(ImageFilter.MaxFilter(spread * 2 + 1))
        raster = raster.filter(ImageFilter.MaxFilter(kernel)).filter(ImageFilter.MinFilter(kernel))
    if allowed is not None:
        from PIL import ImageChops
        raster = ImageChops.multiply(raster, allowed.resize(size, Image.Resampling.NEAREST))
    if mode != "mark":
        pixels = raster.load()
        minimum_area = max(4, math.ceil(min_feature * min_feature / (sx * sy)))
        for component, _ in _components(raster):
            if len(component) < minimum_area:
                removed += 1
                for i in component: pixels[i % size[0], i // size[0]] = 0
    bridges = []
    if mode != "mark":
        draw = ImageDraw.Draw(raster)
        # White island -> left exterior strip. This retains all islands rather
        # than silently filling them; the visible bridge can be touched up later.
        for component, border in list(_components(raster, False)):
            if border: continue
            i = min(component, key=lambda index: index % size[0])
            x, y = i % size[0], i // size[0]
            half = max(1, math.ceil(bridge / sy / 2))
            draw.rectangle((0, max(0, y-half), x+1, min(size[1]-1, y+half)), fill=0)
            bridges.append({"x1Mm": MARGIN, "x2Mm": MARGIN + (x+1)*sx,
                            "yMm": MARGIN+y*sy, "widthMm": (2*half+1)*sy})
    paths = [[(MARGIN + x*sx, MARGIN + y*sy) for x, y in path] for path in outlines(raster)]
    return paths, {"gridSize": list(size), "resolutionMm": round(max(sx, sy), 4),
                   "smallIslandsRemoved": removed, "supportBridges": bridges,
                   "remainingUnsupportedIslands": connected_islands(raster) if mode != "mark" else None}, raster


def svg(width, height, paths, title, cut=True, outline=None, image_href=None):
    pw, ph = width+2*MARGIN, height+2*MARGIN
    content = []
    if image_href:
        content.append(f'<image href="{html.escape(image_href, quote=True)}" x="10" y="10" width="{width:g}" height="{height:g}" opacity="0.5"/>')
    for path in paths:
        points = ' '.join(f'{x:.5f},{y:.5f}' for x, y in path)
        content.append(f'<polygon points="{points}"/>')
    outline_markup = ''
    if outline:
        pts = ' '.join(f'{MARGIN+x*width:.5f},{MARGIN+y*height:.5f}' for x, y in outline)
        outline_markup = f'<polygon id="garment-boundary" points="{pts}" fill="none" stroke="#697b84" stroke-width="0.3" stroke-dasharray="2 1"/>'
    registration = ''.join(f'<path d="M{x-2:g},{y:g}h4M{x:g},{y-2:g}v4"/>' for x,y in ((5,5),(pw-5,5),(5,ph-5),(pw-5,ph-5)))
    scale = min(50., width)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{pw:g}mm" height="{ph:g}mm" viewBox="0 0 {pw:g} {ph:g}">'
            f'<title>{html.escape(title)}</title><desc>Units mm; CUT is the only cutting layer. Registration and garment boundary are marks.</desc>'
            f'<rect width="{pw:g}" height="{ph:g}" fill="white"/>{outline_markup}'
            f'<g id="{"CUT" if cut else "MARK"}" fill="{"black" if cut else "none"}" stroke="black" stroke-width="0.2">{"".join(content)}</g>'
            f'<g id="REGISTRATION" fill="none" stroke="#777" stroke-width="0.2">{registration}'
            f'<path d="M10,{ph-4:g}h{scale:g}m-{scale:g},-1v2m{scale:g},-2v2"/></g>'
            f'<text x="10" y="6" font-size="2.6" font-family="sans-serif">{html.escape(title)}</text>'
            f'<text x="{10+scale+2:g}" y="{ph-3:g}" font-size="2.5">{scale:g} mm</text></svg>')


def dxf(width, height, paths, cut=True):
    ph = height+2*MARGIN
    lines = ['0','SECTION','2','HEADER','9','$INSUNITS','70','4','9','$MEASUREMENT','70','1','0','ENDSEC','0','SECTION','2','ENTITIES']
    for path in paths:
        lines += ['0','LWPOLYLINE','100','AcDbEntity','8','CUT' if cut else 'MARK','100','AcDbPolyline','90',str(len(path)),'70','1']
        for x,y in path: lines += ['10',f'{x:.6f}','20',f'{ph-y:.6f}']
    for x,y in ((5,5),(width+15,5),(5,height+15),(width+15,height+15)):
        for a,b in (((x-2,y),(x+2,y)),((x,y-2),(x,y+2))):
            lines += ['0','LINE','8','REGISTRATION','10',str(a[0]),'20',str(ph-a[1]),'11',str(b[0]),'21',str(ph-b[1])]
    return '\n'.join(lines+['0','ENDSEC','0','EOF',''])
