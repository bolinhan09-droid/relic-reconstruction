/* Seeded paint abrasion for the chevron workflow tags.
 * A probability field controls WHERE paint can disappear; anisotropic coherent
 * noise controls HOW it disappears. There is no circular/elliptical cut-out.
 * The returned alpha mask is in full-tag coordinates (800 × 440 by default).
 * Keep the image and this mask independent; changing a thumbnail must not
 * trigger any remote request, and dragging a node must not change its wear.
 */
const CACHE_LIMIT = 64;
const cache = new Map();
const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };

function hash(value) {
  const text = String(value ?? '');
  let result = 2166136261;
  for (let i = 0; i < text.length; i++) result = Math.imul(result ^ text.charCodeAt(i), 16777619);
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  return result >>> 0;
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ state >>> 15, state | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// A small tile of pre-generated random values makes the per-pixel loop cheap.
// Interpolated value noise, unlike white noise, forms contiguous worn flakes.
function field(seed) {
  const values = new Float32Array(128 * 128), rng = random(seed);
  for (let i = 0; i < values.length; i++) values[i] = rng();
  return (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = values[(iy & 127) * 128 + (ix & 127)];
    const b = values[(iy & 127) * 128 + ((ix + 1) & 127)];
    const c = values[((iy + 1) & 127) * 128 + (ix & 127)];
    const d = values[((iy + 1) & 127) * 128 + ((ix + 1) & 127)];
    return a + (b - a) * sx + ((c - a) + (a - b - c + d) * sx) * sy;
  };
}

function dimension(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(64, Math.min(1600, Math.round(number))) : fallback;
}

/** Stable across redraws; a newly committed output version gets new abrasion. */
export function wearSeedForNode(node = {}) {
  const output = node.output || {};
  // Deliberately exclude selection, drag position, status and wall-clock time.
  const revision = output.versionId ?? output.revision ?? output.version ??
    node.outputRevision ?? node.revision ?? node.versions?.length ?? 0;
  const image = output.candidateImageUrl || output.imageUrl ||
    node.params?.front?.url || node.params?.reference?.url || '';
  return hash(`${node.id || node.type || 'node'}|${revision}|${image}`);
}

/**
 * maskUrl: white RGBA PNG with transparent unabraded pixels, CSS mask ready.
 * surfaceUrl: subtle paint-grain PNG; put it over the painted tag, under text.
 * angle: stroke direction in screen-space degrees. It never rotates the image.
 */
export function getWearMask(seed, {width = 800, height = 440} = {}) {
  width = dimension(width, 800); height = dimension(height, 440);
  const seedValue = typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : hash(seed);
  const key = `${seedValue}:${width}:${height}`;
  if (cache.has(key)) {
    const result = cache.get(key);
    cache.delete(key); cache.set(key, result);
    return result;
  }
  const rng = random(seedValue), noise = field(seedValue ^ 0x3bd17153);
  const directions = [-31, 31, 90, -7];
  const angle = directions[seedValue % directions.length] + (rng() - .5) * 17;
  const radians = angle * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const cx = 414 + (rng() - .5) * 18, cy = 242 + (rng() - .5) * 8;
  const halfWidth = 248 + rng() * 25, halfHeight = 139 + rng() * 9;
  const phase = rng() * 80;
  const mask = document.createElement('canvas'), surface = document.createElement('canvas');
  mask.width = surface.width = width; mask.height = surface.height = height;
  const maskContext = mask.getContext('2d'), surfaceContext = surface.getContext('2d');
  const maskImage = maskContext.createImageData(width, height);
  const surfaceImage = surfaceContext.createImageData(width, height);
  const pixels = maskImage.data, paint = surfaceImage.data;
  const sx = 800 / width, sy = 440 / height;

  for (let py = 0; py < height; py++) {
    const y = (py + .5) * sy;
    if (y < 12 || y > 428) continue;
    const side = Math.abs(y - 220) / 208;
    const left = 98 - 86 * side, right = 792 - 86 * side;
    for (let px = 0; px < width; px++) {
      const x = (px + .5) * sx, index = (py * width + px) * 4;
      if (x <= left || x >= right) continue;
      const dx = x - cx, dy = y - cy;
      const u = dx * cos + dy * sin + 380, v = -dx * sin + dy * cos + 380;
      const dust = noise(x * .71 + phase, y * .71);
      const grain = noise(x * .17, y * .17 + phase);
      const edgeDistance = Math.min(x - left, right - x, y - 12, 428 - y);
      // A little fine pigment erosion survives at thumbnail size. Keep the
      // title/footer quiet, and mix pale flakes with sparse darker paint pits.
      const textQuiet = x > 115 && x < 690 && (y < 78 || y > 380) ? .18 : 1;
      const surfaceFlake = smooth((grain - .61) * 5) * smooth((dust - .40) * 3);
      const surfaceAlpha = (Math.max(0, (dust - .58) * 40) +
        Math.max(0, (grain - .57) * 25) + surfaceFlake * 58) * textQuiet +
        Math.max(0, 1 - edgeDistance / 5.5) * smooth((dust - .38) * 2.3) * 155;
      const darkPit = grain < .32 && dust > .68;
      paint[index] = darkPit ? 61 : 242;
      paint[index + 1] = darkPit ? 45 : 237;
      paint[index + 2] = darkPit ? 41 : 224;
      paint[index + 3] = Math.min(180, surfaceAlpha + (darkPit ? (dust - .68) * 105 * textQuiet : 0));

      // Protected label, footer, pointed head and tail. Fade reaches zero
      // before any safety boundary, so there is never a visible rectangle.
      const edgeSafety = smooth((x - 128) / 48) * smooth((689 - x) / 45) *
        smooth((y - 78) / 29) * smooth((392 - y) / 26);
      if (!edgeSafety) continue;

      // Different scrub lanes have different travel, offset and depth. These
      // warped straight-sided fields avoid the previous smooth oval opening.
      const travel = (noise(v / 16, phase) - .5) * 90 + (noise(v / 4.1, phase + 19) - .5) * 23;
      const normalizedX = (dx - travel * cos) / halfWidth;
      const normalizedY = (dy - travel * sin * .40) / halfHeight;
      // Rotate the probability field as well as the fine strokes. A worn
      // diagonal consequently has a genuinely slanted silhouette, rather
      // than scratches decorating a rectangular/oval thumbnail window.
      const localU = normalizedX * cos + normalizedY * sin;
      const localV = -normalizedX * sin + normalizedY * cos;
      const au = Math.abs(localU), av = Math.abs(localV);
      const reach = Math.max(au, av) * .45 + (au + av) * .48;
      const broad = (noise(x / 66 + phase, y / 42) - .5) * .34;
      const probability = smooth((1.37 - reach + broad) / .79) * edgeSafety;
      if (!probability) continue;

      // Long anisotropic ridges supply dense sanding strokes; broken coherent
      // flakes add the mineral-paint texture. Center probability tends to 1,
      // leaving a readable full-garment preview rather than obscuring its middle.
      const longRake = noise(u / 104, v / 1.65 + phase);
      const brokenRake = noise(u / 34, v / 3.6 + phase);
      const flakes = noise(x / 4.4 + phase, y / 4.4);
      const micro = noise(x * .87, y * .87 + phase);
      const threshold = .10 + longRake * .43 + brokenRake * .21 + flakes * .20 + micro * .06;
      // Keep the full small garment readable. Beyond it, actual paint islands
      // and long fragmented ridges break up the formerly solid pale opening.
      // Protection fades continuously, avoiding a rectangular inner boundary.
      const readProtection = smooth((x - 244) / 28) * smooth((579 - x) / 28) *
        smooth((y - 102) / 24) * smooth((371 - y) / 24);
      const outerStrength = 1 - readProtection;
      const ridge = longRake * .67 + brokenRake * .33;
      const paintRidges = smooth((ridge + flakes * .14 - .61) / .13);
      const paintIslands = smooth((flakes - .56) / .20) * smooth((brokenRake - .46) / .22);
      const centerFlecks = smooth((flakes - .77) / .14) * smooth((micro - .60) / .20) * .14;
      const remnant = Math.max(paintRidges * .96, paintIslands * .88) * outerStrength +
        centerFlecks * readProtection;
      // A few lower-probability directional whiskers extend the wipe past the
      // main worn mass. Their own envelope still ends before the tag boundary.
      const whisker = smooth((.32 - longRake) / .20) * smooth((.55 - brokenRake) / .30);
      const extendedProbability = probability + whisker * .18 * outerStrength * edgeSafety *
        smooth((1.58 - reach) / .30);
      const reveal = smooth((extendedProbability - threshold) / .035 + .5) * (1 - remnant);
      pixels[index] = pixels[index + 1] = pixels[index + 2] = 255;
      pixels[index + 3] = Math.round(reveal * 255);
    }
  }
  maskContext.putImageData(maskImage, 0, 0);
  surfaceContext.putImageData(surfaceImage, 0, 0);
  const result = Object.freeze({maskUrl: mask.toDataURL('image/png'), surfaceUrl: surface.toDataURL('image/png'), angle});
  cache.set(key, result);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return result;
}
