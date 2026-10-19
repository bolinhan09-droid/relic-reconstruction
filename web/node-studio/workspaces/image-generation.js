import { createWorkspace, el, field, actions, notice, uploadControl, inputFor, assetURL, currentOutput } from './shared.js';

const providerOptions = [{ value: 'openai', label: 'GPT 图像 · OpenAI' }, { value: 'qwen', label: '千问图像 · 百炼' }, { value: 'openai_compatible', label: 'OpenAI 兼容接口' }, { value: 'local_openai', label: '本机图像编辑服务' }];

export async function imageGenerate(container, context) {
  const ws = createWorkspace(container, context, { title: '图像生成', description: '确认要求，生成一版，再与原图比较。只有点击生成才提交图像请求。' });
  let settings = {};
  try { settings = await context.api('GET', '/api/settings/ai'); } catch (error) { ws.say(error.message, true); }
  if (ws.signal.aborted) return ws;
  const form = el('form', { class: 'ns-ws-ai-form' });
  const provider = field(ws, 'provider', '使用哪个图像服务', { options: providerOptions, value: ws.params.provider || settings.provider || 'openai' });
  const model = field(ws, 'model', '图像模型名称', { placeholder: '填写服务实际支持的图像编辑模型 ID' });
  const baseURL = field(ws, '_baseUrl', '接口根地址', { type: 'url', placeholder: 'https://api.example.com/v1', persist: false });
  // Secret values deliberately never enter node params, workflow JSON or output artifacts.
  const keyInput = el('input', { type: 'password', class: 'ns-input', autocomplete: 'off', spellcheck: 'false', id: 'ns-image-api-secret', placeholder: '留空沿用此服务已经配置的密钥' });
  const secretField = el('div', { class: 'ns-ws-field' }, el('label', { for: 'ns-image-api-secret', text: 'API 密钥' }), keyInput, el('small', { text: '只发送给本机接口设置，不写进节点或项目文件。' }));
  const quality = field(ws, 'quality', '生成质量', { options: [{ value: 'low', label: '低 · 试稿' }, { value: 'medium', label: '中 · 常规' }, { value: 'high', label: '高 · 精细' }, { value: 'auto', label: '自动' }], value: ws.params.quality || 'medium' });
  const region = field(ws, '_region', '百炼地域', { options: [{ value: 'cn-beijing', label: '中国 · 北京' }, { value: 'ap-southeast-1', label: '新加坡' }], persist: false });
  const workspaceID = field(ws, '_workspaceId', '百炼工作空间 ID', { persist: false });
  const mode = field(ws, 'mode', '怎样处理当前输入', { options: [{ value: 'draft', label: '按上游任务生成／修改' }, { value: 'brush', label: '融合已有笔刷与服装材质' }], value: ws.params.mode || 'draft' });
  const input = inputFor(context);
  const intent = field(ws, 'intent', '本次生成要求', { type: 'textarea', rows: 3, value: ws.params.intent || input.task?.prompt || input.task?.intent || '保留当前真实服装、人物和背景，将已有战损设计自然融入衣服光影与材质。', help: '上游任务仍会保留；可以补充本次特别想调整的地方。' });
  const savedStatus = el('p', { class: 'ns-ws-notice' }), connectionStatus = el('p', { role: 'status', 'aria-live': 'polite', class: 'ns-ws-status' });
  let firstFill = true;
  function snapshot() { return settings.providers?.[provider.control.value] || {}; }
  function fill() {
    const current = snapshot(), custom = ['openai_compatible', 'local_openai'].includes(provider.control.value), local = provider.control.value === 'local_openai', qwen = provider.control.value === 'qwen';
    model.control.value = (firstFill ? ws.params.model : '') || current.model || (qwen ? 'qwen-image-3.0-pro' : local ? 'sd-cpp-local' : 'gpt-image-2');
    quality.control.value = (firstFill ? ws.params.quality : '') || current.quality || (qwen || local ? 'auto' : 'medium'); quality.group.hidden = qwen || local;
    baseURL.group.hidden = !custom; baseURL.control.value = local && !current.model ? 'http://127.0.0.1:8190/v1' : current.baseUrl || (local ? 'http://127.0.0.1:8190/v1' : '');
    secretField.hidden = local;
    localControls.hidden = !local;
    region.group.hidden = !qwen; workspaceID.group.hidden = !qwen;
    region.control.value = current.region || 'cn-beijing'; workspaceID.control.value = current.workspaceId || '';
    keyInput.value = ''; savedStatus.textContent = current.ready ? '此服务已有配置。连接及图像编辑能力仍需分别验证。' : '先保存此服务设置。连接检查只读取模型列表。';
    billing.textContent = local ? '本机千问图像研究组件可按需启动。先停止视觉助手释放显存；图像与提示词留在电脑内。模型需独立安装。' : '这次生图按所选 API 服务计费，实际金额以服务商账单为准。';
    confirmGroup.hidden = local;
    serviceSummary.textContent = `${providerOptions.find(item => item.value === provider.control.value)?.label || '图像服务'}${model.control.value ? ' · ' + model.control.value : ''}`;
    if (firstFill) serviceDetails.open = !current.ready;
    firstFill = false;
  }
  function payload() {
    const selected = provider.control.value, result = { provider: selected, model: model.control.value.trim(), quality: ['qwen', 'local_openai'].includes(selected) ? 'auto' : quality.control.value };
    if (['openai_compatible', 'local_openai'].includes(selected)) result.baseUrl = baseURL.control.value.trim();
    if (selected === 'qwen') { result.region = region.control.value; result.workspaceId = workspaceID.control.value.trim(); }
    if (keyInput.value.trim()) result.apiKey = keyInput.value.trim();
    return result;
  }
  const billing = notice(''), confirm = el('input', { type: 'checkbox', id: 'ns-image-confirm' });
  const confirmGroup = el('label', { class: 'ns-ws-consent', for: 'ns-image-confirm' }, confirm, el('span', { text: '我确认将当前输入图片和任务发送给所选服务，并按该服务规则计费。' }));
  const candidatePanel = el('section', { class: 'ns-ws-generation-candidate', 'aria-live': 'polite' });
  let liveOutput = context.node.output || {};
  function showCandidate(output) {
    liveOutput = output || {}; candidatePanel.replaceChildren();
    const state = liveOutput.jobStatus || liveOutput.status;
    if (liveOutput.jobId && !liveOutput.candidateImageUrl) {
      const label = { queued: '已排队，等待图像服务处理。', running: '正在生成，可以先继续查看其他节点。', failed: '这次生成没有完成，原版仍然保留。', succeeded: '生成已完成。' }[state] || '图像任务已提交。';
      candidatePanel.append(notice(liveOutput.jobMessage || liveOutput.message || label));
    }
    const candidateURL = assetURL(liveOutput.candidateImageUrl); if (!candidateURL) return;
    candidatePanel.append(el('h3', { text: '新一版已返回，先比较再采用' }));
    const comparison = el('div', { class: 'ns-ws-generation-comparison' });
    for (const [url, label] of [[assetURL(liveOutput.imageUrl) || assetURL(input), '处理前'], [candidateURL, '生成候选 · 尚未采用']]) {
      if (url) comparison.append(el('figure', {}, el('img', { src: url, alt: label }), el('figcaption', { text: label })));
    }
    candidatePanel.append(comparison, actions(ws.button('采用这版效果', async () => {
      const reference = liveOutput.candidateReference || { url: candidateURL };
      const adopted = { ...liveOutput, kind: 'garment', imageUrl: candidateURL, reference, asset: reference,
        sourceImageUrl: liveOutput.imageUrl || assetURL(input), requiresExplicitAdoption: false,
        sourceBrushStrokes: liveOutput.brushStrokes || input.brushStrokes || [],
        originalProjectSnapshot: liveOutput.projectSnapshot || input.projectSnapshot || null,
        projectSnapshot: null, brushStrokes: [], damageItems: [], rasterized: true,
        imageSemantics: 'raster_base', editableStrokes: false,
        message: '已采用这版图像；旧版保留在节点历史中，生成图内的痕迹不再重复叠画。' };
      delete adopted.candidateImageUrl; delete adopted.candidateReference;
      await ws.commit(adopted); showCandidate(adopted);
    }, { primary: true })));
    if (liveOutput.usage && Object.keys(liveOutput.usage).length) candidatePanel.append(el('p', { class: 'ns-ws-description', text: `接口返回用量：${JSON.stringify(liveOutput.usage)}` }));
  }
  const saveSettings = ws.button('保存服务设置', async () => {
    settings = await context.api('POST', '/api/settings/ai', payload()); keyInput.value = '';
    ws.patch({ provider: provider.control.value, model: model.control.value.trim(), quality: quality.control.value }); await ws.save(); savedStatus.textContent = '已保存。配置可以在其他图像生成节点复用，尚未调用生图。';
  });
  const check = ws.button('检查连接', async () => {
    connectionStatus.textContent = '正在读取模型列表…'; const result = await context.api('POST', '/api/settings/ai/check', payload());
    connectionStatus.textContent = `${result.message || '已完成模型列表检查。'} 这不代表图像编辑已经验证。`;
  });
  const serviceSummary = el('summary', { text: '图像服务设置' });
  const localState = el('p', { role: 'status', class: 'ns-ws-status' });
  const localStart = ws.button('启动本机千问生图', async () => {
    const result = await context.api('POST', '/api/local-image/start', {}); localState.textContent = result.reason;
    if (!['starting', 'ready'].includes(result.status)) throw Error(result.reason || '本机模型尚未就绪。');
    for (let i=0; i<120 && !ws.signal.aborted; i++) {
      const status = await context.api('GET', '/api/local-image/status'); localState.textContent = status.reason;
      if (status.ready) {
        provider.control.value = 'local_openai'; model.control.value = status.model; baseURL.control.value = status.baseUrl;
        settings = await context.api('POST', '/api/settings/ai', payload()); ws.patch({provider:'local_openai',model:status.model,quality:'auto'}); await ws.save();
        localState.textContent = status.imageEditingVerified ? '本机图像编辑已就绪 · 模型用于研究与评估。' : '服务已加载，图像编辑还需要实际验证。'; return;
      }
      if (!['starting', 'ready'].includes(status.status)) throw Error(status.reason || '本机生图未能启动。');
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
  });
  const localControls = el('section', {}, notice('Qwen-Image-2.1 本机研究版 · 模型遵循 Qwen 研究许可，独立于软件安装包。'),
    actions(localStart, ws.button('停止生图模型', async()=>{const status=await context.api('POST','/api/local-image/stop',{});localState.textContent=status.reason;}),
      ws.button('停止视觉助手，释放显存', async()=>{const status=await context.api('POST','/api/local-ai/stop',{});localState.textContent=status.reason;})), localState);
  const serviceDetails = el('details', { class: 'ns-ws-details ns-ws-provider-settings' }, serviceSummary,
    provider.group, model.group, baseURL.group, secretField, region.group, workspaceID.group,
    localControls, savedStatus, actions(saveSettings, check), connectionStatus);
  const generate = ws.button('生成一版', async () => {
    if (provider.control.value !== 'local_openai' && !confirm.checked) throw new Error('请先确认本次图片提交与接口计费。');
    // Save explicitly chosen settings before running; no retry or request on change.
    settings = await context.api('POST', '/api/settings/ai', payload()); keyInput.value = '';
    ws.patch({ provider: provider.control.value, model: model.control.value.trim(), quality: quality.control.value, mode: mode.control.value });
    const result = await ws.run({ confirmedExternal: true });
    showCandidate(currentOutput(context, result));
    if (result?.result?.jobId || result?.jobId) ws.say('生成任务已提交。可以返回总览查看状态；本次不会自动重试。');
  }, { primary: true });
  ws.on(provider.control, 'change', fill);
  ws.on(form, 'submit', event => event.preventDefault());
  ws.body.append(ws.preview(input), input.task ? notice(`上游任务：${input.task.prompt || input.task.intent || '已准备'}`) : notice('可接在快速生成、选区生图、融合或精修之后。'), form);
  form.append(intent.group, el('div', { class: 'ns-ws-form-grid' }, mode.group, quality.group), serviceDetails, billing, confirmGroup, actions(generate));
  const manual = el('details', { class: 'ns-ws-details' }, el('summary', { text: '已有生成结果？直接导回' }), el('p', { text: '导回你在其他工具生成的图，并保留上游版本。不触发图像接口。' }), uploadControl(ws, context, '导入效果图片', async asset => {
    const output = { ...input, kind: 'garment', imageUrl: asset.url, reference: asset, asset,
      sourceBrushStrokes: input.brushStrokes || input.sourceBrushStrokes || [], originalProjectSnapshot: input.projectSnapshot || input.originalProjectSnapshot || null,
      projectSnapshot: null, brushStrokes: [], damageItems: [], rasterized: true, imageSemantics: 'raster_base', editableStrokes: false,
      generatedBy: 'user_import', sourceImageUrl: assetURL(input), sourceNodeId: context.node.id };
    await ws.commit(output);
  }));
  ws.body.append(candidatePanel, manual); fill(); showCandidate(liveOutput);
  ws.on(window, 'relic-node-job-updated', event => { if (event.detail?.nodeId === context.node.id) { showCandidate(event.detail.output); ws.showOutput(event.detail.output); } });
  ws.cleanup(() => { keyInput.value = ''; }); return ws;
}
