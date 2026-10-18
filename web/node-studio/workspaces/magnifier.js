/** Non-destructive detail lens. Reads the current canvas; never paints back into it. */
const DEFAULT_ZOOMS = Object.freeze([2, 3, 4]);
const typing = element => element instanceof Element && Boolean(element.closest('input,textarea,select,[contenteditable="true"]'));
const clamp = (number, min, max) => Math.min(max, Math.max(min, number));

function stylesheet() {
  const url = new URL('./magnifier.css', import.meta.url).href;
  if (document.querySelector('link[data-relic-magnifier-style]')) return;
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = url; link.dataset.relicMagnifierStyle = 'true'; document.head.append(link);
}

export function lensPosition(pointer, size, viewport, offset = 28) {
  const inset = 8;
  const left = pointer.x + offset + size.width <= viewport.width - inset ? pointer.x + offset : pointer.x - size.width - offset;
  const top = pointer.y + offset + size.height <= viewport.height - inset ? pointer.y + offset : pointer.y - size.height - offset;
  return { left: clamp(left, inset, Math.max(inset, viewport.width - size.width - inset)), top: clamp(top, inset, Math.max(inset, viewport.height - size.height - inset)) };
}

/**
 * @param {{target:HTMLElement,readSource:()=>CanvasImageSource|null,host?:HTMLElement,controlsHost?:HTMLElement,zoom?:number,size?:number,onState?:(state:object)=>void}} options
 * @returns {{setAutomaticActive:(value:boolean)=>void,setEnabled:(value:boolean)=>void,setZoom:(value:number)=>void,getState:()=>object,destroy:()=>void,element:HTMLElement,controls:HTMLElement}}
 */
export function attachMagnifier({ target, readSource = () => target, host = document.body, controlsHost, zoom = 3, size = 190, onState = () => {} } = {}) {
  if (!(target instanceof HTMLElement) || typeof readSource !== 'function') throw new TypeError('放大镜需要一个真实画布与同步取图函数。');
  stylesheet();
  const lifetime = new AbortController(), state = { enabled: true, pinned: false, held: false, automatic: false, hovered: false, visible: false, zoom: DEFAULT_ZOOMS.includes(Number(zoom)) ? Number(zoom) : 3 };
  let destroyed = false, frame = 0, lastDraw = 0, lastPoint = null, sourceError = false;
  const lens = document.createElement('div'); lens.className = 'ns-detail-lens'; lens.hidden = true; lens.setAttribute('aria-hidden', 'true'); lens.dataset.magnifierOverlay = 'true';
  const canvas = document.createElement('canvas'); canvas.className = 'ns-detail-lens-image';
  const caption = document.createElement('span'); caption.className = 'ns-detail-lens-caption';
  lens.append(canvas, caption); host.append(lens);
  const context = canvas.getContext('2d', { alpha: false });
  const controls = document.createElement('div'); controls.className = 'ns-magnifier-controls'; controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', '细节放大镜');
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'ns-magnifier-toggle'; toggle.textContent = '细节放大镜'; toggle.title = '点击保持开启；也可在画布上按住 M 临时查看'; toggle.setAttribute('aria-pressed', 'false');
  const select = document.createElement('select'); select.className = 'ns-magnifier-zoom'; select.setAttribute('aria-label', '细节放大镜倍率');
  for (const level of DEFAULT_ZOOMS) { const option = document.createElement('option'); option.value = String(level); option.textContent = `${level}×`; select.append(option); } select.value = String(state.zoom);
  const hint = document.createElement('span'); hint.className = 'ns-magnifier-hint'; hint.textContent = '按住 M';
  controls.append(toggle, select, hint); controlsHost?.append(controls);
  const on = (node, event, handler, options = {}) => node.addEventListener(event, handler, { ...options, signal: lifetime.signal });
  function snapshot() { return { ...state, sourceError }; }
  function announce() { toggle.setAttribute('aria-pressed', String(state.enabled && (state.pinned || state.automatic))); toggle.classList.toggle('is-active', state.enabled && (state.pinned || state.automatic)); select.value = String(state.zoom); onState(snapshot()); }
  function hide() { state.visible = false; lens.hidden = true; if (frame) cancelAnimationFrame(frame); frame = 0; }
  function shouldShow() { return !destroyed && state.enabled && state.hovered && (state.pinned || state.held || state.automatic) && lastPoint && !document.hidden; }
  function update() {
    if (!shouldShow()) { hide(); announce(); return; }
    state.visible = true; lens.hidden = false; if (!frame) frame = requestAnimationFrame(draw); announce();
  }
  function draw(time) {
    frame = 0;
    if (!shouldShow()) { hide(); return; }
    if (time - lastDraw < 32) { frame = requestAnimationFrame(draw); return; } lastDraw = time;
    const box = target.getBoundingClientRect();
    if (box.width < 1 || box.height < 1 || !target.isConnected || target.hidden) { hide(); return; }
    const displaySize = Math.round(Math.min(size, Math.max(90, innerWidth - 32), Math.max(90, innerHeight - 56)));
    const ratio = Math.min(2, window.devicePixelRatio || 1), pixels = Math.round(displaySize * ratio);
    if (canvas.width !== pixels) { canvas.width = pixels; canvas.height = pixels; }
    lens.style.width = displaySize + 'px'; lens.style.height = displaySize + 25 + 'px';
    const position = lensPosition(lastPoint, { width: displaySize, height: displaySize + 25 }, { width: innerWidth, height: innerHeight });
    lens.style.left = position.left + 'px'; lens.style.top = position.top + 'px';
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.fillStyle = '#e4e9e3'; context.fillRect(0, 0, displaySize, displaySize);
    let source;
    try { source = readSource(); } catch { source = null; }
    const width = source?.naturalWidth || source?.videoWidth || source?.width || 0, height = source?.naturalHeight || source?.videoHeight || source?.height || 0;
    if (width > 0 && height > 0) {
      const centerX = clamp((lastPoint.x - box.left) / box.width, 0, 1) * width, centerY = clamp((lastPoint.y - box.top) / box.height, 0, 1) * height;
      const cropWidth = displaySize / state.zoom * width / box.width, cropHeight = displaySize / state.zoom * height / box.height;
      try { context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high'; context.drawImage(source, centerX - cropWidth / 2, centerY - cropHeight / 2, cropWidth, cropHeight, 0, 0, displaySize, displaySize); sourceError = false; }
      catch { sourceError = true; }
    } else sourceError = true;
    const middle = displaySize / 2;
    context.strokeStyle = '#fafcf7'; context.lineWidth = 3; context.beginPath(); context.moveTo(middle - 8, middle); context.lineTo(middle + 8, middle); context.moveTo(middle, middle - 8); context.lineTo(middle, middle + 8); context.stroke();
    context.strokeStyle = '#225868'; context.lineWidth = 1; context.stroke();
    caption.textContent = sourceError ? '暂时无法读取画布' : `${state.zoom}× · 当前绘制效果`;
    lens.dataset.zoom = String(state.zoom); lens.dataset.sourceReady = String(!sourceError);
    frame = requestAnimationFrame(draw);
  }
  function point(event) { lastPoint = { x: event.clientX, y: event.clientY }; }
  on(target, 'pointerenter', event => { if (event.pointerType === 'touch') return; state.hovered = true; point(event); update(); });
  on(target, 'pointermove', event => { if (event.pointerType === 'touch') return; const box = target.getBoundingClientRect(); state.hovered = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom; point(event); update(); });
  on(target, 'pointerleave', () => { state.hovered = false; update(); });
  on(target, 'pointercancel', () => { state.hovered = false; state.held = false; update(); });
  on(toggle, 'click', () => { if (state.enabled && (state.pinned || state.automatic)) setEnabled(false); else { state.enabled = true; state.pinned = true; update(); } });
  on(select, 'change', () => setZoom(Number(select.value)));
  on(document, 'keydown', event => {
    if (typing(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === 'KeyM' && (state.hovered || target === document.activeElement)) { if (event.repeat) return; state.enabled = true; state.held = true; event.preventDefault(); update(); }
    else if (state.visible && ['Equal', 'NumpadAdd', 'Minus', 'NumpadSubtract'].includes(event.code)) { event.preventDefault(); const index = DEFAULT_ZOOMS.indexOf(state.zoom), forward = ['Equal', 'NumpadAdd'].includes(event.code); setZoom(DEFAULT_ZOOMS[clamp(index + (forward ? 1 : -1), 0, DEFAULT_ZOOMS.length - 1)]); }
  });
  on(document, 'keyup', event => { if (event.code === 'KeyM') { state.held = false; update(); } });
  on(window, 'blur', () => { state.held = false; state.hovered = false; update(); });
  on(document, 'visibilitychange', () => { if (document.hidden) { state.held = false; state.hovered = false; update(); } });
  function setEnabled(value) { state.enabled = Boolean(value); if (!state.enabled) { state.pinned = false; state.held = false; state.automatic = false; } update(); }
  function setAutomaticActive(value) { state.automatic = Boolean(value); update(); }
  function setZoom(value) { if (DEFAULT_ZOOMS.includes(Number(value))) state.zoom = Number(value); update(); }
  const api = { element: lens, controls, setAutomaticActive, setEnabled, setZoom, getState: snapshot,
    destroy() { if (destroyed) return; destroyed = true; lifetime.abort(); hide(); controls.remove(); lens.remove(); } };
  announce(); return api;
}
