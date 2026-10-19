/** Real triangle intersections on a procedural garment, with replayable UV marks.
 * No screen-space random hits, photo registration, or cloth physics are implied.
 */
import * as THREE from '../vendor/three/build/three.module.js';

export const MODEL_ID = 'proxy-coat-v1';
export const MAX_STROKES = 100, MAX_HITS = 12000;
export const PARTS = Object.freeze({
  torso: { label: '衣身', tile: [0, 0, .5, 1] },
  left_sleeve: { label: '左袖', tile: [.5, .5, .25, .5] },
  right_sleeve: { label: '右袖', tile: [.75, .5, .25, .5] },
  collar: { label: '领部', tile: [.5, 0, .5, .5] },
});
const finite = (value, low, high) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
const round = value => Math.round(value * 1e6) / 1e6;
const vec = vector => ({ x: round(vector.x), y: round(vector.y), z: round(vector.z) });

function atlasGeometry(geometry, part) {
  const uv = geometry.getAttribute('uv'), [x, y, w, h] = PARTS[part].tile;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, x + uv.getX(i) * w, y + uv.getY(i) * h);
  uv.needsUpdate = true; return geometry;
}

function coatGeometry() {
  const positions = [], uvs = [], indices = [], rings = 24, segments = 64;
  for (let row = 0; row <= rings; row++) {
    const v = row / rings, y = .67 + v * 1.38;
    const waist = Math.exp(-Math.pow((v - .56) / .19, 2));
    const rx = .53 - .13 * waist - .055 * v, rz = .275 - .055 * waist;
    for (let col = 0; col <= segments; col++) {
      const u = col / segments, theta = u * Math.PI * 2 + Math.PI;
      positions.push(Math.sin(theta) * rx, y, Math.cos(theta) * rz);
      uvs.push(u, v);
      if (row < rings && col < segments) {
        const a = row * (segments + 1) + col, b = a + 1, c = a + segments + 1, d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals(); return geometry;
}

export function createGarmentProxy(texture = null) {
  const group = new THREE.Group(); group.name = MODEL_ID;
  const targets = [], colliders = [];
  const cloth = new THREE.MeshStandardMaterial({ color: 0xe4e7de, roughness: .96, metalness: 0, map: texture, side: THREE.DoubleSide });
  const mannequin = new THREE.MeshStandardMaterial({ color: 0x9eaaa6, roughness: .65, metalness: .06 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x405756, roughness: .85 });
  function garment(geometry, name) {
    const mesh = new THREE.Mesh(atlasGeometry(geometry, name), cloth);
    mesh.name = PARTS[name].label; mesh.userData = { hitTarget: true, partId: name, proxyRoot: group };
    mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); targets.push(mesh); colliders.push(mesh); return mesh;
  }
  function body(geometry, position, material = mannequin, scale = null) {
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(...position);
    if (scale) mesh.scale.set(...scale);
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.hitTarget = false;
    group.add(mesh); colliders.push(mesh); return mesh;
  }
  garment(coatGeometry(), 'torso');
  for (const sign of [-1, 1]) {
    const top = new THREE.Vector3(sign * .49, 1.94, 0), bottom = new THREE.Vector3(sign * .86, 1.17, 0);
    const sleeve = garment(new THREE.CylinderGeometry(.19, .137, top.distanceTo(bottom), 40, 12, false), sign < 0 ? 'left_sleeve' : 'right_sleeve');
    sleeve.position.copy(top).add(bottom).multiplyScalar(.5);
    sleeve.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), top.clone().sub(bottom).normalize());
    body(new THREE.SphereGeometry(.104, 24, 16), [sign * .895, 1.075, 0], mannequin, [.8, 1.2, .72]);
    body(new THREE.CylinderGeometry(.145, .105, .64, 24), [sign * .205, .36, 0], dark);
    body(new THREE.SphereGeometry(.14, 24, 16), [sign * .205, .07, .075], dark, [.9, .46, 1.8]);
  }
  body(new THREE.CylinderGeometry(.09, .11, .2, 32), [0, 2.105, 0]);
  body(new THREE.SphereGeometry(.205, 40, 24), [0, 2.35, 0], mannequin, [.88, 1.15, .93]);
  const collar = garment(new THREE.CylinderGeometry(.14, .215, .12, 40, 3, true), 'collar'); collar.position.set(0, 2.045, 0);
  // Modest seam and button details give the coat readable volume and direction.
  for (let index = 0; index < 5; index++) {
    const y = 1.2 + index * .15, v = (y - .67) / 1.38, waist = Math.exp(-Math.pow((v - .56) / .19, 2));
    const button = new THREE.Mesh(new THREE.SphereGeometry(.019, 12, 8), dark);
    button.position.set(.035, y, .285 - .055 * waist); button.scale.z = .45; group.add(button);
  }
  group.updateMatrixWorld(true);
  return { group, targets, colliders, materials: [cloth, mannequin, dark] };
}

/** Intersect all occluders first; skin or a nearer blocker is a genuine miss. */
export function hitAt(camera, colliders, ndc, { force = .5, time = 0, speed = 0 } = {}) {
  if (!finite(ndc?.x, -1, 1) || !finite(ndc?.y, -1, 1)) return null;
  camera.updateMatrixWorld(true);
  colliders.forEach(mesh => mesh.updateWorldMatrix(true, false));
  const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
  const hit = ray.intersectObjects(colliders, false)[0];
  if (!hit?.object.userData.hitTarget || !hit.uv || !hit.face) return null;
  const partId = hit.object.userData.partId, part = PARTS[partId]; if (!part) return null;
  const normal = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
  const local = hit.object.userData.proxyRoot.worldToLocal(hit.point.clone());
  const [x, y, w, h] = part.tile;
  return { partId, side: local.z >= 0 ? 'front' : 'back', point: vec(hit.point), normal: vec(normal),
    uv: { u: round(Math.max(0, Math.min(1, (hit.uv.x - x) / w))), v: round(Math.max(0, Math.min(1, (hit.uv.y - y) / h))) },
    atlasUv: { u: round(hit.uv.x), v: round(hit.uv.y) }, time: Math.max(0, Math.round(time)),
    force: Math.max(.05, Math.min(1, force)), speed: Math.max(0, Math.min(20, speed)), triangle: hit.faceIndex };
}

/** The dragged blade is sampled along its actual screen ray sweep, not a random region. */
export function sweepHits(camera, colliders, from, to, settings = {}) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y), count = Math.max(1, Math.min(96, Math.ceil(distance * 100)));
  const result = []; let previous = null;
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const hit = hitAt(camera, colliders, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, settings);
    if (!hit) { previous = null; continue; }
    hit.breakBefore = !previous || previous.partId !== hit.partId || Math.hypot(previous.uv.u - hit.uv.u, previous.uv.v - hit.uv.v) > .18;
    if (!previous || Math.hypot(previous.atlasUv.u - hit.atlasUv.u, previous.atlasUv.v - hit.atlasUv.v) > .0002) result.push(hit);
    previous = hit;
  }
  return result;
}

export function emptyBattle() { return { version: 1, modelId: MODEL_ID, strokes: [], misses: 0, camera: null }; }
export function validateBattle(value) {
  if (!value) return emptyBattle();
  if (value.version !== 1 || value.modelId !== MODEL_ID || !Array.isArray(value.strokes) || value.strokes.length > MAX_STROKES) throw Error('3D 实验记录版本或数量无效。');
  let count = 0; const ids = new Set();
  const strokes = value.strokes.map(stroke => {
    if (typeof stroke.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(stroke.id) || ids.has(stroke.id)
      || !['slash', 'blood', 'wear'].includes(stroke.effect) || !/^#[a-f\d]{6}$/i.test(stroke.color)
      || !finite(stroke.size, .001, .04) || !finite(stroke.force, .05, 1) || !Array.isArray(stroke.hits) || !stroke.hits.length) throw Error('3D 命中笔划格式无效。');
    ids.add(stroke.id); count += stroke.hits.length; if (count > MAX_HITS) throw Error('3D 命中记录过多，请分开保存实验。');
    const hits = stroke.hits.map(hit => {
      if (!PARTS[hit.partId] || !['front', 'back'].includes(hit.side) || !finite(hit.time, 0, 1e15) || !finite(hit.force, .05, 1)
        || !finite(hit.speed, 0, 20) || !Number.isInteger(hit.triangle) || hit.triangle < 0) throw Error('3D 命中事件无效。');
      for (const vector of [hit.point, hit.normal]) if (!vector || !['x', 'y', 'z'].every(key => finite(vector[key], -10, 10))) throw Error('三维命中坐标无效。');
      if (Math.abs(Math.hypot(hit.normal.x, hit.normal.y, hit.normal.z) - 1) > .01) throw Error('命中法向量必须归一化。');
      for (const uv of [hit.uv, hit.atlasUv]) if (!uv || !finite(uv.u, 0, 1) || !finite(uv.v, 0, 1)) throw Error('命中纹理坐标无效。');
      const [x, y, w, h] = PARTS[hit.partId].tile;
      if (Math.abs(hit.atlasUv.u - (x + hit.uv.u * w)) > .00001 || Math.abs(hit.atlasUv.v - (y + hit.uv.v * h)) > .00001) throw Error('命中部件与纹理区域不一致。');
      return { partId: hit.partId, side: hit.side, point: { ...hit.point }, normal: { ...hit.normal }, uv: { ...hit.uv }, atlasUv: { ...hit.atlasUv },
        time: hit.time, force: hit.force, speed: hit.speed, triangle: hit.triangle, breakBefore: Boolean(hit.breakBefore) };
    });
    return { id: stroke.id, effect: stroke.effect, color: stroke.color.toLowerCase(), size: stroke.size, force: stroke.force, hits };
  });
  const camera = value.camera && ['position', 'target'].every(key => Array.isArray(value.camera[key]) && value.camera[key].length === 3 && value.camera[key].every(v => finite(v, -30, 30))) ? structuredClone(value.camera) : null;
  return { version: 1, modelId: MODEL_ID, strokes, misses: Number.isInteger(value.misses) ? Math.max(0, Math.min(10000, value.misses)) : 0, camera };
}

export function paintAtlas(canvas, state, { transparent = false, hitMap = false } = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true }), width = canvas.width, height = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
  ctx.clearRect(0, 0, width, height);
  if (!transparent) {
    ctx.fillStyle = '#c3cbc2'; ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#87968a22'; ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 5) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    for (let y = 0; y < height; y += 5) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
  }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const stroke of state.strokes) {
    let previous = null;
    for (const hit of stroke.hits) {
      const x = hit.atlasUv.u * width, y = (1 - hit.atlasUv.v) * height;
      const part = PARTS[hit.partId], [tx, ty, tw, th] = part.tile;
      ctx.save(); ctx.beginPath(); ctx.rect(tx * width, (1 - ty - th) * height, tw * width, th * height); ctx.clip();
      const size = stroke.size * width * (.4 + hit.force);
      ctx.strokeStyle = hitMap ? (hit.side === 'front' ? '#176b83' : '#a2502a') : stroke.color;
      ctx.fillStyle = ctx.strokeStyle; ctx.globalAlpha = hitMap ? .85 : stroke.effect === 'wear' ? .45 : .75;
      ctx.lineWidth = hitMap ? 3 : size;
      if (previous && !hit.breakBefore && previous.partId === hit.partId && Math.hypot(previous.atlasUv.u - hit.atlasUv.u, previous.atlasUv.v - hit.atlasUv.v) < .12) {
        ctx.beginPath(); ctx.moveTo(previous.atlasUv.u * width, (1 - previous.atlasUv.v) * height); ctx.lineTo(x, y); ctx.stroke();
      } else { ctx.beginPath(); ctx.arc(x, y, Math.max(hitMap ? 2 : 1, ctx.lineWidth / 2), 0, Math.PI * 2); ctx.fill(); }
      if (!hitMap && stroke.effect === 'slash') {
        ctx.globalAlpha = .85; ctx.strokeStyle = '#263b36'; ctx.lineWidth = Math.max(.7, size * .22);
        ctx.beginPath(); ctx.moveTo(x - size * .25, y - size * .2); ctx.lineTo(x + size * .3, y + size * .22); ctx.stroke();
      }
      ctx.restore(); previous = hit;
    }
  }
  ctx.globalAlpha = 1;
}

export function battleExport(state) {
  const clean = validateBattle(state);
  return { ...clean, exportedAt: new Date().toISOString(), collisionMethod: 'nearest_triangle_screen_ray_sweep',
    coordinateSpace: 'procedural_garment_3d_and_uv', geometryCollision: true, physicalClothSimulation: false,
    photoRegistered: false, forceMeaning: 'visual brush pressure; not measured impact force', parts: PARTS };
}
