import { createWorkspace, el, field, actions, notice, assetURL, currentOutput } from './shared.js';
import { saveDownload } from '../core/api.js';

const sideLabels = { front: '正面', back: '背面' };
const list = value => Array.isArray(value) ? value : value ? [value] : [];

function ensureStyles() {
  if (!document.querySelector('link[data-making-kit]')) document.head.append(el('link', {
    rel: 'stylesheet', href: new URL('./making-kit.css', import.meta.url).href, 'data-making-kit': 'true'
  }));
}

function fileLink(value, label) {
  const url = assetURL(typeof value === 'string' ? value : value?.url);
  if (!url) return null;
  const link = el('a', { href: url, class: 'ns-button', download: '', text: label || value.label || '下载文件' });
  link.addEventListener('click', async event => {
    if (!window.pywebview?.api?.save_export) return;
    event.preventDefault(); if (link.dataset.busy) return; link.dataset.busy = 'true';
    try { await saveDownload(url, typeof value === 'object' && value.name || url.split('/').pop().split('?')[0]); }
    catch (error) { link.after(el('p', { class: 'ns-kit-validation', role: 'alert', text: error.message || '下载未完成，请重试' })); }
    finally { delete link.dataset.busy; }
  });
  return link;
}

function paragraphs(title, values, ordered = false) {
  const rows = list(values).filter(Boolean);
  if (!rows.length) return null;
  return el('div', { class: 'ns-kit-instruction' }, el('h5', { text: title }),
    el(ordered ? 'ol' : 'ul', {}, rows.map(row => el('li', { text: typeof row === 'string' ? row : row.text || row.label || row.message || '' }))));
}

/** Rendering follows garment part → effect → operation; fabrication order is supplied by the backend. */
export function renderMakingKit(host, value) {
  host.replaceChildren();
  if (!value) { host.append(notice('生成后，在这里按衣片查看模板、操作步骤和检查要点')); return; }
  if (value.kind !== 'making_kit') {
    host.append(notice('这是旧版输出，仅保留文件查看。重新生成后才会获得按笔刷拆分的模板和完整制作说明'));
    host.append(actions(...list(value.files || value.downloads).map(file => fileLink(file)), fileLink(value.downloadUrl, '下载旧版输出')));
    return;
  }
  const stages = list(value.stages), parts = list(value.parts);
  const allSteps = parts.flatMap(part => list(part.effects).flatMap(effect => list(effect.steps)));
  const withTemplate = allSteps.filter(step => step.template?.cuttable === true);
  host.append(el('div', { class: 'ns-kit-result-heading' },
    el('h3', { text: '你的制作包' }), el('p', { text: `${parts.length} 个衣片 · ${withTemplate.length} 个工序含模板 · ${allSteps.length} 个效果工序` })),
  actions(fileLink(value.downloadUrl, '下载完整制作包 ZIP'), fileLink(value.manualUrl, '下载制作说明书'),
    ...list(value.files).filter(file => file.kind === 'registration' || /定位/.test(file.label || '')).slice(0, 2).map(file => fileLink(file))));

  if (value.calibration) host.append(el('p', { class: 'ns-kit-source', text: `整图实测范围 ${value.calibration.widthMm} × ${value.calibration.heightMm} mm · 每张模板共用定位基准` }));
  if (stages.length) {
    const sequence = el('details', { class: 'ns-kit-sequence', open: true }, el('summary', { text: '先看实际制作顺序' }));
    sequence.append(el('ol', {}, stages.map((stage, index) => {
      const jump = el('button', { type: 'button', class: 'ns-kit-stage-link', text: stage.title || `第 ${index + 1} 步` });
      jump.addEventListener('click', () => {
        const target = [...host.querySelectorAll('[data-step-id]')].find(item => item.dataset.stepId === stage.id);
        if (!target) return; target.closest('details').open = true; target.dispatchEvent(new CustomEvent('relic:reveal', {bubbles:true}));
        target.tabIndex = -1; target.focus({ preventScroll: true });
      });
      return el('li', {}, jump, stage.checkpoint ? el('span', { text: stage.checkpoint }) : null);
    })));
    host.append(sequence);
  }
  const order = new Map(stages.map((stage, index) => [stage.id, stage.order ?? index + 1]));
  parts.forEach(part => {
    const section = el('section', { class: 'ns-kit-part' }, el('h3', { text: `${part.name || '衣片'} · ${sideLabels[part.side] || part.side || '待核对正反面'}` }));
    list(part.effects).forEach((effect, effectIndex) => {
      const effectDetails = el('details', { class: 'ns-kit-effect', open: effectIndex === 0 },
        el('summary', {}, el('span', { text: effect.label || '效果' }), el('small', { text: `${list(effect.steps).length} 道工序` })));
      list(effect.steps).forEach(step => {
        const files = list(step.files), previews = files.filter(file => file.kind === 'svg' || /\.svg(?:\?|$)/i.test(file.url || ''));
        const row = el('section', { class: 'ns-kit-step', dataset: { stepId: step.id } }, el('h4', {},
          el('span', { class: 'ns-kit-step-number', text: String(order.get(step.id) ?? step.order ?? '·') }), step.title || '操作步骤'),
          el('p', { class: 'ns-kit-method', text: step.template?.cuttable ? '可切割模板 · 按定位基准放置' : '手工工序 · 描线图只定位，不用于切割' }));
        if (previews[0] && assetURL(previews[0].url)) row.append(el('figure', { class: 'ns-kit-template' },
          el('img', { src: assetURL(previews[0].url), alt: `${step.title || '本步'}模板预览`, loading: 'lazy' }),
          el('figcaption', { text: '预览不代表打印尺寸 · 按 100% 比例打印并核对校验线' })));
        row.append(paragraphs('准备工具', step.tools), paragraphs('怎么做', step.actions, true));
        if (step.checkpoint) row.append(el('p', { class: 'ns-kit-checkpoint' }, el('strong', { text: '做到这里 ' }), step.checkpoint));
        const index = stages.findIndex(stage => stage.id === step.id), next = index >= 0 ? stages[index + 1] : null;
        if (next || step.next) row.append(el('p', { class: 'ns-kit-next', text: `下一步：${next?.title || step.next}` }));
        if (files.length) row.append(actions(...files.map(file => fileLink(file))));
        effectDetails.append(row);
      });
      section.append(effectDetails);
    });
    host.append(section);
  });
  const extraFiles = list(value.files).filter(file => !['registration'].includes(file.kind) && !/定位/.test(file.label || ''));
  if (extraFiles.length) host.append(el('details', { class: 'ns-kit-sequence' }, el('summary', { text: '全部文件与拼页打印' }), actions(...extraFiles.map(file => fileLink(file)))));
  const notes = el('details', { class: 'ns-kit-sequence' }, el('summary', { text: '制作前核对' }),
    notice('模板用于定位和遮挡，不是缝纫裁片。先用同材质小样验证；干燥后的渗色、手感与画面可能不同。'), paragraphs('本次方案说明', value.warnings));
  host.append(notes);
}

export async function makingKitWorkspace(container, context) {
  ensureStyles();
  const ws = createWorkspace(container, context, { title: '把映射后的效果变成制作包',
    description: '从已映射的真实平铺衣片读取笔刷，按衣片、效果、工序整理模板和制作说明。先核对实测尺寸，再打印打样。' });
  ws.root.classList.add('ns-making-kit'); ws.root.dataset.arranged = 'true';
  ws.outputDetails.hidden = true;
  let inspection = null, running = false, result = context.node.output, requestNumber = 0;
  const stage = el('section', { class: 'ns-kit-stage', 'aria-label': '映射预览与制作步骤' });
  const imagePanel = el('section', { class: 'ns-kit-panel', id: `making-preview-${context.node.id}`, role: 'tabpanel' });
  const imageContent = el('div', {class:'ns-kit-image-content'}); imagePanel.append(imageContent);
  const resultPanel = el('section', { class: 'ns-kit-panel', id: `making-result-${context.node.id}`, role: 'tabpanel', hidden: true });
  const staleNotice = notice('设置已更改，当前显示上一次制作包，请重新生成后制作'); staleNotice.hidden = true;
  const resultHost = el('div', { class: 'ns-kit-results' }); resultPanel.append(staleNotice, resultHost);
  const tabs = el('div', { class: 'ns-kit-tabs', role: 'tablist', 'aria-label': '制作包内容' });
  const previewTab = el('button', { type: 'button', role: 'tab', text: '映射预览', 'aria-controls': imagePanel.id });
  const resultTab = el('button', { type: 'button', role: 'tab', text: '制作步骤', 'aria-controls': resultPanel.id });
  function showTab(which) {
    imagePanel.hidden = which !== 'preview'; resultPanel.hidden = which !== 'result';
    [previewTab, resultTab].forEach((tab, index) => { const active = (which === 'preview') === (index === 0); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; });
  }
  for (const [tab, which] of [[previewTab, 'preview'], [resultTab, 'result']]) {
    ws.on(tab, 'click', () => showTab(which));
    ws.on(tab, 'keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? previewTab : event.key === 'End' ? resultTab : tab === previewTab ? resultTab : previewTab;
      showTab(next === previewTab ? 'preview' : 'result'); next.focus();
    });
  }
  tabs.append(previewTab, resultTab); stage.append(tabs, imagePanel, resultPanel);
  const controls = el('aside', { class: 'ns-kit-controls', 'aria-label': '制作包设置' });
  const readiness = el('section', { class: 'ns-kit-readiness', 'aria-live': 'polite' });
  const refresh = ws.button('重新检查输入', () => inspect());
  const provenance = el('p', { class: 'ns-kit-source' });
  controls.append(el('h3', { text: '1 核对输入' }), provenance, readiness, actions(refresh));
  const side = field(ws, 'side', '这一片的哪一面', { value: ws.params.side || 'front', options: [{ value: 'front', label: '正面' }, { value: 'back', label: '背面' }] });
  const material = field(ws, 'material', '表面大致是什么', { value: ws.params.material || 'unknown', options: [{ value: 'unknown', label: '不确定 · 先做小样' }, { value: 'fabric', label: '布料' }, { value: 'coated', label: '皮革感 / 有涂层' }] });
  controls.append(side.group, material.group, el('h3', { text: '2 确认实物尺寸' }));
  const width = field(ws, 'widthMm', '整张照片实际宽度（mm）', { type: 'number', min: 20, max: 2000, step: .1, placeholder: '实测宽度', value: ws.params.widthMm || '' });
  const height = field(ws, 'heightMm', '整张照片实际高度（mm）', { type: 'number', min: 20, max: 2000, step: .1, placeholder: '实测高度', value: ws.params.heightMm || '' });
  const scaleError = el('p', { class: 'ns-kit-validation', role: 'status', hidden: true });
  const calculateHeight = ws.button('按照片比例计算高度', () => {
    const source = inspection?.source;
    if (!source?.width || !source?.height || !Number(width.control.value)) throw Error('先填入实测宽度，再按照片比例计算');
    const value = Math.round(Number(width.control.value) * source.height / source.width * 10) / 10;
    height.control.value = value; height.control.dispatchEvent(new Event('input', { bubbles: true }));
    scaleError.hidden = true; ws.say('高度已按照片比例计算，请核对照片拍摄时是否正对平铺衣片');
  });
  controls.append(notice('填写整张平铺照片覆盖的范围，包含四周留白，不是衣服本身的宽高。照片须正对衣片拍摄；可实测整图宽度后按比例计算高度。'),
    el('div', { class: 'ns-ws-form-grid' }, width.group, height.group), actions(calculateHeight), scaleError);
  const bridge = field(ws, 'bridgeMm', '连接桥宽度（mm）', { type: 'number', min: 1, max: 10, step: .5, value: ws.params.bridgeMm || 2, help: '连接悬空区域，避免剪开后小块脱落' });
  const detail = field(ws, 'minFeatureMm', '最小细节（mm）', { type: 'number', min: .5, max: 10, step: .5, value: ws.params.minFeatureMm || 2, help: '过小的细节会被简化，并在制作说明中提示补做' });
  controls.append(el('details', { class: 'ns-kit-advanced' }, el('summary', { text: '模板细节参数' }), bridge.group, detail.group));
  const generate = el('button', { type: 'button', class: 'ns-button is-primary', text: '生成模板与制作说明', disabled: true });
  const gate = el('p', { class: 'ns-kit-gate', 'aria-live': 'polite' });
  controls.append(el('div', { class: 'ns-kit-generate' }, generate, gate));
  ws.body.append(stage, controls);

  function validDimensions() { return [width, height].every(item => item.control.value !== '' && Number(item.control.value) >= 20 && Number(item.control.value) <= 2000); }
  function validRatio() {
    const source = inspection?.source;
    return !source?.width || !source?.height || !validDimensions() || Math.abs(Number(width.control.value) / Number(height.control.value) / (source.width / source.height) - 1) <= .03;
  }
  function validDetails() { return [bridge, detail].every(item => item.control.value !== '' && item.control.checkValidity()); }
  function updateGate() {
    const message = !inspection ? '正在检查前一步' : !inspection.ready ? '先完成上方提示的前置步骤' : !validDimensions() ? '填写实测宽高（20–2000 mm）' : !validRatio() ? '宽高比例与照片不符，请核对整图范围' : !validDetails() ? '请检查模板细节参数' : '按笔刷自动拆分模板，其他工序附操作说明';
    generate.disabled = running || !inspection?.ready || !validDimensions() || !validRatio() || !validDetails();
    gate.textContent = running ? '正在整理工序和生成本机文件…' : message;
    refresh.disabled = running;
    calculateHeight.disabled = running || !inspection?.source?.width;
  }
  for (const item of [side, material, width, height, bridge, detail]) {
    ws.on(item.control, item.control.type === 'number' ? 'input' : 'change', () => {
      if (item === width || item === height) { ws.patch({ scaleConfirmed: false }); }
      if (result) staleNotice.hidden = false;
      updateGate();
    });
  }
  for (const item of [width, height]) ws.on(item.control, 'blur', () => {
    const bad = item.control.value !== '' && !item.control.checkValidity();
    item.control.setAttribute('aria-invalid', String(bad)); scaleError.hidden = !bad;
    scaleError.textContent = bad ? '请输入 20–2000 mm 范围内的实测尺寸' : '';
  });
  ws.on(generate, 'click', async () => {
    if (generate.disabled) return;
    running = true; generate.textContent = '正在生成制作包…'; updateGate();
    const inputs = [...controls.querySelectorAll('input,select')]; inputs.forEach(input => input.disabled = true);
    try {
      ws.patch({flatConfirmed:true,scaleConfirmed:true,sourceMappingId:inspection.source.mappingId});
      const response = await ws.run(); if (ws.signal.aborted) return;
      result = currentOutput(context, response); renderMakingKit(resultHost, result); ws.outputDetails.hidden = true;
      staleNotice.hidden = true; showTab('result'); resultPanel.scrollTop = 0;
      ws.say('制作包已生成，可以下载模板和说明书');
    } catch (error) { ws.say(error.message || '生成未完成，请检查输入后重试', true); }
    finally { if (!ws.signal.aborted) { running = false; inputs.forEach(input => input.disabled = false); generate.textContent = '生成模板与制作说明'; updateGate(); } }
  });

  async function inspect() {
    const number = ++requestNumber;
    inspection = null; updateGate(); readiness.replaceChildren(el('p', { text: '检查映射、平铺照片和笔刷记录…' }));
    try {
      await ws.save(); if (ws.signal.aborted) return;
      const flow = context.getWorkflow?.() || context.workflow;
      const data = await context.api('GET', `/api/node-studio/workflows/${encodeURIComponent(flow.id)}/nodes/${encodeURIComponent(context.node.id)}/making-input`);
      if (ws.signal.aborted || number !== requestNumber) return;
      inspection = data;
      const source = data.source || {};
      if (ws.params.sourceMappingId !== source.mappingId) {
        width.control.value=''; height.control.value=''; ws.patch({widthMm:'',heightMm:'',sourceMappingId:source.mappingId||''});
        ws.patch({ flatConfirmed: false, scaleConfirmed: false });
        if (result) staleNotice.hidden = false;
      }
      provenance.textContent = source.componentName || data.sourceNodeLabel || '当前连接的前一步';
      readiness.replaceChildren(...list(data.checks).map(check => el('div', { class: `ns-kit-check ${check.ok ? 'is-ready' : 'is-missing'}` },
        el('strong', { text: `${check.ok ? '已具备' : '待完成'} · ${check.label}` }), check.message ? el('span', { text: check.message }) : null)));
      if (list(data.issues).length) readiness.append(paragraphs('需要完成', data.issues));
      if (context.openNode && data.sourceNodeId && data.sourceNodeId !== context.node.id) readiness.append(actions(ws.button('返回前一步核对', () => context.openNode(data.sourceNodeId))));
      imageContent.replaceChildren();
      const preview = source.mappedImageUrl || source.flatImageUrl;
      if (assetURL(preview)) imageContent.append(ws.preview(preview, '映射后的实拍平铺衣片 · 核对痕迹位置和正反面'));
      else imageContent.append(el('div', { class: 'ns-kit-empty' }, el('h3', { text: '先完成衣片展平与痕迹映射' }), el('p', { text: '把同一衣片的真实平铺照片接入映射节点，核对位置并保存，再连接到这里' })));
      if (list(source.brushSummary).length) imageContent.append(el('section', { class: 'ns-kit-brushes' }, el('h3', { text: '读取到的效果' }),
        el('ul', {}, source.brushSummary.map(brush => el('li', {}, el('span', { text: brush.label || brush.subtype || brush.type }), el('small', { text: `${brush.strokeCount ?? 0} 笔` }))))));
      if (list(data.warnings).length) imageContent.append(el('details', { class: 'ns-kit-sequence' }, el('summary', { text: '输入说明' }), paragraphs('核对事项', data.warnings)));
      ws.say(data.ready ? '平铺与映射已就绪，请核对实际尺寸' : '前一步还未就绪，请按提示补齐');
    } catch (error) {
      if (ws.signal.aborted || number !== requestNumber) return;
      inspection = { ready: false }; readiness.replaceChildren(notice(error.message || '无法读取输入，请重新检查')); ws.say('输入检查未完成', true);
    }
    updateGate();
  }
  renderMakingKit(resultHost, result); showTab(result ? 'result' : 'preview');
  await inspect(); return ws;
}

