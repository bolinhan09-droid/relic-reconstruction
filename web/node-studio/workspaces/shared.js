/** Small DOM and lifecycle helpers shared by independently mounted workspaces. */
import { precedingNodeIds, hostFor } from '../core/graph.js';

const workspaceHints = {
  garment_input: '上传正面照片，背面和平铺照可稍后补充',
  image_reference: '选一张作为输入，也可从参考图开始独立创作',
  scene_context: '让 AI 查角色资料，再选择场景',
  production_context: '选大致材质，不确定也可以继续',
  quick_create: '描述效果，再到图像生成里出图',
  image_generate: '生成后直接更新画布，旧结果可从版本入口切回',
  image_generation: '生成后直接更新画布，旧结果可从版本入口切回',
  region_generate: '框选位置，再描述变化',
  precision_edit: '选择笔刷，在衣服上绘制',
  garment_split: '点选保留和排除区域，提取衣片',
  garment_flatten: '四点校正，或生成平铺参考',
  flatten_map: '上传真实平铺照，确认对应位置',
  blend_create: '调整比例，或分别保留喜欢的痕迹',
  branch_create: '从同一个起点探索不同方案',
  branch_merge: '收集各路线结果，再选择或融合',
  production_guide: '整理制作步骤，先做材料小样',
  stencil_export: '接入已映射的平铺衣片，确认尺寸后生成模板与制作说明',
  gesture_create: '捏合起笔，松开收笔',
  battle_simulation: '旋转观察，切换挥砍，查看命中',
  agent_execute: '说出想改的地方，结果直接更新，可切回旧版',
  design_review: '对照前后效果，检查需要调整的地方',
  design_advice: '告诉 AI 你的想法，一起讨论',
  intent_assist: '说出想法，整理创作方向',
  character_research: '识别角色，选定场景'
};

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = /^h[1-6]$/i.test(tag) ? String(value).replace(/[。.]+\s*$/, '') : String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'multiple') node[key] = Boolean(value);
    else if (key === 'value') node.value = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function assetURL(value) {
  const raw = typeof value === 'string' ? value : value?.imageUrl || value?.url || value?.front?.url || value?.asset?.url;
  if (!raw) return '';
  try {
    const url = new URL(raw, location.href);
    return url.origin === location.origin && /^\/(?:data|resources|api)\//.test(url.pathname) ? url.pathname + url.search : '';
  } catch { return ''; }
}

export function inputFor(context) { return context.getInput?.() || {}; }
/** Resolve setup only within this route; unrelated image islands stay independent. */
export function scopedNodes(context) {
  const workflow = context.getWorkflow?.() || context.workflow;
  if (!workflow?.nodes || !context.node) return [];
  const host = hostFor(workflow, context.node.id);
  const ids = new Set([...precedingNodeIds(workflow, context.node.id), context.node.id, ...(host ? [host.id] : [])]);
  const visit = id => {
    const node = workflow.nodes.find(item => item.id === id);
    for (const child of Object.values(node?.attachments || {}).flat()) {
      if (!ids.has(child)) { ids.add(child); visit(child); }
    }
  };
  [...ids].forEach(visit);
  return workflow.nodes.filter(node => ids.has(node.id));
}
export function currentOutput(context, result) {
  return result?.workflow?.nodes?.find(node => node.id === context.node.id)?.output || result?.output || context.node.output || {};
}

export function createWorkspace(container, context, options = {}) {
  const lifetime = new AbortController(), params = structuredClone(context.node.params || {}), cleanups = [];
  let disposed = false;
  const root = el('article', { class: 'ns-node-workspace', dataset: { workspace: context.node.type }, 'aria-label': context.definition?.label || options.title || '节点工作区' });
  const description = options.description || context.definition?.description || '';
  const hint = workspaceHints[context.node.type] || '调整后保存，双击其他标签继续创作';
  const intro = el('div', { class: 'ns-ws-intro' });
  const help = el('details', { class: context.headerActions ? 'ns-ws-header-help' : 'ns-ws-help' },
    el('summary', { text: '操作说明' }), el('div', { class: 'ns-ws-help-content' },
      el('p', { text: hint }), description && description !== hint ? el('p', { text: description }) : null));
  if (context.headerActions) { context.headerActions.append(help); cleanups.push(() => help.remove()); }
  else intro.append(el('p', { class: 'ns-ws-description', text: hint }), help);
  const body = el('div', { class: 'ns-ws-body' });
  const status = el('p', { class: 'ns-ws-status', role: 'status', 'aria-live': 'polite' });
  const output = el('section', { class: 'ns-ws-output', 'aria-label': '当前输出' });
  const outputDetails = el('details', { class: 'ns-ws-saved-output', hidden: true },
    el('summary', { text: '查看已保存的输出' }), output);
  if (!context.headerActions) root.append(intro);
  else root.classList.add('has-shared-header');
  root.append(body, status, outputDetails); container.replaceChildren(root); container.scrollTop = 0;

  function on(target, event, handler, opts = {}) { target.addEventListener(event, handler, { ...opts, signal: lifetime.signal }); }
  function patch(change) { if (disposed) return; Object.assign(params, change); context.updateNode(change); }
  async function save() { if (disposed) return; await context.saveWorkflow(); if (!disposed) say('已保存'); }
  function say(message, error = false) { if (disposed) return; status.textContent = message; status.classList.toggle('is-error', error); context.setStatus?.(message); }
  async function busy(button, operation) {
    const original = button.textContent; button.disabled = true; button.dataset.busy = 'true';
    try { return await operation(); } catch (error) { say(error.message || '操作未完成，请重试。', true); return null; }
    finally { if (!lifetime.signal.aborted) { button.disabled = button.dataset.pending === 'true'; button.textContent = original; delete button.dataset.busy; } }
  }
  function button(label, action, { primary = false, disabled = false, className = '' } = {}) {
    const button = el('button', { type: 'button', class: `ns-button ${primary ? 'is-primary' : ''} ${className}`, text: label, disabled });
    on(button, 'click', () => busy(button, action)); return button;
  }
  function showOutput(value = context.node.output) {
    output.replaceChildren(); outputDetails.hidden = !value; if (!value) return;
    const url = assetURL(value);
    if (url) output.append(el('img', { src: url, alt: '当前节点输出预览', class: 'ns-ws-result-image' }));
    if (value.report) renderReport(output, value.report);
    else {
      const report = Object.fromEntries(['suggestions', 'checks', 'steps', 'generalSteps', 'items', 'intent', 'prompt'].filter(key => value[key]).map(key => [key, value[key]]));
      if (Object.keys(report).length) renderReport(output, report);
    }
    if (value.task) output.append(el('p', { class: 'ns-ws-notice', text: value.task.prompt || value.task.description || '生成任务已准备好，可连接图像生成节点。' }));
    if (value.message || value.summary) output.append(el('p', { text: value.message || value.summary }));
    const downloads = [...(Array.isArray(value.downloads) ? value.downloads : []), ...(Array.isArray(value.files) ? value.files : []), ...(value.downloadUrl ? [{ url: value.downloadUrl, label: '下载输出文件' }] : [])];
    for (const item of downloads) {
      const link = assetURL(item.url || item.downloadUrl); if (link) output.append(el('a', { href: link, class: 'ns-button', download: '', text: item.label || item.name || '下载文件' }));
    }
    root.dispatchEvent(new CustomEvent('workspace:output', { detail: value }));
  }
  async function run(opts = {}) {
    context.updateNode({ ...params });
    say('正在处理这一步…'); const result = await context.runNode(opts);
    if (!lifetime.signal.aborted) { showOutput(currentOutput(context, result)); outputDetails.open = true; say(result?.message || '已完成'); }
    return result;
  }
  async function commit(value) { await context.commitOutput(value); showOutput(value); say('输出已更新'); }
  function preview(value = inputFor(context), label = '当前输入') {
    const url = assetURL(value); const figure = el('figure', { class: 'ns-ws-preview' });
    if (url) figure.append(el('img', { src: url, alt: label }));
    else figure.append(el('div', { class: 'ns-ws-empty', text: '连接图片输入或已有方案' }));
    figure.append(el('figcaption', { text: label })); return figure;
  }
  showOutput();
  function destroy() { if (disposed) return; disposed = true; lifetime.abort(); cleanups.forEach(fn => fn()); root.remove(); }
  if (context.signal) {
    if (context.signal.aborted) destroy();
    else context.signal.addEventListener('abort', destroy, { once: true, signal: lifetime.signal });
  }
  return { root, body, params, output, outputDetails, on, patch, save, say, button, run, commit, preview, showOutput,
    signal: lifetime.signal, cleanup: fn => disposed ? fn() : cleanups.push(fn), destroy };
}

export function field(workspace, key, label, { type = 'text', placeholder = '', help = '', options, rows = 4, value, min, max, step, persist = true } = {}) {
  const id = `ns-field-${workspace.root.dataset.workspace}-${key}-${Math.random().toString(16).slice(2, 7)}`;
  const control = options ? el('select', { class: 'ns-input', id }, options.map(item => el('option', { value: typeof item === 'string' ? item : item.value, text: typeof item === 'string' ? item : item.label })))
    : type === 'textarea' ? el('textarea', { class: 'ns-input', id, rows, placeholder }) : el('input', { class: 'ns-input', id, type, placeholder, min, max, step });
  const initial = value ?? workspace.params[key] ?? (type === 'checkbox' ? false : '');
  if (persist && !(key in workspace.params)) workspace.params[key] = initial;
  if (type === 'checkbox') control.checked = Boolean(initial); else control.value = initial;
  const group = el('div', { class: `ns-ws-field ${type === 'checkbox' ? 'is-check' : ''}` }, el('label', { for: id, text: label }), control, help ? el('small', { text: help }) : null);
  workspace.on(control, type === 'textarea' || (!options && type !== 'checkbox') ? 'input' : 'change', () => {
    const next = type === 'checkbox' ? control.checked : type === 'number' || type === 'range' ? Number(control.value) : control.value;
    if (persist) workspace.patch({ [key]: next });
  });
  return { group, control };
}

export function actions(...buttons) { return el('div', { class: 'ns-ws-actions' }, buttons); }
export function notice(text, kind = '') { return el('p', { class: `ns-ws-notice ${kind}`, text }); }
export function renderReport(container, report) {
  if (typeof report === 'number' || typeof report === 'boolean') { container.append(el('span', { text: String(report) })); return; }
  if (typeof report === 'string') { container.append(el('div', { class: 'ns-ws-prose', text: report })); return; }
  if (Array.isArray(report)) {
    const list = el('ul', { class: 'ns-ws-report-list' });
    for (const item of report) {
      const row = el('li');
      if (typeof item === 'string') row.textContent = item;
      else if (item && typeof item === 'object') {
        if (item.title || item.label) row.append(el('strong', { text: item.title || item.label }));
        const detail = item.detail || item.description || item.text || item.message || item.value;
        if (detail) row.append(el('div', { class: 'ns-ws-prose', text: typeof detail === 'string' ? detail : JSON.stringify(detail) }));
        if (item.status) row.append(el('small', { text: ({ needs_confirmation: '待确认', provided: '已填写', present: '已具备' })[item.status] || item.status }));
        for (const [key, value] of Object.entries(item)) if (!['id', 'title', 'label', 'detail', 'description', 'text', 'message', 'value', 'status', 'action'].includes(key) && value != null) renderReport(row, { [key]: value });
      } else row.textContent = String(item);
      list.append(row);
    }
    container.append(list); return;
  }
  if (!report || typeof report !== 'object') return;
  if (report.title) container.append(el('h4', { text: report.title }));
  if (report.summary) container.append(el('p', { text: report.summary }));
  for (const [key, value] of Object.entries(report)) {
    if (['title', 'summary', 'semanticAI', 'method', 'generatedBy', 'model'].includes(key) || value == null) continue;
    const title = { suggestions: '修改建议', issues: '检查事项', steps: '分区域步骤', generalSteps: '制作顺序', items: '需求说明', conditions: '条件', checks: '检查清单', warnings: '需要确认', sources: '依据', limitations: '当前范围', materials: '材料与小样', notes: '说明', intent: '整理后的想法', checklist: '确认清单', operations: '执行操作', prompt: '生成描述' }[key] || key;
    const section = el('div', { class: 'ns-ws-report-section' }, el('h4', { text: title }));
    renderReport(section, value); container.append(section);
  }
  if (!Object.keys(report).length) container.append(el('p', { text: '暂无内容。' }));
}

export async function uploadFile(context, file) {
  if (!file || file.size > 20 * 1024 * 1024) throw new Error('请选择不超过 20 MB 的图片。');
  const form = new FormData(); form.append('file', file);
  const result = await context.api('POST', '/api/uploads', form);
  return { ...result, name: file.name };
}

export function uploadControl(workspace, context, label, asyncHandler, { multiple = false } = {}) {
  const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple, class: 'ns-ws-file', 'aria-label': label });
  workspace.on(input, 'change', async () => {
    const files = [...input.files]; input.disabled = true;
    try { for (const file of files) await asyncHandler(await uploadFile(context, file)); workspace.say('图片已上传并保存到本机项目。'); }
    catch (error) { workspace.say(error.message, true); }
    finally { input.value = ''; input.disabled = false; }
  });
  return el('label', { class: 'ns-ws-upload' }, el('span', { text: label }), input);
}

export async function loadImage(url) {
  if (!assetURL(url)) throw new Error('没有可用的本机图片。');
  const image = new Image(); image.src = assetURL(url); await image.decode(); return image;
}

export async function uploadCanvas(context, canvas, name) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('图片导出未完成。');
  return uploadFile(context, new File([blob], name, { type: 'image/png' }));
}
