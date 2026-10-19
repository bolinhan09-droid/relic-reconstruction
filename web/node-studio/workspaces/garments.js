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
  const flat = context.node.type === 'garment_flatten';
  const ws = createWorkspace(container, context, { title: flat ? '把衣片展开，继续设计' : '把服装分成独立部件', description: flat ? '先校正可见衣片，或生成平铺参考。精确制作仍需要真实平铺照片与尺寸。' : '点击或框选披风、袖子、内搭，提取透明部件图。排除点可以帮助去掉邻近部位。' });
  const input = inputFor(context); if (!assetURL(input)) { ws.body.append(notice('请先连接一张服装图片。')); return ws; }
  let capabilities = {}, job = null, busy = false;
  try { capabilities = await context.api('GET', '/api/node-garments/capabilities'); } catch (error) { ws.say(error.message, true); }
  const selector = await garmentSelector(ws, input, flat);
  const stage = el('section', { class: 'ns-garment-stage' }, el('div', { class: 'ns-ws-canvas-wrap' }, selector.canvas));
  const resultArea = el('section', { class: 'ns-garment-candidate', hidden: true, 'aria-label': '候选结果' });
  const partsArea = el('section', { class: 'ns-garment-parts', 'aria-label': '已提取的部件' }); stage.append(resultArea, partsArea);
  const controls = el('aside', { class: 'ns-garment-controls' });
  const method = field(ws, 'method', flat ? '展平方式' : '分割方式', { value: ws.params.method || (flat ? 'geometry' : capabilities.segmentation?.available ? 'sam2' : 'polygon'), options: flat ? [{ value: 'geometry', label: '四点校正 · 可见表面拉正' }, { value: 'model', label: 'AI 平铺参考 · 生成补全' }] : [{ value: 'sam2', label: 'SAM 2.1 · 智能分割' }, { value: 'polygon', label: '手动轮廓 · 精确修边' }] });
  controls.append(method.group, selector.mode.group, actions(ws.button('撤销定位点', () => selector.undo()), ws.button('重新选择', () => selector.clear())));
  if (flat) {
    controls.append(field(ws, 'category', '服装类别', { value: ws.params.category || 'upper', options: [{ value: 'upper', label: '上衣 / 披风参考' }, { value: 'lower', label: '下装' }, { value: 'dress', label: '连体服装' }] }).group,
      notice('四点校正只拉正你标出的可见表面，不恢复褶皱后隐藏的布料。AI 平铺会补画未知部分，复杂披风需要人工对照。'),
      notice(capabilities.flatten?.model ? '本机平铺模型已安装。' : 'AI 平铺模型未就绪，仍可使用四点校正。'));
  } else controls.append(field(ws, 'partName', '这个部件叫什么', { value: ws.params.partName || '披风', placeholder: '例如：左袖、内搭、领巾' }).group,
    notice(capabilities.segmentation?.available ? 'SAM 2.1 已安装 · 图片在本机处理' : capabilities.segmentation?.reason || '智能分割模型待安装，手动轮廓可直接使用。'));
  const crop = field(ws, 'cropPart', '采用时裁去外围透明空白', { type: 'checkbox', value: ws.params.cropPart === true });
  if (!flat) controls.append(crop.group);
  const state = el('p', { role: 'status', class: 'ns-ws-status' });
  const adopt = ws.button('采用这个结果', async () => {
    if (job?.status !== 'completed') throw Error('先完成处理，再采用结果。');
    await ws.run({ jobId: job.id, crop: crop.control.checked });
    ws.patch({ pendingGarmentJobId: null }); await ws.save(); renderParts(); state.textContent = '已采用，可以返回总览连接下一步。';
  }, { primary: true }); adopt.hidden = true;
  function showJob() {
    state.textContent = job?.message || '';
    if (job?.status !== 'completed') { adopt.hidden = true; return; }
    const artifact = job.artifact; resultArea.hidden = false; resultArea.replaceChildren();
    resultArea.append(el('h3', { text: flat ? '展平候选' : '透明部件候选' }), el('img', { src: assetURL(artifact.imageUrl), alt: flat ? '展平后的衣片' : '分割出的服装部件' }));
    if (artifact.warnings?.length) renderReport(resultArea, { warnings: artifact.warnings });
    adopt.hidden = false;
  }
  async function observe(id) {
    while (!ws.signal.aborted) {
      job = await context.api('GET', `/api/node-garments/jobs/${encodeURIComponent(id)}`); showJob();
      if (!['queued', 'running'].includes(job.status)) return;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  async function execute(operation) {
    if (busy) return;
    const selection = selector.data(), params = { ...selection, method: method.control.value, name: ws.params.partName || '服装部件', category: ws.params.category || 'upper' };
    if (operation !== 'foreground') {
      if (flat && params.method === 'geometry' && params.quad.length !== 4) throw Error('依次选择左上、右上、右下、左下四个角。');
      if (!flat && params.method === 'polygon' && params.polygon.length < 3) throw Error('请用手动轮廓沿服装边缘至少点三个位置。');
      if (!flat && params.method === 'sam2' && !params.box && !params.points.some(point => point.label === 1)) throw Error('先点一下要保留的衣服，或者框出范围。');
    }
    busy = true; state.textContent = '正在准备本机任务…';
    try {
      await ws.save(); const current = context.getWorkflow();
      job = await context.api('POST', '/api/node-garments/jobs', { workflowId: current.id, nodeId: context.node.id, expectedRevision: current.revision, operation, params });
      ws.patch({ pendingGarmentJobId: job.id }); await ws.save(); await observe(job.id);
    } finally { busy = false; }
  }
  controls.append(state, actions(ws.button(flat ? '生成展平候选' : '提取服装部件', () => execute(flat ? 'flatten' : 'segment'), { primary: true }), adopt));
  if (!flat) controls.append(actions(ws.button('提取完整人物 / 去背景', () => execute('foreground'))), notice('完整人物提取保留人物与服装；部件分割只提取你指定的衣物。'));
  function renderParts() {
    partsArea.replaceChildren(); const output = context.getWorkflow().nodes.find(node => node.id === context.node.id)?.output;
    if (!output?.parts?.length) return;
    partsArea.append(el('h3', { text: '部件库 · 选择一件继续' }));
    for (const part of output.parts) {
      const button = ws.button(`使用 ${part.name || '部件'}`, async () => {
        if (!output.jobId) throw Error('这个部件缺少来源任务，请重新提取后采用。');
        await ws.run({ jobId: output.jobId, partId: part.id, crop: crop.control.checked });
        renderParts();
        state.textContent = `当前输出已切换为 ${part.name || '所选部件'}。`;
      });
      partsArea.append(el('figure', {}, el('img', { src: assetURL(part.croppedUrl || part.imageUrl), alt: part.name || '服装部件' }), button));
    }
  }
  ws.body.append(el('div', { class: 'ns-garment-bench' }, stage, controls)); ws.root.classList.add('ns-ws-wide'); ws.root.dataset.arranged = 'true';
  renderParts();
  if (ws.params.pendingGarmentJobId) observe(ws.params.pendingGarmentJobId).catch(error => { if (!ws.signal.aborted) ws.say(error.message, true); });
  return ws;
}
