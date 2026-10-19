import { el, assetURL, loadImage } from './shared.js';

let enginePromise;
const canonical = value => JSON.stringify(value, function(key, item) {
  if (item && !Array.isArray(item) && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]]));
  return item;
});
const surfaceKey = project => { const options = { ...(project.surfaceOptions || {}) }; delete options.backgroundVisible; return canonical(options); };
export function loadBrushEngine() {
  if (window.BattleBrushEngine) return Promise.resolve(window.BattleBrushEngine);
  if (!enginePromise) enginePromise = new Promise((resolve, reject) => {
    const script = el('script', { src: '/brush-engine.js' });
    script.onload = () => resolve(window.BattleBrushEngine);
    script.onerror = () => { enginePromise = null; reject(Error('本机笔刷引擎未加载。')); }; document.head.append(script);
  });
  return enginePromise;
}

export function blendPreview(ws, context, candidates) {
  const canvas = el('canvas', { class: 'ns-blend-live-canvas', 'aria-label': '融合效果实时预览' });
  const caption = el('p', { class: 'ns-ws-notice' });
  const element = el('section', { class: 'ns-blend-live' }, el('h3', { text: '融合预览' }), canvas, caption);
  const cache = new Map(), imageCache = new Map(); let ticket = 0, supported = false;
  const imageFor = url => { if (!imageCache.has(url)) imageCache.set(url, loadImage(url).catch(error => { imageCache.delete(url); throw error; })); return imageCache.get(url); };
  async function candidateData(id) {
    if (!cache.has(id)) cache.set(id, (async () => {
      const candidate = candidates.find(item => item.id === id), output = candidate?.output || candidate;
      const project = output?.projectSnapshot || (output?.projectId ? await context.api('GET', `/api/projects/${encodeURIComponent(output.projectId)}`) : null);
      const reference = project?.reference || output?.reference;
      return { output, project, url: assetURL(reference), editable: !!project && output?.rasterized !== true && output?.editableStrokes !== false && output?.imageSemantics !== 'raster_base' };
    })());
    return cache.get(id);
  }
  async function update({ ids, weights, baseId, scope, featureSources }) {
    const current = ++ticket; supported = false;
    if (!ids.length) { caption.textContent = '选择两至三个方案，调整整体比例与局部来源。'; return; }
    try {
      const values = await Promise.all(ids.map(candidateData)); if (current !== ticket || ws.signal.aborted) return;
      const baseIndex = Math.max(0, ids.indexOf(baseId)), base = values[baseIndex];
      supported = values.length >= 2 && values.every(value => value.editable && value.url && value.url === base.url && !value.project.damageItems?.length && !(value.project.brushStrokes || []).some(stroke => stroke.type === 'erase') && surfaceKey(value.project) === surfaceKey(base.project) && value.project.surfaceOptions?.enabled !== true);
      const image = await imageFor(supported ? base.url : assetURL(base.output));
      if (current !== ticket || ws.signal.aborted) return;
      const scale = Math.min(1, 850 / image.width, 750 / image.height); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
      const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      if (!supported) { caption.textContent = values.some(value => value.project?.surfaceOptions?.enabled)
        ? '当前方案带有表面适配层，暂不支持浏览器实时笔触混合。这里显示结构基准，可以准备图像融合任务。'
        : '当前显示服装结构基准。不同底图或整张生成图需要图像模型融合；拖动只调整设计偏好，不制造重影。'; return; }
      const engine = await loadBrushEngine(); if (current !== ticket || ws.signal.aborted) return;
      const included = scope === 'blood' ? ['blood'] : scope === 'wear' ? ['wear', 'slash', 'burn'] : ['blood', 'wear', 'slash', 'burn'];
      const merged = new Map();
      values.forEach((value, index) => {
        const occurrences = new Map();
        for (const stroke of value.output.brushStrokes || value.project.brushStrokes || []) {
          const content = { ...stroke }; delete content.id;
          const fingerprint = canonical(content), ordinal = occurrences.get(fingerprint) || 0;
          occurrences.set(fingerprint, ordinal + 1);
          const weight = !included.includes(stroke.type) ? index === baseIndex ? 1 : 0 : featureSources?.[stroke.type] ? featureSources[stroke.type] === ids[index] ? 1 : 0 : weights[index];
          if (!(weight > 0)) continue;
          const key = fingerprint + ':' + ordinal, existing = merged.get(key);
          if (existing) existing.weight = Math.min(1, existing.weight + weight);
          else merged.set(key, { stroke, weight: Math.min(1, weight) });
        }
      });
      const strokes = [...merged.values()].map(({ stroke, weight }) => {
        const copy = structuredClone(stroke); copy.opacity = stroke.opacity * weight;
        for (const shape of copy.shapes || []) shape.alpha *= weight;
        return copy;
      });
      const overlay = document.createElement('canvas'); overlay.width = canvas.width; overlay.height = canvas.height;
      engine.draw(overlay, strokes, { protectedRects: values.flatMap(value => value.project.protectedRects || []) }); ctx.drawImage(overlay, 0, 0);
      caption.textContent = '实时混合可编辑痕迹 · 无图像接口调用。最终采用会用完整分辨率重新渲染。';
    } catch (error) { if (!ws.signal.aborted) caption.textContent = error.message; supported = false; }
  }
  return { element, update, supported: () => supported };
}
