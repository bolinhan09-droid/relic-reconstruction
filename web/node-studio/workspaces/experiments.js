import { createWorkspace, el, field, actions, notice, loadImage, assetURL, inputFor, uploadCanvas } from './shared.js';
import { attachMagnifier } from './magnifier.js';

let brushEnginePromise;
async function brushEngine() {
  if (window.BattleBrushEngine) return window.BattleBrushEngine;
  if (!brushEnginePromise) brushEnginePromise = new Promise((resolve, reject) => {
    const script = el('script', { src: '/brush-engine.js' });
    script.onload = () => window.BattleBrushEngine ? resolve(window.BattleBrushEngine) : reject(new Error('笔刷引擎没有加载。'));
    script.onerror = () => { brushEnginePromise = null; reject(new Error('笔刷引擎未能加载，请重试。')); };
    document.head.append(script);
  });
  return brushEnginePromise;
}

async function sketchSurface(ws, context) {
  const input = inputFor(context), url = assetURL(input);
  if (!url) { ws.body.append(notice('先连接真实服装图片，再开始实验。')); return null; }
  const image = await loadImage(url), engine = await brushEngine(), scale = Math.min(1, 950 / image.naturalWidth, 760 / image.naturalHeight);
  const canvas = el('canvas', { class: 'ns-ws-experiment-canvas', tabindex: '0', 'aria-label': '实验痕迹预览画布' });
  canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
  const overlay = document.createElement('canvas'); overlay.width = canvas.width; overlay.height = canvas.height;
  const strokes = structuredClone(ws.params.experimentStrokes || []), events = structuredClone(ws.params.events || []);
  const context2d = canvas.getContext('2d');
  function redraw() { context2d.clearRect(0, 0, canvas.width, canvas.height); context2d.drawImage(image, 0, 0, canvas.width, canvas.height); engine.draw(overlay, strokes); context2d.drawImage(overlay, 0, 0); }
  const scene = context.workflow.nodes.find(node => node.type === 'scene_context');
  const color = scene?.params?.bloodColor || '#6d2530';
  function add({ type = 'slash', subtype = 'slit', points = [{ x: .4, y: .5 }, { x: .6, y: .6 }], size = .035, opacity = .8, direction } = {}) {
    const stroke = engine.createStroke({ type, effectSubtype: subtype, size, opacity, ...(type === 'blood' ? { color } : {}), ...(Number.isFinite(direction) ? { direction } : {}) });
    points.forEach(point => engine.appendPoint(stroke, point, canvas.width, canvas.height)); strokes.push(stroke); redraw(); return stroke;
  }
  function record(event) { events.push({ ...event, at: Date.now() }); ws.patch({ experimentStrokes: strokes, events }); }
  async function save() {
    if (!strokes.length) throw new Error('先产生一些痕迹再保存草稿。');
    const exportCanvas = engine.renderGuide(image, strokes), asset = await uploadCanvas(context, exportCanvas, '实验痕迹草稿.png');
    ws.patch({ experimentStrokes: strokes, events }); await ws.save();
    await ws.commit({ ...input, kind: 'garment', imageUrl: asset.url, asset, reference: asset,
      sourceBrushStrokes: [...(input.sourceBrushStrokes || input.brushStrokes || []), ...strokes],
      originalProjectSnapshot: input.projectSnapshot || input.originalProjectSnapshot || null,
      projectSnapshot: null, brushStrokes: [], damageItems: [], rasterized: true, imageSemantics: 'raster_base', editableStrokes: false,
      experimentEvents: events, experimental: true, physicalSimulation: false, generatedBy: 'local_interaction_draft', baseImageUrl: assetURL(input), message: '实验交互产生的痕迹草稿，可继续精修；原始实验笔触保留在本节点，尚未建立任意服装的 3D 对应关系。' });
  }
  const controls = el('div', { class: 'ns-ws-detail-tools' });
  const magnifier = attachMagnifier({ target: canvas, readSource: () => canvas, controlsHost: controls }); ws.cleanup(() => magnifier.destroy());
  redraw(); return { canvas, controls, magnifier, image, engine, strokes, events, color, add, record, redraw, save,
    clear() { strokes.length = 0; events.length = 0; ws.patch({ experimentStrokes: [], events: [] }); redraw(); },
    undo() { strokes.pop(); events.pop(); ws.patch({ experimentStrokes: strokes, events }); redraw(); } };
}

export async function gestureSimulation(container, context) {
  const ws = createWorkspace(container, context, { title: '用动作，试着做出痕迹', description: '先用鼠标或触控体验划切、擦拭和甩洒。摄像头手势入口保留，当前尚未接入识别模型。', kicker: 'GESTURE LAB · EXPERIMENT' });
  const sketch = await sketchSurface(ws, context); if (!sketch) return ws;
  const tool = field(ws, 'gestureTool', '这次用什么动作', { options: [{ value: 'slash', label: '手刀 · 拖动划切' }, { value: 'wear', label: '手掌 · 拖动擦拭' }, { value: 'blood', label: '甩洒 · 从落点朝方向拉动' }], value: ws.params.gestureTool || 'slash' });
  const force = field(ws, 'gestureForce', '痕迹强度', { type: 'range', min: .1, max: 1, step: .05, value: ws.params.gestureForce || .5, help: '这是创作强度，不是真实物理受力。' });
  let active = null, start = null;
  const point = event => { const box = sketch.canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) }; };
  ws.on(sketch.canvas, 'pointerdown', event => {
    if (event.button !== 0) return; event.preventDefault(); sketch.canvas.setPointerCapture(event.pointerId); start = point(event);
    if (tool.control.value === 'blood') return;
    const type = tool.control.value, strength = Number(force.control.value);
    active = sketch.engine.createStroke({ type, effectSubtype: type === 'slash' ? 'slit' : 'scuff', size: .02 + strength * .06, opacity: .35 + strength * .55 });
    sketch.engine.appendPoint(active, start, sketch.canvas.width, sketch.canvas.height); sketch.strokes.push(active); sketch.redraw();
  });
  ws.on(sketch.canvas, 'pointermove', event => { if (!active) return; sketch.engine.appendPoint(active, point(event), sketch.canvas.width, sketch.canvas.height); sketch.redraw(); });
  ws.on(sketch.canvas, 'pointerup', event => {
    if (!start) return; const end = point(event), strength = Number(force.control.value);
    if (tool.control.value === 'blood') { const direction = Math.atan2(end.y - start.y, end.x - start.x); sketch.add({ type: 'blood', subtype: 'splatter', points: [start, { x: start.x + (end.x - start.x) * .4, y: start.y + (end.y - start.y) * .4 }], size: .02 + Math.min(.15, Math.hypot(end.x - start.x, end.y - start.y) * .25), opacity: .4 + strength * .5, direction }); }
    sketch.record({ action: tool.control.value, start, end, strength }); start = null; active = null;
  });
  ws.on(sketch.canvas, 'pointercancel', () => { start = null; active = null; });
  ws.body.append(el('div', { class: 'ns-ws-form-grid' }, tool.group, force.group), sketch.controls, el('div', { class: 'ns-ws-canvas-wrap' }, sketch.canvas),
    actions(ws.button('撤销', () => sketch.undo()), ws.button('清空实验痕迹', () => sketch.clear()), ws.button('保存痕迹草稿', () => sketch.save(), { primary: true })),
    notice('当前是实际可用的鼠标／触控动作草稿。痕迹仍需检查衣服范围，并可到精致修改中做褶皱贴合与保护区校正。'),
    el('details', { class: 'ns-ws-details' }, el('summary', { text: '后续入口 · 摄像头手势' }), el('p', { text: '计划识别手刀、手掌和握拳动作，再复用同一份痕迹事件。当前不会申请摄像头权限。' })));
  return ws;
}

export async function battleSimulation(container, context) {
  const ws = createWorkspace(container, context, { title: '打过一场，再看看留下什么', description: '这是可操作的二维战斗草稿：移动、攻击、格挡，记录命中与防御事件。完整 3D 战斗及任意服装映射仍是后续入口。', kicker: 'BATTLE LAB · EXPERIMENT' });
  const sketch = await sketchSurface(ws, context); if (!sketch) return ws;
  const arena = el('canvas', { width: 760, height: 300, class: 'ns-ws-battle-canvas', tabindex: '0', 'aria-label': '二维战斗原型。左右键移动，J 攻击，空格格挡。也可使用下方按钮。' });
  const arenaContext = arena.getContext('2d'), score = el('p', { role: 'status', class: 'ns-ws-battle-score' });
  let player = 240, enemy = 530, hp = 100, hits = 0, blocked = 0, running = false, guardUntil = 0, flashUntil = 0, elapsed = 0, previousTime = 0, tick = 0;
  const difficulty = field(ws, 'difficulty', '对手节奏', { options: [{ value: 'easy', label: '缓慢 · 多一点准备时间' }, { value: 'normal', label: '常规' }, { value: 'hard', label: '紧凑 · 更频繁进攻' }], value: ws.params.difficulty || 'normal' });
  const keys = new Set();
  function stick(x, y, color, guarding = false) {
    arenaContext.strokeStyle = color; arenaContext.lineWidth = 4; arenaContext.lineCap = 'round'; arenaContext.beginPath(); arenaContext.arc(x, y - 64, 15, 0, Math.PI * 2); arenaContext.moveTo(x, y - 49); arenaContext.lineTo(x, y + 4); arenaContext.moveTo(x - 20, y + 38); arenaContext.lineTo(x, y + 4); arenaContext.lineTo(x + 20, y + 38); arenaContext.moveTo(x - 25, y - 20); arenaContext.lineTo(x, y - 36); arenaContext.lineTo(x + 30, guarding ? y - 62 : y - 15); arenaContext.stroke();
  }
  function draw(time = performance.now()) {
    arenaContext.fillStyle = '#e5e9e4'; arenaContext.fillRect(0, 0, 760, 300); arenaContext.strokeStyle = '#b7c3be'; arenaContext.beginPath(); arenaContext.moveTo(20, 260); arenaContext.lineTo(740, 260); arenaContext.stroke();
    stick(player, 220, time < flashUntil ? '#a95c55' : '#184f5a', time < guardUntil); stick(enemy, 220, '#666b68');
    arenaContext.fillStyle = '#184f5a'; arenaContext.font = '13px sans-serif'; arenaContext.fillText('你', player - 7, 95); arenaContext.fillText('对手', enemy - 14, 95);
    score.textContent = `体力 ${hp} · 受到攻击 ${hits} · 成功格挡 ${blocked} · 已记录 ${sketch.events.length} 个事件`;
  }
  function attack() { if (!running) return; if (Math.abs(player - enemy) < 120) { enemy = Math.min(700, enemy + 45); sketch.record({ action: 'player_hit', target: 'enemy', x: player / 760 }); } draw(); }
  function guard() { if (!running) return; guardUntil = performance.now() + 650; draw(); }
  function hit(time) {
    if (time < guardUntil) { blocked++; sketch.add({ type: 'wear', subtype: 'scuff', points: [{ x: .3 + Math.random() * .4, y: .35 + Math.random() * .15 }], size: .025, opacity: .4 }); sketch.record({ action: 'blocked', effect: 'wear' }); }
    else { hp = Math.max(0, hp - 10); hits++; flashUntil = time + 180; const start = { x: .28 + Math.random() * .4, y: .3 + Math.random() * .5 }, end = { x: Math.min(.85, start.x + .11), y: Math.min(.9, start.y + .07) }; sketch.add({ type: 'slash', subtype: 'frayed', points: [start, end], size: .025, opacity: .8 }); sketch.record({ action: 'enemy_hit', effect: 'slash', region: [start, end], mapping: 'draft_normalized_region' }); }
    if (!hp) { running = false; ws.say('这一轮结束。可以保存草稿，或重新开始。'); }
  }
  function loop(time) {
    if (!running) return; const delta = Math.min(.06, (time - previousTime) / 1000 || .016); previousTime = time;
    if (keys.has('ArrowLeft')) player -= delta * 200; if (keys.has('ArrowRight')) player += delta * 200; player = Math.max(50, Math.min(710, player));
    const direction = player < enemy ? -1 : 1; if (Math.abs(player - enemy) > 80) enemy += direction * delta * ({ easy: 60, normal: 95, hard: 130 }[difficulty.control.value] || 95);
    elapsed += delta; const interval = { easy: 2.2, normal: 1.6, hard: 1.0 }[difficulty.control.value] || 1.6;
    if (elapsed >= interval) { elapsed = 0; if (Math.abs(player - enemy) < 130) hit(time); }
    draw(time); tick = requestAnimationFrame(loop);
  }
  function start() { if (running) return; running = true; previousTime = performance.now(); tick = requestAnimationFrame(loop); arena.focus(); }
  function stop() { running = false; cancelAnimationFrame(tick); keys.clear(); draw(); }
  ws.on(arena, 'keydown', event => { if (['ArrowLeft', 'ArrowRight', ' ', 'j', 'J'].includes(event.key)) { event.preventDefault(); keys.add(event.key); if (event.key === ' ') guard(); if (event.key.toLowerCase() === 'j') attack(); } });
  ws.on(arena, 'keyup', event => keys.delete(event.key)); ws.on(arena, 'blur', () => keys.clear()); ws.cleanup(stop);
  ws.body.append(difficulty.group, el('div', { class: 'ns-ws-canvas-wrap' }, arena), score,
    actions(ws.button('开始／继续', () => start(), { primary: true }), ws.button('暂停', () => stop()), ws.button('左移', () => { player = Math.max(50, player - 45); draw(); }), ws.button('右移', () => { player = Math.min(710, player + 45); draw(); }), ws.button('攻击 J', () => attack()), ws.button('格挡 Space', () => guard())),
    el('h3', { text: '这场战斗的服装痕迹草稿' }), sketch.controls, el('div', { class: 'ns-ws-canvas-wrap' }, sketch.canvas),
    actions(ws.button('保存战斗草稿', async () => { stop(); await sketch.save(); }, { primary: true }), ws.button('重开一轮并清空草稿', () => { stop(); hp = 100; hits = 0; blocked = 0; player = 240; enemy = 530; elapsed = 0; sketch.clear(); draw(); })),
    notice('此实验按事件生成可编辑痕迹；位置是二维草稿映射，不是衣服的真实受力、破坏或 3D 碰撞模拟。摄像头、3D 模型及真实衣片对应入口将在后续接入。'));
  draw(); return ws;
}
