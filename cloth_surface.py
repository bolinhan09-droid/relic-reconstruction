"""Deterministic 2.5D photo-surface displacement, not measured cloth geometry.

The implementation is shared with web/cloth-surface.js. Low-frequency optional
relative depth and high-frequency illumination cues generate bounded UV offsets.
Only pigment is warped: the source photograph is never resampled or modified.
No network, models, numpy, or training are hidden inside this module.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from PIL import Image

VERSION = "cloth-surface-v1"
LINEAR = tuple(v / 255 / 12.92 if v / 255 <= .04045 else ((v / 255 + .055) / 1.055) ** 2.4 for v in range(256))


def _clamp(x, lo, hi):
    return min(hi, max(lo, x))


def _blur(values, w, h, radius):
    """Separable, truncated-window box blur; constant fields remain constant."""
    horizontal, output = [0.] * (w * h), [0.] * (w * h)
    for y in range(h):
        prefix = [0.]
        for x in range(w):
            prefix.append(prefix[-1] + values[y * w + x])
        for x in range(w):
            lo, hi = max(0, x - radius), min(w, x + radius + 1)
            horizontal[y * w + x] = (prefix[hi] - prefix[lo]) / (hi - lo)
    for x in range(w):
        prefix = [0.]
        for y in range(h):
            prefix.append(prefix[-1] + horizontal[y * w + x])
        for y in range(h):
            lo, hi = max(0, y - radius), min(h, y + radius + 1)
            output[y * w + x] = (prefix[hi] - prefix[lo]) / (hi - lo)
    return output


def _sample(values, w, h, x, y):
    x, y = _clamp(x, 0, w - 1), _clamp(y, 0, h - 1)
    x0, y0 = int(x), int(y)
    x1, y1 = min(w - 1, x0 + 1), min(h - 1, y0 + 1)
    fx, fy = x - x0, y - y0
    return (values[y0 * w + x0] * (1 - fx) + values[y0 * w + x1] * fx) * (1 - fy) + (values[y1 * w + x0] * (1 - fx) + values[y1 * w + x1] * fx) * fy


@dataclass
class SurfaceField:
    width: int
    height: int
    dx: list[float]
    dy: list[float]
    light: list[float]
    foreground: list[float]
    metadata: dict


def build_surface_field(source: Image.Image, foreground: Image.Image | None = None,
                        relative_depth: Image.Image | None = None, max_edge=256) -> SurfaceField:
    """Build/cache once for an immutable original. Depth is optional 8-bit relative.

    Masks/depth must have the same size as source; the caller owns model provenance.
    A foreground mask is a person/object cutout, not a garment semantic parser.
    """
    source = source.convert("RGB")
    sw, sh = source.size
    if min(sw, sh) < 1 or sw * sh > 40_000_000:
        raise ValueError("Invalid source dimensions")
    for image in (foreground, relative_depth):
        if image is not None and image.size != source.size:
            raise ValueError("Surface mask/depth must match source dimensions")
    edge = int(_clamp(int(max_edge), 32, 512))
    scale = min(1., edge / max(sw, sh))
    w, h = max(1, math.floor(sw * scale + .5)), max(1, math.floor(sh * scale + .5))
    pixels, mask, depth = source.load(), foreground.convert("L").load() if foreground is not None else None, relative_depth.convert("L").load() if relative_depth is not None else None
    luma, cr, cb, fg, rd = [], [], [], [], []
    for y in range(h):
        sy = min(sh - 1, int((y + .5) * sh / h))
        for x in range(w):
            sx = min(sw - 1, int((x + .5) * sw / w))
            r, g, b = (LINEAR[v] for v in pixels[sx, sy])
            total = r + g + b + .08
            luma.append(math.log(.04 + .2126 * r + .7152 * g + .0722 * b))
            cr.append(r / total)
            cb.append(b / total)
            fg.append(mask[sx, sy] / 255 if mask is not None else 1.)
            rd.append(depth[sx, sy] / 255 if depth is not None else 0.)
    smooth = _blur(luma, w, h, max(1, math.floor(min(w, h) * .006 + .5)))
    base = _blur(smooth, w, h, max(3, math.floor(min(w, h) * .045 + .5)))
    chroma_r, chroma_b = _blur(cr, w, h, 1), _blur(cb, w, h, 1)
    rd = _blur(rd, w, h, max(2, math.floor(min(w, h) * .025 + .5)))
    total_weight = sum(fg) or 1.
    centre = sum(v * m for v, m in zip(rd, fg)) / total_weight
    dx, dy, light = [], [], []
    for y in range(h):
        for x in range(w):
            i, left, right = y * w + x, y * w + max(0, x - 1), y * w + min(w - 1, x + 1)
            above, below = max(0, y - 1) * w + x, min(h - 1, y + 1) * w + x
            colour_edge = abs(chroma_r[right] - chroma_r[left]) + abs(chroma_b[right] - chroma_b[left]) + abs(chroma_r[below] - chroma_r[above]) + abs(chroma_b[below] - chroma_b[above])
            gate = 1. / (1. + 18. * colour_edge)
            detail = _clamp((smooth[i] - base[i]) * .8, -.8, .8)
            # A bounded image-space artistic drape. This is not inverse rendering.
            gx, gy = (smooth[right] - smooth[left]) * .5, (smooth[below] - smooth[above]) * .5
            ddx, ddy = (rd[right] - rd[left]) * .5, (rd[below] - rd[above]) * .5
            d = rd[i] - centre if relative_depth is not None else 0.
            attenuation = fg[i] * min(fg[left], fg[right], fg[above], fg[below])
            vx = _clamp((.007 * detail + .005 * math.tanh(gx * 5)) * gate + .012 * ddx, -.015, .015) * attenuation
            vy = _clamp((.011 * detail + .005 * math.tanh(gy * 5)) * gate + .006 * d + .012 * ddy, -.015, .015) * attenuation
            # Box sums on a constant image can leave 1e-17 roundoff. Snapping it
            # prevents an exact border sample being mistaken for out of bounds.
            dx.append(0. if abs(vx) < 1e-12 else vx)
            dy.append(0. if abs(vy) < 1e-12 else vy)
            light.append(_clamp(math.exp(detail * gate * .65), .68, 1.28))
    return SurfaceField(w, h, dx, dy, light, fg, {
        "version": VERSION, "algorithm": "bounded-multiscale-photo-displacement",
        "sourceSize": [sw, sh], "fieldSize": [w, h], "relativeDepthProvided": relative_depth is not None,
        "metricHeight": False, "geometryReconstruction": False, "physicalSimulation": False,
        "illuminationHeuristic": True, "foregroundProvided": foreground is not None,
        "warning": "光影与印花、反光或投影可能混淆；仅提供可关闭的近似表面贴合，不表示真实褶皱高度。",
    })


def apply_surface(layer: Image.Image, field: SurfaceField, strength=.65, shade=.45,
                  mask_only=False, clip_foreground=True) -> Image.Image:
    """Inverse UV resampling with premultiplied alpha; transparent pixels stay clean.

    Strength/shade are independent, 0..1. Displacement alters the alpha geometry.
    No source pixels are composited here. Call on the untouched original paint
    once, never on a previously warped layer (which would accumulate distortion).
    """
    layer = layer.convert("RGBA")
    w, h = layer.size
    strength, shade = float(strength), float(shade)
    if not math.isfinite(strength) or not math.isfinite(shade):
        raise ValueError("Surface strength/shade must be finite")
    strength, shade = _clamp(strength, 0., 1.), _clamp(shade, 0., 1.)
    bounds = layer.getbbox()
    output = Image.new("RGBA", layer.size)
    if bounds is None:
        return output
    margin = math.ceil(max(w, h) * .015 * strength) + 2
    x0, y0, x1, y1 = max(0, bounds[0] - margin), max(0, bounds[1] - margin), min(w, bounds[2] + margin), min(h, bounds[3] + margin)
    src, dst = layer.load(), output.load()
    for y in range(y0, y1):
        fy = (y + .5) * field.height / h - .5
        for x in range(x0, x1):
            fx = (x + .5) * field.width / w - .5
            sx = x + _sample(field.dx, field.width, field.height, fx, fy) * w * strength
            sy = y + _sample(field.dy, field.width, field.height, fx, fy) * h * strength
            if sx < 0 or sy < 0 or sx > w - 1 or sy > h - 1:
                continue
            ix, iy = int(sx), int(sy)
            tx, ty = sx - ix, sy - iy
            a, rgb = 0., [0., 0., 0.]
            for px, py, weight in ((ix, iy, (1 - tx) * (1 - ty)), (min(w - 1, ix + 1), iy, tx * (1 - ty)), (ix, min(h - 1, iy + 1), (1 - tx) * ty), (min(w - 1, ix + 1), min(h - 1, iy + 1), tx * ty)):
                sample = src[px, py]
                alpha = sample[3] * weight
                a += alpha
                for c in range(3):
                    rgb[c] += sample[c] * alpha
            if a < .5:
                continue
            factor = 1. if mask_only else 1. + (_sample(field.light, field.width, field.height, fx, fy) - 1.) * shade
            coverage = _sample(field.foreground, field.width, field.height, fx, fy) if clip_foreground else 1.
            alpha = math.floor(a * coverage + .5)
            if alpha:
                dst[x, y] = tuple(math.floor(_clamp(v / a * factor, 0., 255.) + .5) for v in rgb) + (alpha,)
    return output


def field_maps(field: SurfaceField) -> dict[str, Image.Image]:
    """Lossless float payload is preferred; these 16-bit PNGs are inspectable caches.

    dx/dy maps encode [-.015,.015] into [0,65535], light [.5,1.5].
    Browser clients may instead consume field_payload() to avoid PNG quantization.
    """
    out = {}
    for name, values, scale, offset in (("dx", field.dx, .03, -.015), ("dy", field.dy, .03, -.015), ("light", field.light, 1., .5), ("foreground", field.foreground, 1., 0.)):
        image = Image.new("I", (field.width, field.height))
        image.putdata([math.floor(_clamp((v - offset) / scale, 0., 1.) * 65535 + .5) for v in values])
        out[name] = image.convert("I;16")
    return out


def field_payload(field: SurfaceField) -> dict:
    return {"width": field.width, "height": field.height, "dx": field.dx, "dy": field.dy,
            "light": field.light, "foreground": field.foreground, "metadata": field.metadata}


def field_from_payload(payload: dict) -> SurfaceField:
    w, h = payload.get("width"), payload.get("height")
    if type(w) is not int or type(h) is not int or not 1 <= w <= 512 or not 1 <= h <= 512:
        raise ValueError("Invalid surface field dimensions")
    fields = []
    for name, lo, hi in (("dx", -.015, .015), ("dy", -.015, .015), ("light", .5, 1.5), ("foreground", 0., 1.)):
        values = payload.get(name)
        if not isinstance(values, (list, tuple)) or len(values) != w * h or any(isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) or not lo <= v <= hi for v in values):
            raise ValueError("Invalid surface field values")
        fields.append(list(values))
    return SurfaceField(w, h, *fields, dict(payload.get("metadata") or {}))
