import { createWorkspace, el, field, actions, notice, assetURL } from './shared.js';

const corners = [{ x: 165, y: 24 }, { x: 29, y: 258 }, { x: 301, y: 258 }];
export function triangleWeights(x, y) {
  const [a, b, c] = corners, denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  const first = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / denominator;
  const second = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / denominator;
  const raw = [first, second, 1 - first - second].map(value => Math.max(0, value)), sum = raw.reduce((a, b) => a + b, 0);
  return raw.map(value => value / sum);
}

export async function blendCreate(container, context) {
  const ws = createWorkspace(container, context, { title: '在三种想法之间，找到你的那一版', description: '放入候选，确定基准，再拖动三角控制点表达偏好。不同照片不会直接透明叠在一起。', kicker: 'BLEND EXPLORATION' });
  const ownIndex = context.workflow.order.indexOf(context.node.id);
  const earlierIds = new Set(context.workflow.order.slice(0, ownIndex < 0 ? context.workflow.order.length : ownIndex));
  const candidates = context.workflow.nodes.filter(node => node.id !== context.node.id && earlierIds.has(node.id) && assetURL(node.output)
    && !['image_reference', 'scene_context', 'production_context'].includes(node.type));
  let selected = [...(ws.params.candidateIds || [])].slice(0, 3), weights = ws.params.weights?.length === 3 ? [...ws.params.weights] : [1 / 3, 1 / 3, 1 / 3];
  const slots = el('div', { class: 'ns-ws-blend-slots' }), labels = [], selects = [], images = [];
  const candidateLabel = node => node.title || node.label || context.catalog?.nodes?.find(item => item.type === node.type || item.id === node.type)?.label || node.type;
  for (let i = 0; i < 3; i++) {
    const select = el('select', { class: 'ns-input', 'aria-label': `候选 ${String.fromCharCode(65 + i)}` }, el('option', { value: '', text: '选择已有输出' }), candidates.map(node => el('option', { value: node.id, text: candidateLabel(node) })));
    select.value = selected[i] || ''; const image = el('img', { alt: `候选 ${String.fromCharCode(65 + i)} 的输出`, hidden: true });
    const label = el('strong', { class: 'ns-ws-weight' }); labels.push(label); images.push(image); selects.push(select);
    ws.on(select, 'change', () => { selected[i] = select.value; ws.patch({ candidateIds: selected.filter(Boolean) }); refresh(); });
    slots.append(el('section', { class: 'ns-ws-blend-slot' }, el('h3', { text: `候选 ${String.fromCharCode(65 + i)}` }), image, select, label));
  }
  const triangle = el('div', { class: 'ns-ws-triangle', tabindex: '0', role: 'application', 'aria-label': '三角融合控制器。拖动控制点或使用方向键调整候选比例。' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 330 290'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', 'M165 24L29 258H301Z'); path.setAttribute('class', 'ns-ws-triangle-face'); svg.append(path);
  for (let i = 0; i < 3; i++) { const text = document.createElementNS(svg.namespaceURI, 'text'); text.setAttribute('x', corners[i].x); text.setAttribute('y', i ? 283 : 15); text.setAttribute('text-anchor', 'middle'); text.textContent = String.fromCharCode(65 + i); svg.append(text); }
  const dot = document.createElementNS(svg.namespaceURI, 'circle'); dot.setAttribute('r', '10'); dot.setAttribute('class', 'ns-ws-triangle-handle'); svg.append(dot); triangle.append(svg);
  const base = field(ws, 'baseNodeId', '以哪一版为服装基准', { options: [{ value: '', label: '选择基准方案' }, ...candidates.map(node => ({ value: node.id, label: candidateLabel(node) }))] });
  const scope = field(ws, 'effectScope', '想融合什么', { options: [{ value: 'all', label: '整体效果' }, { value: 'blood', label: '血迹分布' }, { value: 'wear', label: '磨损与破损' }], value: ws.params.effectScope || 'all' });
  const basePreview = el('div', { class: 'ns-ws-base-preview' });
  function refresh() {
    const percentages = weights.map(value => Math.floor(value * 100)); let remaining = 100 - percentages.reduce((a, b) => a + b, 0); for (const { index } of weights.map((value, index) => ({ index, decimal: value * 100 - percentages[index] })).sort((a, b) => b.decimal - a.decimal)) { if (remaining-- > 0) percentages[index]++; }
    weights.forEach((value, i) => { labels[i].textContent = `${percentages[i]}%`; const candidate = candidates.find(node => node.id === selected[i]); images[i].hidden = !candidate; if (candidate) images[i].src = assetURL(candidate.output); });
    const x = weights.reduce((sum, weight, i) => sum + weight * corners[i].x, 0), y = weights.reduce((sum, weight, i) => sum + weight * corners[i].y, 0); dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    triangle.setAttribute('aria-label', `融合偏好 A ${percentages[0]}%，B ${percentages[1]}%，C ${percentages[2]}%。方向键调整。`);
    basePreview.replaceChildren(); const chosen = candidates.find(node => node.id === base.control.value); if (chosen) basePreview.append(el('img', { src: assetURL(chosen.output), alt: '当前服装基准，尚未生成融合效果' }), el('p', { text: '当前基准 · 拖动只调整设计偏好，未调用模型' }));
  }
  function updateFromPoint(event) { const box = svg.getBoundingClientRect(); weights = triangleWeights((event.clientX - box.left) / box.width * 330, (event.clientY - box.top) / box.height * 290); ws.patch({ weights }); refresh(); }
  let dragging = false;
  ws.on(triangle, 'pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); dragging = true; triangle.setPointerCapture(event.pointerId); updateFromPoint(event); });
  ws.on(triangle, 'pointermove', event => { if (dragging) updateFromPoint(event); }); ws.on(triangle, 'pointerup', () => dragging = false); ws.on(triangle, 'pointercancel', () => dragging = false);
  ws.on(triangle, 'keydown', event => { const delta = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] }[event.key]; if (!delta) return; event.preventDefault(); const x = weights.reduce((sum, value, i) => sum + value * corners[i].x, 0), y = weights.reduce((sum, value, i) => sum + value * corners[i].y, 0); weights = triangleWeights(x + delta[0], y + delta[1]); ws.patch({ weights }); refresh(); });
  ws.on(base.control, 'change', refresh);
  ws.body.append(slots, el('div', { class: 'ns-ws-blend-controls' }, triangle, el('div', {}, base.group, scope.group)), basePreview,
    notice('候选来自当前节点之前的图片输出，可以先把融合节点移到候选后面。拖动表达设计偏好，不直接透明叠图；后续在图像生成节点执行。'),
    actions(ws.button('准备融合生成任务', async () => {
      const ids = selected.filter(Boolean); if (ids.length < 2 || new Set(ids).size !== ids.length) throw new Error('请选择至少两个不同的候选方案。');
      if (!base.control.value) throw new Error('先选一版服装基准。');
      const usedWeights = selected.map((id, i) => id ? weights[i] : 0).filter((_, i) => selected[i]); const sum = usedWeights.reduce((a, b) => a + b, 0);
      if (sum <= 0) throw new Error('所选候选的权重不能全为零。');
      ws.patch({ candidateIds: ids, weights: usedWeights.map(weight => weight / sum), baseNodeId: base.control.value, effectScope: scope.control.value }); await ws.run();
    }, { primary: true })));
  refresh(); return ws;
}
