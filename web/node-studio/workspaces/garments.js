import { createWorkspace, el, field, actions, notice, inputFor, assetURL, loadImage, renderReport } from './shared.js';

/** Coordinates are normalized to the source image, independent of window size. */
async function garmentSelector(ws, value, flat) {
  const image = await loadImage(assetURL(value));
  const canvas = el('canvas', { class: 'ns-garment-selection', tabindex: '0', 'aria-label': flat ? '依次选择左上、右上、右下、左下四个角' : '点击服装，拖动框选，或逐点描出轮廓' });
  const scale = Math.min(1, 1100 / image.width, 900 / image.height); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
  const ctx = canvas.getContext('2d'), stored = ws.params.selection || {};
  let points = structuredClone(stored.points || []), polygon = structuredClone(stored.polygon || []), quad = structuredClone(stored.quad || []), box = stored.box || null, start, draft;
  const mode = field(ws, '_selectionMode', '选择方式', { persist: false, value: flat ? 'quad' : 'positive', options: flat ? [{ value: 'quad', label: '四角定位 · 左上起顺时针' }] : [{ value: 'positive', label: '保留点 · 点击衣服内部' }, { value: 'negative', label: '排除点 · 点击不需要的部分' }, { value: 'box', label: '框选 · 拖出部件范围' }, { value: 'polygon', label: '手动轮廓 · 沿边逐点点击' }] });
  const position = event => { const r = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (event.clientY - r.top) / r.height)) }; };
  const data = () => structuredClone({ points, polygon, quad, box });
  const persist = () => ws.patch({ selection: data() });
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2; ctx.strokeStyle = '#a43734'; ctx.fillStyle = '#a4373420';
    const area = draft || box;
    if (area) { ctx.fillRect(area.x * canvas.width, area.y * canvas.height, area.width * canvas.width, area.height * canvas.height); ctx.strokeRect(area.x * canvas.width, area.y * canvas.height, area.width * canvas.width, area.height * canvas.height); }
    const list = flat ? quad : polygon;
    if (list.length) { ctx.beginPath(); list.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](p.x * canvas.width, p.y * canvas.height)); if (list.length > 2) ctx.closePath(); ctx.fill(); ctx.stroke(); }
    for (const [i, p] of [...list, ...points].entries()) {
      ctx.fillStyle = p.label === 0 ? '#344d5b' : '#a43734'; ctx.beginPath(); ctx.arc(p.x * canvas.width, p.y * canvas.height, 7, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(p.label === 0 ? '−' : flat ? String(i + 1) : '+', p.x * canvas.width, p.y * canvas.height + 4);
    }
  }
  ws.on(canvas, 'pointerdown', event => {
    if (event.button !== 0) return; event.preventDefault(); const p = position(event);
    if (mode.control.value === 'box') { start = p; canvas.setPointerCapture(event.pointerId); return; }
    if (flat) { if (quad.length >= 4) quad = []; quad.push(p); }
    else if (mode.control.value === 'polygon') { if (polygon.length < 200) polygon.push(p); }
    else if (points.length < 64) points.push({ ...p, label: mode.control.value === 'negative' ? 0 : 1 });
    persist(); draw();
  });
  ws.on(canvas, 'pointermove', event => { if (!start) return; const p = position(event); draft = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(start.x - p.x), height: Math.abs(start.y - p.y) }; draw(); });
  ws.on(canvas, 'pointerup', () => { if (!start) return; if (draft?.width > .005 && draft?.height > .005) box = draft; start = draft = null; persist(); draw(); });
  ws.on(canvas, 'pointercancel', () => { start = draft = null; draw(); });
  draw();
  return { canvas, mode, data, clear() { points = []; polygon = []; quad = []; box = null; persist(); draw(); }, undo() { if (flat) quad.pop(); else if (mode.control.value === 'polygon') polygon.pop(); else if (mode.control.value === 'box') box = null; else points.pop(); persist(); draw(); } };
}

export async function garmentWorkspace(container, context) {
  if(context.node.type==='garment_flatten'&&context.node.params?.preparationOnly){const {flatlayPhoto}=await import('./flatlay-photo.js');return flatlayPhoto(container,context);}
  const flat = context.node.type === 'garment_flatten';
  const ws = createWorkspace(container, context, { title: flat ? '展开衣片' : '分割服装部件', description: flat ? '四点校正可见衣片，或生成平铺参考' : '点击、框选或沿轮廓选出衣片，处理后直接显示结果' });
  ws.root.dataset.inlineResult = 'true';
  const input = inputFor(context); if (!assetURL(input)) { ws.body.append(notice('先连接一张服装图片')); return ws; }
  const currentNode = () => context.getWorkflow().nodes.find(node => node.id === context.node.id);
  let capabilities = {}, job = null, busy = false;
  try { capabilities = await context.api('GET', '/api/node-garments/capabilities'); } catch (error) { ws.say(error.message, true); }
  if (ws.signal.aborted) return ws;
  const selector = await garmentSelector(ws, input, flat);
  if (ws.signal.aborted) return ws;
  const inputStage = el('div', { class: 'ns-ws-canvas-wrap' }, selector.canvas);
  const resultImage = el('img', { alt: flat ? '当前展平衣片' : '当前服装部件', 'data-garment-current': '', style: 'max-width:100%;max-height:100%;object-fit:contain' });
  const resultStage = el('div', { class: 'ns-ws-canvas-wrap', hidden: true }, resultImage);
  const inputTab = ws.button('选区', () => chooseView(false));
  const resultTab = ws.button('当前结果', () => chooseView(true));
  const tabs = el('nav', { class: 'ns-result-tabs', 'aria-label': '服装工作区视图' }, inputTab, resultTab);
  const stage = el('section', { class: 'ns-garment-stage' }, tabs, inputStage, resultStage);
  const controls = el('aside', { class: 'ns-garment-controls' });
  const method = field(ws, 'method', flat ? '展平方式' : '分割方式', { value: ws.params.method || (flat ? 'geometry' : capabilities.segmentation?.available ? 'sam2' : 'polygon'), options: flat ? [{ value: 'geometry', label: '四点校正 · 可见表面拉正' }, { value: 'model', label: 'AI 平铺参考 · 生成补全' }] : [{ value: 'sam2', label: 'SAM 2.1 · 智能分割' }, { value: 'polygon', label: '手动轮廓 · 精确修边' }] });
  controls.append(method.group, selector.mode.group, actions(ws.button('撤销定位点', () => { selector.undo(); chooseView(false); }), ws.button('重新选择', () => { selector.clear(); chooseView(false); })));
  ws.on(selector.mode.control, 'change', () => chooseView(false));
  if (flat) {
    controls.append(field(ws, 'category', '服装类别', { value: ws.params.category || 'upper', options: [{ value: 'upper', label: '上衣 / 披风参考' }, { value: 'lower', label: '下装' }, { value: 'dress', label: '连体服装' }] }).group,
      notice('四点校正只拉正可见表面；AI 平铺会补画未知部分，制作仍需真实平铺照和尺寸'),
      notice(capabilities.flatten?.model ? '本机平铺模型已安装' : 'AI 平铺模型未就绪，可使用四点校正'));
  } else controls.append(field(ws, 'partName', '部件名称', { value: ws.params.partName || '披风', placeholder: '左袖、内搭、领巾…' }).group,
    notice(capabilities.segmentation?.available ? 'SAM 2.1 · 本机处理' : capabilities.segmentation?.reason || '可先用手动轮廓提取'));
  const crop = field(ws, 'cropPart', '裁去外围透明空白', { type: 'checkbox', value: ws.params.cropPart === true });
  if (!flat) controls.append(crop.group);
  const state = el('p', { role: 'status', class: 'ns-ws-status' });
  const warnings = el('section');
  const partSelect = el('select', { class: 'ns-input', 'aria-label': '切换服装部件' });
  const partsArea = el('section', { hidden: true }, el('label', { text: '已提取部件' }), partSelect);
  function chooseView(result) {
    const output = currentNode()?.output, url = assetURL(output);
    result = Boolean(result && url);
    if (url) resultImage.src = url;
    inputStage.hidden = result; resultStage.hidden = !result;
    inputTab.setAttribute('aria-selected', String(!result)); resultTab.setAttribute('aria-selected', String(result));
    resultTab.disabled = !url;
    ws.outputDetails.hidden = true;
  }
  function renderResult(show = true) {
    const output = currentNode()?.output;
    partSelect.replaceChildren(...(output?.parts || []).map(part => el('option', { value: part.id, text: part.name || '服装部件' })));
    if (output?.activePartId) partSelect.value = output.activePartId;
    partsArea.hidden = !output?.parts?.length;
    warnings.replaceChildren();
    if (output?.warnings?.length) renderReport(warnings, { warnings: output.warnings });
    chooseView(show);
  }
  async function applyJob() {
    if (ws.signal.aborted || job?.status !== 'completed') return;
    // Clear the recovery marker before committing the result. Saving this marker
    // afterwards would incorrectly mark the just-completed output as stale.
    ws.patch({ pendingGarmentJobId: null });
    await ws.run({ jobId: job.id, crop: crop.control.checked });
    if (ws.signal.aborted) return;
    renderResult(); state.textContent = '已显示新结果';
  }
  async function observe(id) {
    while (!ws.signal.aborted) {
      job = await context.api('GET', `/api/node-garments/jobs/${encodeURIComponent(id)}`);
      if (ws.signal.aborted) return;
      state.textContent = job?.message || '';
      if (job.status === 'completed') { await applyJob(); return; }
      if (!['queued', 'running'].includes(job.status)) {
        ws.patch({ pendingGarmentJobId: null }); await ws.save();
        state.textContent = job.message || '本次未完成，之前的结果已保留';
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  async function execute(operation) {
    if (busy) return;
    const selection = selector.data(), params = { ...selection, method: method.control.value, name: ws.params.partName || '服装部件', category: ws.params.category || 'upper' };
    if (operation !== 'foreground') {
      if (flat && params.method === 'geometry' && params.quad.length !== 4) { chooseView(false); throw Error('依次选择左上、右上、右下、左下四个角'); }
      if (!flat && params.method === 'polygon' && params.polygon.length < 3) { chooseView(false); throw Error('沿服装边缘至少点三个位置'); }
      if (!flat && params.method === 'sam2' && !params.box && !params.points.some(point => point.label === 1)) { chooseView(false); throw Error('先点一下要保留的衣服，或框出范围'); }
    }
    busy = true; state.textContent = '正在处理，之前的结果会保留';
    try {
      await ws.save(); const current = context.getWorkflow();
      job = await context.api('POST', '/api/node-garments/jobs', { workflowId: current.id, nodeId: context.node.id, expectedRevision: current.revision, operation, params });
      ws.patch({ pendingGarmentJobId: job.id }); await ws.save(); await observe(job.id);
    } finally { busy = false; }
  }
  const generate = ws.button(flat ? '展开衣片' : '提取服装部件', () => execute(flat ? 'flatten' : 'segment'), { primary: true });
  controls.append(partsArea, warnings, state, actions(generate));
  if (!flat) controls.append(actions(ws.button('提取完整人物 / 去背景', () => execute('foreground'))));
  ws.on(partSelect, 'change', async () => {
    const output = currentNode()?.output; if (!output?.jobId || busy) return;
    partSelect.disabled = true;
    try { await ws.run({ jobId: output.jobId, partId: partSelect.value, crop: crop.control.checked }); renderResult(); }
    catch (error) { ws.say(error.message, true); }
    finally { partSelect.disabled = false; }
  });
  ws.body.append(el('div', { class: 'ns-garment-bench' }, stage, controls)); ws.root.classList.add('ns-ws-wide'); ws.root.dataset.arranged = 'true';
  renderResult();
  if (ws.params.pendingGarmentJobId) {
    busy = true; generate.dataset.pending = 'true'; generate.disabled = true;
    observe(ws.params.pendingGarmentJobId).catch(error => { if (!ws.signal.aborted) ws.say(error.message, true); })
      .finally(() => { busy = false; delete generate.dataset.pending; if (!ws.signal.aborted) generate.disabled = false; });
  }
  return ws;
}
