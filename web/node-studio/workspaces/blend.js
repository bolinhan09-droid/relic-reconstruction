import { createWorkspace, el, field, actions, notice, assetURL, inputFor } from './shared.js';
import { collectMergeCandidates, precedingNodeIds } from '../core/model.js';
import { blendPreview } from './blend-preview.js';

const corners = [{ x: 165, y: 24 }, { x: 29, y: 258 }, { x: 301, y: 258 }];
export function triangleWeights(x, y) {
  const [a, b, c] = corners, denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  const first = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / denominator;
  const second = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / denominator;
  const raw = [first, second, 1 - first - second].map(value => Math.max(0, value)), sum = raw.reduce((a, b) => a + b, 0);
  return raw.map(value => value / sum);
}

function availableCandidates(context) {
  const workflow = context.getWorkflow?.() || context.workflow, input = inputFor(context);
  if (input.kind === 'candidate_set') return { merged: true, candidates: collectMergeCandidates(workflow, context.node.id).filter(candidate => assetURL(candidate.output || candidate)) };
  const earlierIds = new Set(precedingNodeIds(workflow, context.node.id));
  return { merged: false, candidates: workflow.nodes.filter(node => node.id !== context.node.id && earlierIds.has(node.id) && assetURL(node.output)
    && !['image_reference', 'scene_context', 'production_context'].includes(node.type)).map(node => ({ ...node, nodeId: node.id, label: node.title || node.label || context.catalog?.nodes?.find(item => item.type === node.type || item.id === node.type)?.label || node.type })) };
}

export async function blendCreate(container, context) {
  const ws = createWorkspace(container, context, { title: '融合创作', description: '选择喜欢的方案与特征，调整比例查看效果。同底图的可编辑痕迹可以直接采用。' });
  const { merged, candidates } = availableCandidates(context);
  const candidateLabel = value => value?.branchLabel || value?.label || value?.title || value?.id || '未选择';
  const initialIDs = Array.isArray(ws.params.candidateIds) ? ws.params.candidateIds : [];
  let selected = initialIDs.filter(id => candidates.some(candidate => candidate.id === id)).slice(0, 3);
  const didAutofill = !initialIDs.length && merged && candidates.length >= 2 && candidates.length <= 3;
  if (didAutofill) selected = candidates.map(candidate => candidate.id);
  while (selected.length < 3) selected.push('');
  const weights = [0, 0, 0], storedWeights = Array.isArray(ws.params.weights) ? ws.params.weights : [];
  for (let i = 0; i < 3; i++) if (selected[i]) weights[i] = Number.isFinite(Number(storedWeights[i])) ? Math.max(0, Number(storedWeights[i])) : 1;
  function normalize() {
    const count = selected.filter(Boolean).length, sum = weights.reduce((total, value, i) => total + (selected[i] ? value : 0), 0);
    for (let i = 0; i < 3; i++) weights[i] = selected[i] ? sum ? weights[i] / sum : 1 / count : 0;
  }
  normalize();
  const persistChoice = () => ws.patch({ candidateIds: selected.filter(Boolean), weights: weights.filter((_, index) => selected[index]), baseNodeId: base.control.value });
  const slots = el('div', { class: 'ns-ws-blend-slots' }), labels = [], selects = [], images = [];
  const selectionMessage = notice(merged
    ? candidates.length > 3 ? `已读取汇合的 ${candidates.length} 个方案。请明确选择其中两至三个参与本轮融合，其余方案仍然保留。` : `已读取汇合的 ${candidates.length} 个方案，可直接调整设计比例。`
    : '候选来自这一步之前已采用的图片。也可以先添加分支与汇合，把独立方案收集到这里。');
  for (let i = 0; i < 3; i++) {
    const letter = String.fromCharCode(65 + i);
    const select = el('select', { class: 'ns-input', 'aria-label': `候选 ${letter}` }, el('option', { value: '', text: i < 2 ? '选择方案' : '第三个方案 · 可选' }), candidates.map(candidate => el('option', { value: candidate.id, text: candidateLabel(candidate) })));
    select.value = selected[i] || '';
    const image = el('img', { alt: `候选 ${letter} 的输出`, hidden: true });
    const label = el('strong', { class: 'ns-ws-weight' }); labels.push(label); images.push(image); selects.push(select);
    const card = el('section', { class: 'ns-ws-blend-slot' }, el('div', { class: 'ns-ws-blend-slot-heading' }, el('h3', { text: `方案 ${letter}` }), label), image, select);
    if (i === 2 && candidates.length === 2) card.hidden = true;
    ws.on(select, 'change', () => {
      const had = Boolean(selected[i]); selected[i] = select.value;
      if (!had && selected[i]) weights[i] = .3;
      normalize(); refresh(); persistChoice();
    });
    slots.append(card);
  }
  slots.classList.toggle('has-two', candidates.length === 2);
  const triangle = el('div', { class: 'ns-ws-triangle', tabindex: '0', role: 'application', 'aria-label': '三角融合控制器。拖动控制点或使用方向键调整候选比例。' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 330 290'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', 'M165 24L29 258H301Z'); path.setAttribute('class', 'ns-ws-triangle-face'); svg.append(path);
  for (let i = 0; i < 3; i++) { const text = document.createElementNS(svg.namespaceURI, 'text'); text.setAttribute('x', corners[i].x); text.setAttribute('y', i ? 283 : 15); text.setAttribute('text-anchor', 'middle'); text.textContent = String.fromCharCode(65 + i); svg.append(text); }
  const dot = document.createElementNS(svg.namespaceURI, 'circle'); dot.setAttribute('r', '10'); dot.setAttribute('class', 'ns-ws-triangle-handle'); svg.append(dot); triangle.append(svg);
  const ratio = el('input', { type: 'range', min: 0, max: 100, step: 1, value: 50, 'aria-label': '两个方案的融合比例' });
  const ratioEnds = el('div', { class: 'ns-ws-ratio-labels' });
  const ratioPanel = el('div', { class: 'ns-ws-ratio' }, el('h3', { text: '偏向哪一个方案？' }), ratioEnds, ratio, el('p', { text: '拖向哪一侧，就更多保留那一版的特征。' }));
  const emptyControl = notice('先选择两个不同的方案，即可调整融合偏好。');
  const controller = el('div', { class: 'ns-ws-blend-controller' }, triangle, ratioPanel, emptyControl);
  const base = field(ws, 'baseNodeId', '保留哪版衣服的结构', { options: [{ value: '', label: '选择服装基准' }, ...candidates.map(candidate => ({ value: candidate.id, label: candidateLabel(candidate) }))], value: ws.params.baseNodeId || selected.find(Boolean) || '' });
  const scope = field(ws, 'effectScope', '融合范围', { options: [{ value: 'all', label: '整体效果' }, { value: 'blood', label: '血迹分布' }, { value: 'wear', label: '磨损与破损' }], value: ws.params.effectScope || 'all' });
  const live = blendPreview(ws, context, candidates);
  const featureSources = { ...(ws.params.featureSources || {}) };
  const features = el('details', { class: 'ns-ws-details' }, el('summary', { text: '分别保留喜欢的特征' }));
  const featureControls = [];
  for (const [type, label] of [['blood', '血迹'], ['slash', '刀痕'], ['wear', '磨损'], ['burn', '焦痕']]) {
    const control = field(ws, `_feature_${type}`, label, { persist: false, value: featureSources[type] || '', options: [{ value: '', label: '跟随整体比例' }, ...candidates.map(candidate => ({ value: candidate.id, label: candidateLabel(candidate) }))] });
    featureControls.push(control.control); features.append(control.group);
    ws.on(control.control, 'change', () => { featureSources[type] = control.control.value; ws.patch({ featureSources: { ...featureSources } }); refresh(); });
  }
  function refresh() {
    const active = selected.map((id, i) => id ? i : -1).filter(i => i >= 0);
    const percentages = weights.map(value => Math.floor(value * 100));
    let remaining = active.length ? 100 - percentages.reduce((a, b) => a + b, 0) : 0;
    for (const { index } of active.map(index => ({ index, decimal: weights[index] * 100 - percentages[index] })).sort((a, b) => b.decimal - a.decimal)) if (remaining-- > 0) percentages[index]++;
    weights.forEach((value, i) => {
      labels[i].textContent = selected[i] ? `${percentages[i]}%` : '—';
      const candidate = candidates.find(item => item.id === selected[i]); images[i].hidden = !candidate;
      if (candidate) images[i].src = assetURL(candidate.output || candidate); else images[i].removeAttribute('src');
    });
    const x = weights.reduce((sum, weight, i) => sum + weight * corners[i].x, 0), y = weights.reduce((sum, weight, i) => sum + weight * corners[i].y, 0); dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    triangle.hidden = active.length !== 3; ratioPanel.hidden = active.length !== 2; emptyControl.hidden = active.length >= 2;
    triangle.setAttribute('aria-label', `融合偏好 A ${percentages[0]}%，B ${percentages[1]}%，C ${percentages[2]}%。方向键调整。`);
    if (active.length === 2) {
      ratio.value = Math.round(weights[active[1]] * 100);
      ratioEnds.replaceChildren(...active.map(i => el('span', { text: `${candidateLabel(candidates.find(candidate => candidate.id === selected[i]))} ${percentages[i]}%` })));
      ratio.setAttribute('aria-valuetext', active.map(i => `方案 ${String.fromCharCode(65 + i)} ${percentages[i]}%`).join('，'));
    }
    if (!selected.includes(base.control.value)) base.control.value = selected.find(Boolean) || '';
    for (const option of base.control.options) if (option.value) option.disabled = !selected.includes(option.value);
    for (const control of featureControls) for (const option of control.options) if (option.value) option.disabled = !selected.includes(option.value);
    for (const key of Object.keys(featureSources)) if (featureSources[key] && !selected.includes(featureSources[key])) { delete featureSources[key]; ws.patch({ featureSources: { ...featureSources } }); }
    live.update({ ids: selected.filter(Boolean), weights: weights.filter((_, i) => selected[i]), baseId: base.control.value, scope: scope.control.value, featureSources });
  }
  ws.on(ratio, 'input', () => {
    const active = selected.map((id, i) => id ? i : -1).filter(i => i >= 0); if (active.length !== 2) return;
    weights.fill(0); weights[active[1]] = Number(ratio.value) / 100; weights[active[0]] = 1 - weights[active[1]]; persistChoice(); refresh();
  });
  function setPoint(x, y) { const next = triangleWeights(x, y); next.forEach((value, i) => weights[i] = value); persistChoice(); refresh(); }
  function updateFromPoint(event) { const box = svg.getBoundingClientRect(); setPoint((event.clientX - box.left) / box.width * 330, (event.clientY - box.top) / box.height * 290); }
  let dragging = false;
  ws.on(triangle, 'pointerdown', event => { if (event.button !== 0 || selected.filter(Boolean).length !== 3) return; event.preventDefault(); dragging = true; triangle.setPointerCapture(event.pointerId); updateFromPoint(event); });
  ws.on(triangle, 'pointermove', event => { if (dragging) updateFromPoint(event); }); ws.on(triangle, 'pointerup', () => dragging = false); ws.on(triangle, 'pointercancel', () => dragging = false);
  ws.on(triangle, 'keydown', event => { const delta = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] }[event.key]; if (!delta) return; event.preventDefault(); setPoint(weights.reduce((sum, value, i) => sum + value * corners[i].x, 0) + delta[0], weights.reduce((sum, value, i) => sum + value * corners[i].y, 0) + delta[1]); });
  ws.on(base.control, 'change', refresh);
  ws.on(scope.control, 'change', refresh);
  const prepare = ws.button('准备融合生成任务', async () => {
    const ids = selected.filter(Boolean); if (ids.length < 2 || new Set(ids).size !== ids.length) throw new Error('请选择至少两个不同的候选方案。');
    if (!base.control.value || !ids.includes(base.control.value)) throw new Error('请从参与融合的方案中选择服装基准。');
    normalize(); persistChoice(); await ws.run();
  }, { primary: true });
  const adopt = ws.button('采用实时笔触融合', async () => {
    if (!live.supported()) throw Error('实时融合需要来自同一张底图的可编辑笔触；当前方案请使用图像融合。');
    const ids = selected.filter(Boolean); if (new Set(ids).size !== ids.length) throw Error('请选择不同方案。');
    normalize(); persistChoice(); await ws.run({ blendAction: 'editable' });
  });
  const choices = el('details', { class: 'ns-ws-details ns-blend-candidate-picker' }, el('summary', { text: '选择参与融合的方案' }), slots);
  choices.open = selected.filter(Boolean).length < 2;
  ws.body.append(selectionMessage, choices, el('div', { class: 'ns-ws-blend-bench' },
    el('section', { class: 'ns-ws-blend-control-stage' }, live.element),
    el('aside', { class: 'ns-ws-inspector' }, controller, base.group, scope.group, features, actions(adopt, prepare), notice('同底图笔触可实时融合。其他图像通过生成任务融合，连接图像生成并点击后才调用模型。'))));
  refresh();
  if (didAutofill) { persistChoice(); await ws.save(); ws.say('已从汇合读取方案，并保存初始融合比例。'); }
  return ws;
}
