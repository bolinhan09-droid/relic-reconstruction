/** Adapter for the existing drawing and observed-mapping engines.
 * The iframe owns transient editing state; only an explicit commit changes a node.
 * No generation request is made by opening, wiring, or saving this adapter.
 */
const MODES = new Set(['brush', 'mapping', 'split']);

function localImage(value) {
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin && /^\/(data|resources|api)\//.test(url.pathname)
      ? url.pathname + url.search : '';
  } catch { return ''; }
}

function imageFrom(input, workflow) {
  const value = input || workflow.assets?.[0] || {};
  return { ...value, imageUrl: localImage(value.imageUrl || value.url || value.reference?.url || value.projectSnapshot?.reference?.url) };
}

function button(text, action) {
  const node = document.createElement('button');
  node.type = 'button'; node.textContent = text;
  node.addEventListener('click', action);
  return node;
}

export function openLegacyWorkspace(container, {
  mode = 'brush', workflow, node, input, onCommit = () => {}, onClose = () => {}, notify = () => {},
}) {
  if (!MODES.has(mode)) throw new Error('无法识别这个服装工作区。');
  if (!workflow?.id || !node?.id) throw new Error('当前节点缺少保存标识。');
  const source = imageFrom(input, workflow);
  if (!source.imageUrl) {
    const empty = document.createElement('p');
    empty.className = 'ns-empty'; empty.textContent = '请先连接带有真实服装图片的上游方案，再进入工作区。';
    container.append(empty);
    return { destroy() { empty.remove(); } };
  }
  if (mode === 'split') return openManualParts(container, { workflow, node, source, onCommit, onClose, notify });

  let destroyed = false, saving = false, ready = false, proximitySensor = null, automaticLensActive = false;
  const channel = crypto.randomUUID();
  const root = document.createElement('section');
  root.className = 'ns-legacy-workspace';
  root.style.cssText = 'display:flex;flex-direction:column;min-height:500px;height:100%;width:100%;gap:10px';
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap';
  const status = document.createElement('span'); status.setAttribute('role', 'status');
  status.style.cssText = 'font-size:13px;opacity:.8;flex:1;min-width:180px';
  status.textContent = mode === 'mapping' ? '正在打开已验证的对应点映射工作区…' : '正在打开独立笔触与服装表面工作区…';
  const save = button('保存并返回节点', () => {
    if (destroyed || saving || !ready) return;
    saving = true; save.disabled = true; status.textContent = '正在保存当前方案与真实输出…';
    iframe.contentWindow.postMessage({ type: 'relic-node-save', channel, workflowId: workflow.id, nodeId: node.id }, location.origin);
  });
  save.disabled = true;
  const exit = button('返回总览', () => onClose());
  toolbar.append(status, exit, save);
  const iframe = document.createElement('iframe');
  iframe.title = mode === 'mapping' ? '衣片展平与痕迹映射工作区' : '服装精致修改工作区';
  iframe.style.cssText = 'flex:1;min-height:480px;width:100%;border:1px solid #ffffff24;border-radius:12px;background:#102b33';
  const query = new URLSearchParams({ nodeEmbed: '1', workflowId: workflow.id, nodeId: node.id, mode, channel });
  if (source.projectId) query.set('projectId', source.projectId);
  iframe.src = '/legacy?' + query + '#studio';
  root.append(toolbar, iframe); container.append(root);

  function lensMessage(type, detail = {}) {
    if (destroyed || !ready) return;
    iframe.contentWindow?.postMessage({ type, workflowId: workflow.id, nodeId: node.id, channel, ...detail }, location.origin);
  }
  function setAutomaticActive(active) { automaticLensActive = Boolean(active); lensMessage('relic-node-magnifier-auto', { active: automaticLensActive }); }
  // Importing the opt-in sensor does not enable it or request camera permission.
  if (mode === 'brush') import('./proximity-sensor.js').then(({ mountProximitySensor }) => {
    if (destroyed) return;
    proximitySensor = mountProximitySensor(toolbar, { onNear: setAutomaticActive, notify });
  }).catch(() => { if (!destroyed) notify('靠近感知入口暂时未载入，仍可在画布上按住 M 使用放大镜。'); });

  const timeout = setTimeout(() => {
    if (!ready && !destroyed) { status.textContent = '工作区未能及时载入。请返回后重试，原节点结果未改变。'; notify(status.textContent); }
  }, 20000);
  function receive(event) {
    if (destroyed || event.origin !== location.origin || event.source !== iframe.contentWindow) return;
    const message = event.data;
    if (!message || message.channel !== channel || message.workflowId !== workflow.id || message.nodeId !== node.id) return;
    if (message.type === 'relic-node-ready') {
      iframe.contentWindow.postMessage({ type: 'relic-node-init', channel, workflowId: workflow.id, nodeId: node.id, mode, input: source,
        title: workflow.title || '节点服装方案', settings: node.params || node.config || node.settings || {}, constraints: workflow.constraints || {} }, location.origin);
    } else if (message.type === 'relic-node-loaded') {
      ready = true; clearTimeout(timeout); save.disabled = false;
      lensMessage('relic-node-magnifier-auto', { active: automaticLensActive });
      status.textContent = mode === 'mapping' ? '上传同一衣片的实拍平铺图，核对对应点后生成映射；保存会带回真实映射资产。' : '16 种子笔刷、保护区域、褶皱贴合与背景开关均可使用。保存不会调用付费生图。';
    } else if (message.type === 'relic-node-output') {
      saving = false; save.disabled = false;
      if (message.output?.kind !== 'garment' || !localImage(message.output.imageUrl)) { status.textContent = '输出没有有效的本机图片地址，未更新节点。'; return; }
      status.textContent = '输出已保存。'; onCommit(message.output);
    } else if (message.type === 'relic-node-error') {
      clearTimeout(timeout); saving = false; save.disabled = !ready; status.textContent = String(message.message || '工作区未完成本次操作。'); notify(status.textContent);
    } else if (message.type === 'relic-node-close') onClose();
  }
  window.addEventListener('message', receive);
  return {
    iframe, save() { save.click(); }, setAutomaticActive,
    setMagnifierEnabled(enabled) { lensMessage('relic-node-magnifier-enable', { enabled: Boolean(enabled) }); },
    setMagnifierZoom(zoom) { lensMessage('relic-node-magnifier-zoom', { zoom }); },
    destroy() { destroyed = true; automaticLensActive = false; proximitySensor?.destroy(); proximitySensor = null; clearTimeout(timeout); window.removeEventListener('message', receive); iframe.src = 'about:blank'; root.remove(); },
  };
}

/** Real manual garment part selection, deliberately not labelled semantic segmentation. */
function openManualParts(container, { node, source, onCommit, onClose, notify }) {
  let disposed = false, draft = null, pointer = null, saving = false;
  const parts = structuredClone(node.params?.parts || node.config?.parts || source.parts || []);
  const root = document.createElement('section'); root.className = 'ns-manual-parts';
  root.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:20px;min-height:500px';
  const board = document.createElement('div'); board.style.cssText = 'display:flex;align-items:flex-start;justify-content:center;min-width:0;background:#102830;border-radius:12px;padding:16px;overflow:auto';
  const canvas = document.createElement('canvas'); canvas.tabIndex = 0; canvas.setAttribute('aria-label', '拖动框选真实服装部件，之后填写部件名称');
  canvas.style.cssText = 'max-width:100%;max-height:72vh;object-fit:contain;touch-action:none;cursor:crosshair'; board.append(canvas);
  const panel = document.createElement('aside');
  const heading = document.createElement('h3'); heading.textContent = '手动分件';
  const help = document.createElement('p'); help.textContent = '在照片上框选披风、内搭等部件。这里保存真实选区与裁切参考，不会自动补全遮挡，也不是服装裁片。';
  const name = document.createElement('input'); name.placeholder = '部件名称，例如：披风'; name.setAttribute('aria-label', '部件名称'); name.maxLength = 60;
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = '正在读取服装图片…';
  const list = document.createElement('div');
  const add = button('添加当前部件', () => {
    if (!draft || draft.w < .005 || draft.h < .005) { status.textContent = '请先框选一块有面积的部件范围。'; return; }
    if (draft.w * image.naturalWidth < 32 || draft.h * image.naturalHeight < 32) { status.textContent = '选区太小；每个部件至少需要 32 × 32 个原图像素，请扩大范围。'; return; }
    if (!name.value.trim()) { status.textContent = '请给部件填写名称。'; name.focus(); return; }
    if (parts.length >= 16) { status.textContent = '一次最多保存 16 个手动部件。'; return; }
    parts.push({ id: crypto.randomUUID(), name: name.value.trim(), rect: { ...draft }, method: 'manual_rectangle', coordinateSpace: 'source_normalized', needsSilhouetteRefinement: true });
    draft = null; name.value = ''; renderList(); draw(); status.textContent = '部件已添加；仍可继续添加或删除。';
  });
  const image = new Image();
  async function uploadPart(part) {
    const crop = document.createElement('canvas');
    const x = Math.round(part.rect.x * image.naturalWidth), y = Math.round(part.rect.y * image.naturalHeight);
    crop.width = Math.max(1, Math.round(part.rect.w * image.naturalWidth)); crop.height = Math.max(1, Math.round(part.rect.h * image.naturalHeight));
    crop.getContext('2d').drawImage(image, x, y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    const blob = await new Promise((resolve, reject) => crop.toBlob(value => value ? resolve(value) : reject(new Error('部件图片未能导出。')), 'image/png'));
    const form = new FormData(); form.append('file', blob, 'garment-part.png');
    const response = await fetch('/api/uploads', { method: 'POST', body: form });
    if (!response.ok) throw new Error('部件图片未能保存，请缩小选区数量后重试。');
    const asset = await response.json(); return { ...part, imageUrl: asset.url, width: asset.width, height: asset.height, sourceImageUrl: source.imageUrl,
      parentWidth: image.naturalWidth, parentHeight: image.naturalHeight, parentProjectId: source.projectId || null };
  }
  const save = button('保存分件并返回节点', async () => {
    if (saving || disposed) return;
    if (!parts.length) { status.textContent = '请先添加至少一个部件。'; return; }
    saving = true; save.disabled = true; status.textContent = '正在保存分件位置与裁切参考…';
    try {
      const outputParts = [];
      for (const part of parts) outputParts.push(await uploadPart(part));
      if (disposed) return;
      onCommit({ ...source, kind: 'garment', imageUrl: source.imageUrl, parts: outputParts,
        selectedPartId: outputParts[0].id, segmentation: { method: 'manual_rectangle', completeSilhouette: false, inferredHiddenAreas: false },
        warnings: ['矩形分件保留原图可见像素，可能包含背景或遮挡；未生成缝纫裁片，也未推测隐藏衣物。'] });
    } catch (error) { status.textContent = error.message; notify(error.message); }
    finally { saving = false; save.disabled = false; }
  });
  panel.append(heading, help, name, add, status, list, save, button('返回总览', onClose)); root.append(board, panel); container.append(root);
  function draw() {
    if (!image.complete || !image.naturalWidth) return;
    const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    [...parts, ...(draft ? [{ rect: draft, name: '当前选区' }] : [])].forEach((part, i) => {
      const r = part.rect, x = r.x * canvas.width, y = r.y * canvas.height, w = r.w * canvas.width, h = r.h * canvas.height;
      ctx.fillStyle = '#b4d9ca22'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = '#d6e4b1'; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = '#102b33'; ctx.fillRect(x, y, Math.min(w, 220), 25); ctx.fillStyle = '#fff'; ctx.font = '14px sans-serif'; ctx.fillText(`${i + 1} ${part.name}`, x + 5, y + 18, Math.max(10, w - 10));
    });
  }
  function renderList() {
    list.replaceChildren();
    parts.forEach((part, i) => { const row = document.createElement('p'); const label = document.createElement('span'); label.textContent = `${i + 1}. ${part.name} `;
      row.append(label, button('移除', () => { parts.splice(i, 1); renderList(); draw(); })); list.append(row); });
  }
  function point(event) { const b = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - b.left) / b.width)), y: Math.max(0, Math.min(1, (event.clientY - b.top) / b.height)) }; }
  canvas.addEventListener('pointerdown', event => { if (event.button !== 0 || !image.naturalWidth || saving) return; pointer = point(event); canvas.setPointerCapture(event.pointerId); event.preventDefault(); });
  canvas.addEventListener('pointermove', event => { if (!pointer) return; const p = point(event); draft = { x: Math.min(p.x, pointer.x), y: Math.min(p.y, pointer.y), w: Math.abs(p.x - pointer.x), h: Math.abs(p.y - pointer.y) }; draw(); });
  canvas.addEventListener('pointerup', event => { pointer = null; if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); });
  canvas.addEventListener('pointercancel', () => { pointer = null; draft = null; draw(); });
  image.onload = () => { if (disposed) return; const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight)); canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale); draw(); status.textContent = '拖动框选部件，再输入名称并添加。'; };
  image.onerror = () => { status.textContent = '服装图片暂时无法读取，请返回检查上游输出。'; }; image.src = source.imageUrl;
  renderList();
  return { save() { save.click(); }, destroy() { disposed = true; image.onload = image.onerror = null; root.remove(); } };
}
