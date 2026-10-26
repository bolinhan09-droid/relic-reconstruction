import { createWorkspace, el, field, actions, notice, uploadControl, inputFor, assetURL, currentOutput } from './shared.js';
import { generationBrief } from './generation-brief.js';
import { imageConnection, imageServiceLabel } from './image-connection.js';
import { adoptImageResult, imageVersions } from '../core/image-results.js';

const ACTIVE = new Set(['queued', 'running', 'pending', 'processing']);

export async function imageGenerate(container, context) {
  const ws = createWorkspace(container, context, { title: '图像生成', description: '新结果直接显示在画布，之前的方案可从版本入口切换' });
  ws.root.dataset.inlineResult = 'true';
  const input = inputFor(context), fallback = {...input, imageUrl: assetURL(input)}, brief = generationBrief(ws, context);
  const service = await imageConnection(ws, context);
  if (ws.signal.aborted) return ws;
  const form = el('form', { class: 'ns-ws-ai-form' });
  const mode = field(ws, 'mode', '处理方式', { options: [{ value: 'draft', label: '按要求生成／修改' }, { value: 'brush', label: '融合已有笔刷与服装材质' }], value: ws.params.mode || 'draft' });
  const quality = field(ws, 'quality', '生成质量', { options: [{ value: '', label: '跟随全局设置' }, { value: 'low', label: '低 · 试稿' }, { value: 'medium', label: '中 · 常规' }, { value: 'high', label: '高 · 精细' }, { value: 'auto', label: '自动' }], value: ws.params.quality || '' });
  let liveOutput = context.node.output || {}, versionRows = [];
  const currentNode = () => context.getWorkflow?.()?.nodes?.find(node => node.id === context.node.id) || context.node;
  const image = el('img', { alt: '当前生成结果', 'data-current-generation': 'true' });
  const empty = el('div', { class: 'ns-ws-empty', text: '连接图片输入或已有方案' });
  const caption = el('span', { role: 'status' });
  const versions = el('select', { class: 'ns-input ns-image-version-select', 'aria-label': '切换本节点版本', 'data-image-versions': 'true' });
  const preview = el('figure', { class: 'ns-ws-preview ns-image-result' }, image, empty,
    el('figcaption', { class: 'ns-image-result-caption' }, caption,
      el('label', { class: 'ns-image-version-picker' }, el('span', { text: '版本' }), versions)));
  const billing = notice(''); billing.classList.add('ns-generation-billing');
  const generate = ws.button('生成一版', async () => {
    if (generate.dataset.pending === 'true') return;
    brief.assertReady({ allowEmpty: mode.control.value === 'brush' });
    await service.prepareGeneration();
    updateConnection();
    ws.patch({ provider: service.provider(), quality: quality.control.value, mode: mode.control.value });
    // The explicit Generate click authorizes this request; opening a node never submits it.
    const result = await ws.run({ confirmedExternal: true });
    renderResult(currentOutput(context, result));
    if (liveOutput.jobId) ws.say('正在生成，原画面会保留到新结果返回');
  }, { primary: true });
  generate.dataset.generationAction = 'true';
  function updateConnection() {
    const selected = service.provider() || service.settings().provider;
    const snapshot = service.effectSnapshot(), model = ws.params.model || snapshot.model || '默认模型';
    const label = `${imageServiceLabel(selected)} · ${model}`;
    billing.textContent = service.isExternal() ? `${label} · 点击生成将提交图片，按服务商规则计费` : `${label} · 本机运行`;
    generate.title = billing.textContent;
    generate.dataset.actionContext = billing.textContent;
    quality.group.hidden = ['qwen', 'local_openai'].includes(selected);
  }
  function renderResult(output) {
    if (ws.signal.aborted) return;
    liveOutput = output || {};
    const url = assetURL(liveOutput) || assetURL(input);
    if (url) image.src = url; else image.removeAttribute('src');
    image.hidden = !url; empty.hidden = Boolean(url);
    const waiting = liveOutput.kind === 'generation_job' && ACTIVE.has(liveOutput.jobStatus || liveOutput.status);
    const failed = ['failed', 'interrupted', 'error', 'invalid_result', 'cancelled', 'canceled'].includes(liveOutput.jobStatus);
    caption.textContent = waiting ? '正在生成 · 当前画面已保留' : failed ? '本次未完成 · 当前画面已保留' : liveOutput.basedOnOlderInput ? '当前结果 · 上游已有变化' : '当前结果';
    versionRows = imageVersions({...currentNode(), output: liveOutput}, fallback);
    const legacy = assetURL(liveOutput.candidateImageUrl);
    if (legacy) versionRows.push({id: 'legacy-result', label: '此前生成的结果', output: adoptImageResult(liveOutput, legacy, liveOutput.candidateReference)});
    versions.replaceChildren(...versionRows.map(row => el('option', { value: row.id, text: row.label })));
    versions.disabled = waiting || versionRows.length < 2;
    generate.dataset.pending = String(waiting);
    generate.disabled = waiting;
    ws.outputDetails.hidden = true;
  }
  ws.on(versions, 'change', async () => {
    const row = versionRows.find(item => item.id === versions.value); if (!row) return;
    versions.disabled = true;
    try {
      await ws.commit({...row.output, message: '已切换版本，下游方案可基于此版继续'});
      renderResult(currentNode().output);
    } catch (error) { ws.say(error.message, true); renderResult(liveOutput); }
  });
  ws.on(service.element, 'connectionchange', updateConnection);
  ws.on(form, 'submit', event => event.preventDefault());
  const generateActions = actions(generate); generateActions.dataset.fixedActions = 'true';
  form.append(brief.element, el('div', { class: 'ns-ws-form-grid' }, mode.group, quality.group), service.element, billing, generateActions);
  const manual = el('details', { class: 'ns-ws-details' }, el('summary', { text: '导入已有结果' }),
    uploadControl(ws, context, '导入效果图片', async asset => {
      await ws.commit({...adoptImageResult(liveOutput.imageUrl ? liveOutput : fallback, asset.url, asset),
        generatedBy: 'user_import', sourceNodeId: context.node.id});
      renderResult(currentNode().output);
    }));
  ws.body.append(preview, form, manual); updateConnection(); renderResult(liveOutput);
  // Migrate an already completed old-style candidate locally, without a model request.
  if (assetURL(liveOutput.candidateImageUrl) && !liveOutput.candidateBasedOnOlderInput) {
    await ws.commit(adoptImageResult(liveOutput, assetURL(liveOutput.candidateImageUrl), liveOutput.candidateReference));
    renderResult(currentNode().output);
  }
  ws.on(window, 'relic-node-job-updated', event => {
    if (event.detail?.nodeId === context.node.id) renderResult(event.detail.output);
  });
  return ws;
}
