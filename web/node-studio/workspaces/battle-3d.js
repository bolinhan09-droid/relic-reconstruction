import * as THREE from '../vendor/three/build/three.module.js';
import { OrbitControls } from '../vendor/three/examples/jsm/controls/OrbitControls.js';
import { createGarmentProxy, sweepHits, validateBattle, paintAtlas, battleExport, PARTS, MAX_STROKES, MAX_HITS } from '../core/battle-hits.js';
import { createWorkspace, el, field, actions, notice, inputFor, assetURL, uploadCanvas } from './shared.js';

const colors = { slash: '#604d3d', blood: '#78322d', wear: '#c4b897' };

export async function battleSimulation3D(container, context) {
  const ws = createWorkspace(container, context, { title: '3D 服装战斗实验', description: '旋转服装人台，沿真实三维表面挥划。只有刀刃射线碰到衣物，才会留下可重放的痕迹。' });
  const input = inputFor(context);
  let state;
  try { state = validateBattle(ws.params.battle3D || context.node.output?.battle3D); }
  catch (error) { ws.body.append(notice(error.message)); return ws; }
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true }); }
  catch { ws.body.append(notice('当前窗口无法创建 3D 画布。请启用浏览器硬件加速后重新进入；已有实验记录仍保留。')); return ws; }
  const layout = el('section', { class: 'ns-battle3d' }), left = el('div'), panel = el('aside', { class: 'ns-battle3d-panel', 'aria-label': '3D 实验工具' });
  const stage = el('div', { class: 'ns-battle3d-stage' });
  const canvas = renderer.domElement; canvas.tabIndex = 0; canvas.setAttribute('aria-label', '三维服装画布。观察模式拖动旋转；挥刀模式拖动命中衣服。也可使用视角按钮和准星试划。');
  const cameraLabel = el('span', { text: '代理服装 · 正面' }), cursorLabel = el('span', { text: '观察模式' });
  stage.append(canvas, el('div', { class: 'ns-battle3d-hud' }, cameraLabel, cursorLabel), el('span', { class: 'ns-battle3d-crosshair', 'aria-hidden': 'true' }));
  left.append(stage); layout.append(left, panel); ws.body.append(layout);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xe3e9e2);
  const camera = new THREE.PerspectiveCamera(35, 1, .05, 60); camera.position.set(0, 1.48, 5.5);
  const controls = new OrbitControls(camera, canvas); controls.target.set(0, 1.3, 0); controls.enableDamping = false;
  controls.minDistance = 2.7; controls.maxDistance = 9; controls.maxPolarAngle = Math.PI * .88; controls.minPolarAngle = .16; controls.enablePan = true;
  const atlas = el('canvas', { width: 1024, height: 1024, class: 'ns-battle3d-texture', 'aria-label': '服装展开纹理与三维命中位置预览' });
  paintAtlas(atlas, state); const texture = new THREE.CanvasTexture(atlas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const proxy = createGarmentProxy(texture); scene.add(proxy.group);
  scene.add(new THREE.HemisphereLight(0xf5f5eb, 0x52675e, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 3.2); key.position.set(3.5, 5, 4); key.castShadow = true; key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -3; key.shadow.camera.right = 3; key.shadow.camera.top = 4; key.shadow.camera.bottom = -2; key.shadow.bias = -.00015; scene.add(key);
  const fill = new THREE.DirectionalLight(0xc8d6e2, 1.4); fill.position.set(-3, 2.7, -3); scene.add(fill);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(2.5, 64), new THREE.MeshStandardMaterial({ color: 0xcbd7cb, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -.025; floor.receiveShadow = true; scene.add(floor);
  const grid = new THREE.GridHelper(4, 16, 0x8ea798, 0xb6c7b9); grid.position.y = -.018; grid.material.transparent = true; grid.material.opacity = .4; scene.add(grid);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;

  const mode = field(ws, '_battleMode', '操作方式', { persist: false, value: 'orbit', options: [{ value: 'orbit', label: '观察 · 拖动旋转' }, { value: 'slash', label: '挥刀 · 拖动留痕' }, { value: 'points', label: '两点挥刀 · 依次点击' }] });
  const effect = field(ws, '_battleEffect', '留下什么痕迹', { persist: false, value: 'slash', options: [{ value: 'slash', label: '刀痕' }, { value: 'blood', label: '染色痕迹' }, { value: 'wear', label: '磨损' }] });
  const force = field(ws, '_battleForce', '挥划力度 · 视觉参数', { persist: false, type: 'range', min: .05, max: 1, step: .05, value: .55, help: '影响痕迹宽度与显眼程度，不代表测量的物理冲击力。' });
  const size = field(ws, '_battleSize', '痕迹宽度', { persist: false, type: 'range', min: .002, max: .025, step: .001, value: .006 });
  const count = el('p', { class: 'ns-battle3d-count', role: 'status', 'aria-live': 'polite' });
  const recordList = el('ol', { class: 'ns-battle3d-records' });
  const records = el('details', {}, el('summary', { text: '命中记录 · 部件与正反面' }), recordList);
  const uv = el('details', { class: 'ns-battle3d-uv', open: '' }, el('summary', { text: '服装纹理与痕迹' }), atlas,
    el('p', { class: 'ns-battle3d-help', text: '左侧为衣身；右上两块为袖子，右下为领部。痕迹来自实际三维命中的纹理坐标。' }));
  panel.append(mode.group, effect.group, force.group, size.group, count,
    ws.button('沿准星试划一次', () => centerSlash()),
    actions(ws.button('撤销上次挥划', () => undo()), ws.button('清空痕迹', () => clear())), uv, records);

  let pending = null, pointer = null, firstPoint = null, line = null, dirty = false;
  function render() { if (!ws.signal.aborted) renderer.render(scene, camera); }
  function updateCameraLabel() {
    const direction = camera.position.clone().sub(controls.target);
    cameraLabel.textContent = `代理服装 · ${Math.abs(direction.x) > Math.abs(direction.z) ? direction.x > 0 ? '右侧' : '左侧' : direction.z >= 0 ? '正面' : '背面'}`;
  }
  function refreshTexture() {
    paintAtlas(atlas, pending?.hits.length ? { ...state, strokes: [...state.strokes, pending] } : state);
    texture.needsUpdate = true; render();
  }
  function summary() {
    const hits = state.strokes.flatMap(stroke => stroke.hits), fronts = hits.filter(hit => hit.side === 'front').length;
    count.textContent = `已保存 ${state.strokes.length} 次挥划 · ${hits.length} 个真实命中点\n正面 ${fronts} · 背面 ${hits.length - fronts} · 空挥 ${state.misses} 次`;
    recordList.replaceChildren();
    for (const stroke of state.strokes.slice(-8).reverse()) {
      const parts = [...new Set(stroke.hits.map(hit => PARTS[hit.partId].label))].join('、');
      const sides = [...new Set(stroke.hits.map(hit => hit.side === 'front' ? '正面' : '背面'))].join(' / ');
      recordList.append(el('li', { text: `${parts}，${sides}，${stroke.hits.length} 点，${({ slash: '刀痕', blood: '染色', wear: '磨损' })[stroke.effect]}` }));
    }
  }
  function cameraState() { return { position: camera.position.toArray().map(v => Number(v.toFixed(5))), target: controls.target.toArray().map(v => Number(v.toFixed(5))) }; }
  function snapshot() { return validateBattle({ ...state, camera: cameraState() }); }
  function markDirty() { dirty = true; ws.patch({ battle3D: snapshot() }); summary(); }
  function removeLine() { if (!line) return; scene.remove(line); line.geometry.dispose(); line.material.dispose(); line = null; }
  function drawTrajectory(hits) {
    removeLine(); if (!hits.length) return;
    const points = hits.map(hit => new THREE.Vector3(hit.point.x + hit.normal.x * .012, hit.point.y + hit.normal.y * .012, hit.point.z + hit.normal.z * .012));
    line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x8e4333, transparent: true, opacity: .65, depthTest: true })); scene.add(line);
  }
  function startStroke() {
    if (state.strokes.length >= MAX_STROKES) throw Error('本次实验已满100次挥划，请保存后开始另一版。');
    pending = { id: 'swing-' + crypto.randomUUID().replaceAll('-', '').slice(0, 16), effect: effect.control.value,
      color: colors[effect.control.value], size: Number(size.control.value), force: Number(force.control.value), hits: [] };
  }
  function addSweep(from, to, elapsed = 100) {
    if (!pending) return;
    const currentCount = state.strokes.reduce((n, stroke) => n + stroke.hits.length, 0) + pending.hits.length;
    if (currentCount >= MAX_HITS) { ws.say('命中记录已达到上限，请保存本轮。', true); return; }
    const hits = sweepHits(camera, proxy.colliders, from, to, { force: pending.force, time: Date.now(), speed: Math.hypot(to.x - from.x, to.y - from.y) / Math.max(.016, elapsed / 1000) }).slice(0, MAX_HITS - currentCount);
    pending.hits.push(...hits); cursorLabel.textContent = hits.length ? `命中 ${PARTS[hits.at(-1).partId].label} · ${hits.at(-1).side === 'front' ? '正面' : '背面'}` : '空挥 · 没有衣物碰撞';
    drawTrajectory(pending.hits); refreshTexture();
  }
  function finishStroke(cancel = false) {
    if (!pending) return;
    if (!cancel && pending.hits.length) { state.strokes.push(pending); ws.say('已记录这次真实命中，可以旋转查看正反面。'); }
    else if (!cancel) { state.misses++; ws.say('这次没有击中服装，未添加痕迹。'); }
    pending = null; pointer = null; firstPoint = null; removeLine(); refreshTexture();
    if (!cancel) markDirty();
  }
  function ndc(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width * 2 - 1, y: 1 - (event.clientY - rect.top) / rect.height * 2 }; }
  function centerSlash() {
    if (pending) finishStroke(true);
    startStroke(); addSweep({ x: -.13, y: .12 }, { x: .13, y: -.12 }, 350); finishStroke();
  }
  function undo() { if (pending) finishStroke(true); if (!state.strokes.length) return; state.strokes.pop(); markDirty(); refreshTexture(); ws.say('已撤销上次挥划。'); }
  function clear() { if (pending) finishStroke(true); state.strokes = []; state.misses = 0; markDirty(); refreshTexture(); ws.say('已清空当前实验痕迹，尚未覆盖保存的版本。'); }
  function view(x, y, z) { if (pending) finishStroke(true); controls.target.set(0, 1.3, 0); camera.position.set(x, y, z); controls.update(); updateCameraLabel(); render(); }
  const views = el('div', { class: 'ns-battle3d-views' }, ws.button('正面', () => view(0, 1.48, 5.5)), ws.button('背面', () => view(0, 1.48, -5.5)),
    ws.button('左侧', () => view(-5.5, 1.48, 0)), ws.button('右侧', () => view(5.5, 1.48, 0)));
  left.append(views, el('p', { class: 'ns-battle3d-help', text: '观察模式：拖动旋转，滚轮缩放。挥刀模式：沿衣物拖动；两点模式：依次点起点和终点。方向键旋转，空格沿准星试划，Ctrl+Z 撤销。' }));
  ws.on(mode.control, 'change', () => { if (pending) finishStroke(true); controls.enabled = mode.control.value === 'orbit'; cursorLabel.textContent = mode.control.value === 'orbit' ? '观察模式' : mode.control.value === 'points' ? '点击挥划起点' : '拖动挥刀'; canvas.style.cursor = controls.enabled ? 'grab' : 'crosshair'; });
  ws.on(canvas, 'pointerdown', event => {
    if (event.button !== 0 || mode.control.value === 'orbit') return;
    event.preventDefault(); canvas.focus();
    try {
      if (mode.control.value === 'points') {
        if (!firstPoint) { firstPoint = ndc(event); startStroke(); cursorLabel.textContent = '再点击终点完成挥划'; }
        else { addSweep(firstPoint, ndc(event), 350); finishStroke(); }
        return;
      }
      startStroke(); pointer = { id: event.pointerId, point: ndc(event), time: event.timeStamp }; canvas.setPointerCapture(event.pointerId);
    } catch (error) { ws.say(error.message, true); }
  });
  ws.on(canvas, 'pointermove', event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const point = ndc(event); addSweep(pointer.point, point, event.timeStamp - pointer.time); pointer = { ...pointer, point, time: event.timeStamp };
  });
  ws.on(canvas, 'pointerup', event => { if (pointer?.id === event.pointerId) { finishStroke(); if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } });
  ws.on(canvas, 'pointercancel', () => finishStroke(true));
  ws.on(canvas, 'keydown', event => {
    if (event.code === 'Space') { event.preventDefault(); try { centerSlash(); } catch (error) { ws.say(error.message, true); } }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); }
    if (event.key === 'Escape') finishStroke(true);
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); const offset = camera.position.clone().sub(controls.target), spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta += event.key === 'ArrowLeft' ? .18 : event.key === 'ArrowRight' ? -.18 : 0;
      spherical.phi = Math.max(.2, Math.min(Math.PI - .2, spherical.phi + (event.key === 'ArrowUp' ? -.13 : event.key === 'ArrowDown' ? .13 : 0)));
      camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical)); controls.update(); updateCameraLabel(); render();
    }
  });
  controls.addEventListener('change', () => { updateCameraLabel(); render(); });
  function exportJSON() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(battleExport(snapshot()), null, 2)], { type: 'application/json' }));
    const link = el('a', { href: url, download: 'garment-3d-hit-records.json' }); link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const save = ws.button('保存 3D 实验与图谱', async () => {
    if (pending) throw Error('先完成或取消当前挥划，再保存实验。');
    state = snapshot(); paintAtlas(atlas, state); texture.needsUpdate = true; render();
    const hitCanvas = el('canvas', { width: 1024, height: 1024 }); paintAtlas(hitCanvas, state, { transparent: true, hitMap: true });
    const screenshot = await uploadCanvas(context, canvas, 'battle-3d-preview.png');
    const uvAsset = await uploadCanvas(context, atlas, 'battle-3d-uv.png');
    const hitAsset = await uploadCanvas(context, hitCanvas, 'battle-3d-hit-map.png');
    ws.patch({ battle3D: state }); await ws.save();
    await ws.commit({ ...input, kind: 'experiment_3d', imageUrl: assetURL(input), battle3D: state,
      previewUrl: screenshot.url, battlePreviewUrl: screenshot.url, uvTextureUrl: uvAsset.url, hitMapUrl: hitAsset.url,
      files: [{ label: '3D 实验截图', url: screenshot.url }, { label: '衣物 UV 纹理', url: uvAsset.url }, { label: '正反面命中图谱', url: hitAsset.url }],
      geometryCollision: true, physicalSimulation: false, photoRegistered: false, apiRequest: false,
      message: '已保存真实三角面碰撞与纹理命中。代理服装未配准到上传照片，原服装方案保留。' });
    dirty = false; ws.say('已保存 3D 实验、UV 纹理、命中图谱和当前视角截图。重新打开可继续。');
  }, { primary: true });
  ws.body.append(actions(save, ws.button('导出三维命中 JSON', () => exportJSON())),
    notice('这里使用可见的三维代理服装。碰撞位置、表面法向与纹理坐标来自真实三角面求交；未模拟布料破裂，也未自动对应上传照片。正面和背面的痕迹分别保留。'));
  const observer = new ResizeObserver(() => {
    if (ws.signal.aborted) return; const width = Math.max(1, stage.clientWidth), height = Math.max(1, stage.clientHeight);
    renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); render();
  }); observer.observe(stage);
  if (state.camera) { camera.position.fromArray(state.camera.position); controls.target.fromArray(state.camera.target); }
  controls.update(); summary(); updateCameraLabel(); render();
  ws.cleanup(() => { observer.disconnect(); controls.dispose(); removeLine();
    scene.traverse(item => { item.geometry?.dispose(); }); proxy.materials.forEach(material => material.dispose());
    floor.material.dispose(); grid.material.dispose(); texture.dispose(); renderer.dispose(); renderer.forceContextLoss();
  });
  // Exposed on this workspace only, for browser QA and host screenshot capture.
  ws.battle3D = { getState: () => snapshot(), proxy, camera, renderer, centerSlash, view, undo, clear, exportJSON, get dirty() { return dirty; } };
  return ws;
}
