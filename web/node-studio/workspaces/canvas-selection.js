import { el, loadImage, assetURL } from './shared.js';
import { attachMagnifier } from './magnifier.js';

/** Rectangles are normalized to image coordinates, never screen coordinates. */
export async function createRectangleCanvas(workspace, value, initial = [], onChange = () => {}) {
  const wrapper = el('div', { class: 'ns-ws-canvas-wrap' });
  const canvas = el('canvas', { class: 'ns-ws-selection-canvas', tabindex: '0', 'aria-label': '在图片上拖动框选区域；清除按钮可重新选择' });
  wrapper.append(canvas);
  const rectangles = structuredClone(initial || []), url = assetURL(value);
  if (!url) { wrapper.append(el('p', { text: '先连接一张服装图片。' })); return { element: wrapper, regions: () => [], clear() {}, destroy() {} }; }
  const image = await loadImage(url), scale = Math.min(1, 1100 / image.naturalWidth, 850 / image.naturalHeight);
  canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
  const drawing = canvas.getContext('2d'); let start = null, draft = null;
  const clamp = number => Math.max(0, Math.min(1, number));
  const point = event => { const box = canvas.getBoundingClientRect(); return { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) }; };
  const rect = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  function redraw() {
    drawing.clearRect(0, 0, canvas.width, canvas.height); drawing.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const [index, area] of [...rectangles, ...(draft ? [draft] : [])].entries()) {
      const x = area.x * canvas.width, y = area.y * canvas.height, w = area.w * canvas.width, h = area.h * canvas.height;
      drawing.fillStyle = 'rgba(26, 107, 119, .17)'; drawing.fillRect(x, y, w, h); drawing.lineWidth = 2; drawing.strokeStyle = '#d6ecb7'; drawing.setLineDash([7, 4]); drawing.strokeRect(x, y, w, h); drawing.setLineDash([]);
      drawing.fillStyle = '#142e34'; drawing.fillRect(x, Math.max(0, y - 23), 28, 23); drawing.fillStyle = '#fff'; drawing.font = '14px sans-serif'; drawing.fillText(String(index + 1), x + 9, Math.max(17, y - 6));
    }
  }
  workspace.on(canvas, 'pointerdown', event => { if (event.button !== 0 || rectangles.length >= 24) return; event.preventDefault(); start = point(event); draft = rect(start, start); canvas.setPointerCapture(event.pointerId); });
  workspace.on(canvas, 'pointermove', event => { if (!start) return; draft = rect(start, point(event)); redraw(); });
  workspace.on(canvas, 'pointerup', () => { if (!start) return; if (draft.w > .004 && draft.h > .004) { rectangles.push(draft); onChange(structuredClone(rectangles)); } start = null; draft = null; redraw(); });
  workspace.on(canvas, 'pointercancel', () => { start = null; draft = null; redraw(); });
  redraw();
  const controls = el('div', { class: 'ns-ws-detail-tools' });
  const lens = attachMagnifier({ target: canvas, readSource: () => canvas, controlsHost: controls });
  workspace.cleanup(() => lens.destroy());
  return { element: el('div', { class: 'ns-ws-selection-board' }, controls, wrapper), canvas, image, magnifier: lens, regions: () => structuredClone(rectangles),
    clear() { rectangles.length = 0; onChange([]); redraw(); },
    undo() { rectangles.pop(); onChange(structuredClone(rectangles)); redraw(); }, destroy() { lens.destroy(); } };
}
