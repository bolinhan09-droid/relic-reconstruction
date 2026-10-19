import { createWorkspace, el, field, actions, notice, loadImage, assetURL, inputFor, uploadCanvas } from './shared.js';
import { attachMagnifier } from './magnifier.js';
import { startHandInput, stopHandInput } from './gesture-camera.js';

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
  const ws = createWorkspace(container, context, { title: '用动作，试着做出痕迹', description: '用鼠标、触控或摄像头留下划切、擦拭和甩洒。摄像头识别手部位置，捏合拇指与食指开始，松开停止。', kicker: 'GESTURE LAB' });
  const sketch = await sketchSurface(ws, context); if (!sketch) return ws;
  if (ws.signal.aborted) return ws;
  const tool = field(ws, 'gestureTool', '这次用什么动作', { options: [{ value: 'slash', label: '划切' }, { value: 'wear', label: '擦拭' }, { value: 'blood', label: '甩洒' }], value: ws.params.gestureTool || 'slash' });
  const force = field(ws, 'gestureForce', '创作强度', { type: 'range', min: .1, max: 1, step: .05, value: ws.params.gestureForce || .5, help: '控制痕迹大小与浓度，不代表真实受力。' });
  const video = el('video', { class: 'ns-ws-gesture-video', width: 640, height: 480, muted: '', playsinline: '', 'aria-label': '本机摄像头手势预览' });
  const landmarkCanvas = el('canvas', { class: 'ns-ws-gesture-landmarks', width: 640, height: 480, 'aria-hidden': 'true' });
  const cameraStatus = el('p', { class: 'ns-ws-gesture-status', role: 'status', 'aria-live': 'polite', text: '摄像头尚未开启。鼠标和触控可直接绘制。' });
  const cameraPreview = el('div', { class: 'ns-ws-gesture-preview', hidden: true }, video, landmarkCanvas);
  const cursor = el('span', { class: 'ns-ws-gesture-cursor', hidden: true, 'aria-hidden': 'true' });
  const surface = el('div', { class: 'ns-ws-canvas-wrap ns-ws-gesture-surface' }, sketch.canvas, cursor);
  const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
  let drawing = null, cameraSession = null, cameraStarting = false;
  const point = event => { const box = sketch.canvas.getBoundingClientRect(); return { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) }; };
  function sample(point, pressure, phase) {
    if (!drawing) return;
    drawing.last = { x: clamp(point.x), y: clamp(point.y) };
    const row = { ...drawing.last, pressure: clamp(pressure), phase, t: Math.round(performance.now() - drawing.started) };
    if (drawing.samples.length < 2048 || phase === 'end') drawing.samples.push(row);
    if (drawing.stroke) { sketch.engine.appendPoint(drawing.stroke, drawing.last, sketch.canvas.width, sketch.canvas.height); sketch.redraw(); }
  }
  function begin(point, source, pressure = 1, pointerId = null) {
    if (drawing) return;
    const type = tool.control.value, strength = Number(force.control.value), start = { x: clamp(point.x), y: clamp(point.y) };
    drawing = { source, type, strength, start, last: start, samples: [], started: performance.now(), stroke: null, pointerId };
    if (type !== 'blood') {
      drawing.stroke = sketch.engine.createStroke({ type, effectSubtype: type === 'slash' ? 'slit' : 'scuff', size: .02 + strength * .06, opacity: .35 + strength * .55 });
      sketch.strokes.push(drawing.stroke);
    }
    sample(start, pressure, 'start');
  }
  function finish(point = drawing?.last, pressure = 0, cancelled = false) {
    if (!drawing) return;
    sample(point, pressure, 'end');
    const action = drawing, end = action.last;
    if (action.type === 'blood' && !cancelled) {
      const direction = Math.atan2(end.y - action.start.y, end.x - action.start.x);
      sketch.add({ type: 'blood', subtype: 'splatter', points: [action.start, { x: action.start.x + (end.x - action.start.x) * .4, y: action.start.y + (end.y - action.start.y) * .4 }], size: .02 + Math.min(.15, Math.hypot(end.x - action.start.x, end.y - action.start.y) * .25), opacity: .4 + action.strength * .5, direction });
    }
    if (action.stroke || (action.type === 'blood' && !cancelled)) sketch.record({ action: action.type, source: action.source, start: action.start, end, strength: action.strength, creativeIntensity: action.strength, pressureMeaning: action.source === 'camera' ? 'pinch_tightness' : 'pointer_pressure', normalized: true, samples: action.samples, cancelled });
    drawing = null;
  }
  ws.on(sketch.canvas, 'pointerdown', event => {
    if (event.button !== 0 || drawing) return;
    event.preventDefault(); sketch.canvas.setPointerCapture(event.pointerId);
    begin(point(event), event.pointerType === 'touch' ? 'touch' : event.pointerType === 'pen' ? 'pen' : 'mouse', event.pressure || 1, event.pointerId);
  });
  ws.on(sketch.canvas, 'pointermove', event => { if (drawing?.pointerId === event.pointerId) sample(point(event), event.pressure || 1, 'move'); });
  ws.on(sketch.canvas, 'pointerup', event => { if (drawing?.pointerId === event.pointerId) finish(point(event), 0); });
  ws.on(sketch.canvas, 'pointercancel', event => { if (drawing?.pointerId === event.pointerId) finish(drawing.last, 0, true); });
  ws.on(sketch.canvas, 'lostpointercapture', event => { if (drawing?.pointerId === event.pointerId) finish(drawing.last, 0, true); });
  const cameraButton = ws.button('开启摄像头手势', async () => {
    if (cameraStarting || cameraSession) return;
    cameraStarting = true;
    try {
      const session = await startHandInput({ video, canvas: landmarkCanvas,
        onStatus({ state, message }) {
          if (ws.signal.aborted) return;
          cameraStatus.textContent = message;
          cameraStatus.dataset.state = state;
          const live = ['loading', 'ready', 'tracking'].includes(state);
          cameraPreview.hidden = !live;
          stopButton.disabled = !live;
          if (state === 'stopped' || state === 'error') { cameraSession = null; cameraStarting = false; cursor.hidden = true; if (drawing?.source === 'camera') finish(drawing.last, 0, true); }
        },
        onGesture(event) {
          if (ws.signal.aborted) return;
          cursor.hidden = !event.tracked;
          cursor.classList.toggle('is-pinching', event.pinch);
          cursor.style.left = `${sketch.canvas.offsetLeft + event.x * sketch.canvas.clientWidth}px`;
          cursor.style.top = `${sketch.canvas.offsetTop + event.y * sketch.canvas.clientHeight}px`;
          if (event.phase === 'start') begin(event, 'camera', event.pressure);
          else if (drawing?.source === 'camera' && event.phase === 'move') sample(event, event.pressure, 'move');
          else if (drawing?.source === 'camera' && event.phase === 'end') finish(event, 0, !event.tracked);
        },
      });
      if (ws.signal.aborted || ['stopped', 'error'].includes(cameraStatus.dataset.state)) session.stop();
      else cameraSession = session;
    } finally { cameraStarting = false; }
  });
  const stopButton = ws.button('关闭摄像头', () => stopHandInput(), { disabled: true });
  const cameraPanel = el('section', { class: 'ns-ws-gesture-camera', 'aria-label': '摄像头手势输入' }, actions(cameraButton, stopButton), cameraStatus, cameraPreview);
  ws.cleanup(() => { if (drawing) finish(drawing.last, 0, true); stopHandInput(); });
  ws.body.append(el('div', { class: 'ns-ws-form-grid' }, tool.group, force.group), cameraPanel, sketch.controls, surface,
    actions(ws.button('撤销', () => { finish(); sketch.undo(); }), ws.button('清空实验痕迹', () => { finish(); sketch.clear(); }), ws.button('保存痕迹草稿', async () => { finish(); await sketch.save(); }, { primary: true })),
    notice('手势识别在本机进行，不上传摄像头画面。选择划切或擦拭后捏合移动；甩洒则捏合定下落点，朝方向移动后松开。保存前检查痕迹是否落在服装范围内。'));
  return ws;
}
