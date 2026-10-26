import { createWorkspace, el, field, actions, inputFor, assetURL } from './shared.js';
import { createRectangleCanvas } from './canvas-selection.js';
import { assistantSettings } from './assistant-settings.js';
import { precedingNodeIds, laneForNode } from '../core/model.js';
import { intentText } from '../core/text-input.js';

const definitions = {
  intent_assist: { title: '一起把想法说清楚', label: '继续聊你的想法', action: '一起整理' },
  design_advice: { title: '一起看看下一步', label: '接下来想怎么改', action: '一起讨论' },
  design_review: { title: '审阅这一版', label: '希望重点看哪里', action: '审阅当前方案' },
  agent_execute: { title: '和助手一起修改', label: '这次一起完成什么', action: '一起修改' }
};

function loadTheme() {
  if (document.querySelector('[data-assistant-conversation-theme]')) return;
  document.head.append(el('link', { rel: 'stylesheet', href: new URL('./assistant-conversation.css', import.meta.url).href, 'data-assistant-conversation-theme': '' }));
}

export async function assistantWorkspace(container, context) {
  loadTheme();
  const definition = definitions[context.node.type], ws = createWorkspace(container, context, definition);
  const execution = context.node.type === 'agent_execute';
  ws.root.classList.add('ns-ws-wide', 'ns-assistant-v116'); ws.root.dataset.arranged = 'true'; ws.outputDetails.hidden = true;
  let latest = context.node.output || {}, working = false, timer, selection, shownUrl = '', selectionSerial = 0;
  let pages = [], pageIndex = 0;
  const workflow = () => context.getWorkflow?.() || context.workflow;
  function targetNode() {
    const flow = workflow();
    return flow.nodes.find(node => node.id === ws.params.targetNodeId)
      || flow.nodes.find(node => Object.values(node.attachments || {}).some(ids => ids.includes(context.node.id)))
      || precedingNodeIds(flow, context.node.id).reverse().map(id => flow.nodes.find(node => node.id === id)).find(node => assetURL(node?.output));
  }
  const stage = el('section', { class: 'ns-assistant-stage', 'aria-label': '当前作品' });
  const targetTitle = el('strong'), versions = el('select', { class: 'ns-input ns-assistant-versions', 'aria-label': '切回历史画面' });
  const imageHost = el('div', { class: 'ns-assistant-image-host' });
  const regionTools = actions(ws.button('撤销选区', () => selection?.undo?.()), ws.button('清除选区', () => selection?.clear?.()));
  regionTools.hidden = !execution;
  regionTools.append(el('small', { text: '框选协作位置，或直接说出想法' }));
  stage.append(el('div', { class: 'ns-assistant-target' }, targetTitle, execution ? versions : null), imageHost, regionTools);

  const side = el('aside', { class: 'ns-assistant-dialogue', 'aria-label': 'AI 协作对话' });
  const tabs = el('div', { class: 'ns-assistant-tabs', role: 'tablist', 'aria-label': '协作内容' });
  const panels = {}, panelHost = el('div', { class: 'ns-assistant-panel-host' });
  function addPanel(key, label) {
    const id = `assistant-${context.node.id}-${key}`;
    panels[key] = el('section', { class: 'ns-assistant-panel', id, role: 'tabpanel', hidden: key !== 'chat' });
    const tab = el('button', { type: 'button', role: 'tab', 'aria-controls': id, 'aria-selected': String(key === 'chat'), text: label });
    ws.on(tab, 'click', () => {
      for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== key;
      for (const item of tabs.children) item.setAttribute('aria-selected', String(item === tab));
      if (key === 'chat') requestAnimationFrame(() => renderDialogue(false));
    });
    tabs.append(tab); panelHost.append(panels[key]); return panels[key];
  }
  addPanel('chat', '讨论'); addPanel('constraints', '固定要求'); addPanel('connection', '连接');
  const transcript = el('div', { class: 'ns-assistant-transcript', 'aria-live': 'polite' });
  const counter = el('small'), previous = ws.button('上一页', () => { pageIndex--; paintDialogue(); }), next = ws.button('下一页', () => { pageIndex++; paintDialogue(); });
  panels.chat.append(transcript, el('div', { class: 'ns-assistant-dialogue-pager' }, previous, counter, next));
  const constraints = field(ws, 'confirmedConstraints', '一直保留的要求', { type: 'textarea', rows: 5, placeholder: '例如：领巾与徽记不改，只调整披风下摆' });
  constraints.control.maxLength = 1600;
  panels.constraints.append(constraints.group, el('small', { text: '可随时改写，助手在后续讨论中继续遵循' }));
  if (context.node.type === 'design_review') panels.constraints.append(field(ws, 'reviewFocus', '审阅重点', { options: [{ value: 'overall', label: '整体分布与场景' }, { value: 'preservation', label: '角色特征与保护区域' }, { value: 'production', label: '制作准备' }], value: ws.params.reviewFocus || 'overall' }).group);
  const service = await assistantSettings(ws, context);
  if (ws.signal.aborted) return ws;
  panels.connection.append(service.element);

  const textEditor = field(ws, '_intentOutput', '输出给下一步', { type: 'textarea', rows: 7, persist: false });
  textEditor.control.dataset.intentOutput = '';
  if (context.node.type === 'intent_assist') {
    const outputPanel = addPanel('output', '整理结果');
    outputPanel.append(textEditor.group, actions(ws.button('保存文字输出', async () => {
      const text = textEditor.control.value.trim();
      if (!text) throw Error('先整理想法，或写下要输出的要求');
      latest = { ...latest, kind: 'intent', title: '整理后的想法', text, textRole: 'generation_brief',
        textVersionId: crypto.randomUUID().replaceAll('-', '').slice(0, 16), userEdited: true, message: '文字输出已保存', status: 'completed' };
      await ws.commit(latest); ws.outputDetails.hidden = true;
    })));
  }
  const prompt = field(ws, 'intent', definition.label, { type: 'textarea', rows: 3, placeholder: execution ? '例如：血迹再淡一点，保留领巾' : '说出你的想法，可以接着上一轮继续聊' });
  prompt.control.maxLength = 4000;
  const progress = el('p', { class: 'ns-assistant-progress', role: 'status' });
  const run = ws.button(definition.action, () => invoke(execution ? 'execute' : 'plan'), { primary: true });
  const composer = el('div', { class: 'ns-assistant-composer' }, prompt.group, progress, actions(run));
  side.append(tabs, panelHost, composer); ws.body.append(el('div', { class: 'ns-assistant-bench' }, stage, side));
  const measure = el('p', { class: 'ns-assistant-message', 'aria-hidden': 'true', style: 'position:fixed;left:-100000px;top:0;visibility:hidden;margin:0;pointer-events:none' });
  ws.root.append(measure);

  function dialogueEntries() {
    const conversation = latest.conversation, scope = conversation?.scope;
    const flow = workflow(), target = targetNode(), lane = laneForNode(flow, target?.id);
    if (scope && scope.workflowId === flow.id && scope.nodeId === context.node.id && scope.targetNodeId === target?.id && scope.laneId === (lane?.id || 'main')) return Array.isArray(conversation.messages) ? conversation.messages : [];
    if (!conversation && latest.message) return [{ id: 'legacy', role: 'assistant', content: latest.message, state: 'discussion' }];
    return [];
  }
  function renderDialogue(goLatest = true) {
    if (ws.signal.aborted) return;
    const current = pages[pageIndex];
    if (!transcript.clientWidth || !transcript.clientHeight) return;
    const height = Math.max(23, transcript.clientHeight - 64);
    measure.style.width = `${transcript.clientWidth}px`; measure.style.font = getComputedStyle(transcript).font; measure.style.lineHeight = '23px';
    pages = [];
    for (const entry of dialogueEntries()) {
      if (!entry || !['user', 'assistant'].includes(entry.role) || typeof entry.content !== 'string') continue;
      const text = Array.from(entry.content.replace(/\n执行状态：[^\n]*$/, '').trim());
      for (let start = 0, chunk = 0; start < text.length; chunk++) {
        let low = 1, high = Math.min(500, text.length - start), fits = 1;
        while (low <= high) {
          const length = Math.floor((low + high) / 2); measure.textContent = text.slice(start, start + length).join('');
          if (measure.getBoundingClientRect().height <= height) { fits = length; low = length + 1; } else high = length - 1;
        }
        pages.push({ ...entry, content: text.slice(start, start + fits).join(''), chunk }); start += fits;
      }
    }
    const preserved = current ? pages.findIndex(item => item.id === current.id && item.chunk === current.chunk) : -1;
    const newest = pages.length ? pages.findIndex(item => item.id === pages.at(-1).id) : 0;
    pageIndex = goLatest ? newest : preserved >= 0 ? preserved : newest;
    paintDialogue();
  }
  function paintDialogue() {
    pageIndex = Math.max(0, Math.min(pageIndex, pages.length - 1));
    const entry = pages[pageIndex]; transcript.replaceChildren();
    if (entry) {
      transcript.append(el('strong', { class: 'ns-assistant-speaker', text: entry.role === 'user' ? '你' : '创作助手' }), el('p', { class: 'ns-assistant-message', text: entry.content }));
      if (entry.role === 'assistant' && entry.state === 'applied') transcript.append(el('small', { class: 'ns-assistant-applied', text: '已更新当前画面' }));
    } else transcript.append(el('p', { class: 'ns-assistant-empty', text: execution ? '直接说出想改的地方，结果会显示在左侧' : '从一个想法开始，这里会保留你们的讨论' }));
    previous.disabled = !pages.length || pageIndex === 0; next.disabled = !pages.length || pageIndex >= pages.length - 1;
    counter.textContent = pages.length ? `${pageIndex + 1} / ${pages.length}` : '本节点的讨论';
  }
  function renderVersions(target) {
    versions.replaceChildren(el('option', { value: '', text: '当前画面' }));
    const history = target?.versions || [];
    for (let index = history.length - 1; index >= 0; index--) {
      const version = history[index]; if (!version?.id || !assetURL(version.output)) continue;
      versions.append(el('option', { value: version.id, text: `版本 ${index + 1}${version.savedAt ? ' · ' + new Date(version.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}` }));
    }
    versions.disabled = working || versions.options.length < 2;
  }
  async function updateStage() {
    const target = targetNode(), source = target?.output || inputFor(context), url = assetURL(source);
    targetTitle.textContent = `协作对象 · ${target?.label || '当前作品'}`; renderVersions(target);
    if (url === shownUrl && imageHost.children.length) return;
    shownUrl = url; const serial = ++selectionSerial;
    selection?.destroy?.(); selection = null; imageHost.replaceChildren();
    if (execution) {
      const nextSelection = await createRectangleCanvas(ws, source, ws.params.regions || [], regions => ws.patch({ regions }));
      if (ws.signal.aborted || serial !== selectionSerial) { nextSelection.destroy?.(); return; }
      selection = nextSelection; imageHost.append(selection.element);
    } else imageHost.append(ws.preview(source, '当前方案'));
  }
  async function invoke(action, extra = {}) {
    if (working) return;
    const useModel = !['adopt', 'restore', 'switch_version'].includes(action);
    if (useModel && !String(ws.params.intent || '').trim() && context.node.type !== 'design_review') throw Error('先说说这次想完成什么');
    working = true; const started = Date.now();
    run.disabled = true; versions.disabled = true; prompt.control.disabled = true; constraints.control.disabled = true;
    progress.textContent = useModel ? '正在读取当前作品' : '正在切换画面';
    timer = setInterval(() => { progress.textContent = `助手正在处理 · ${Math.round((Date.now() - started) / 1000)} 秒`; }, 1000);
    try {
      const result = await ws.run({ assistantAction: action, confirmedExternal: useModel && service.isExternal(), ...extra });
      latest = result.result || result.node?.output || result; ws.outputDetails.hidden = true;
      const appliedGeometry = latest.adopted && latest.validation?.kind === 'local_garment_tool';
      const clearPrompt = useModel && latest.kind !== 'assistant_unavailable' && latest.semanticAI;
      // The old selection cannot be carried across a new garment coordinate space.
      if (appliedGeometry || latest.restored) { selection?.clear?.(); ws.patch({ regions: [] }); }
      if (clearPrompt) { prompt.control.value = ''; ws.patch({ intent: '' }); }
      if (clearPrompt || appliedGeometry || latest.restored) await ws.save();
      if (context.node.type === 'intent_assist') textEditor.control.value = intentText(latest);
      await updateStage(); renderDialogue();
      progress.textContent = appliedGeometry ? '新画面已更新，可重新框选位置' : latest.adopted ? '画面已更新，可继续聊或切回旧版' : latest.restored ? '已切回历史画面' : latest.semanticAI ? '可以接着聊' : latest.message || '已完成';
    } catch (error) {
      progress.textContent = '本次未完成，输入与之前的讨论已保留'; throw error;
    } finally {
      clearInterval(timer); working = false;
      if (!ws.signal.aborted) { run.disabled = false; prompt.control.disabled = false; constraints.control.disabled = false; renderVersions(targetNode()); }
    }
  }
  ws.on(versions, 'change', () => { if (versions.value) invoke('switch_version', { versionId: versions.value }).catch(error => ws.say(error.message, true)); });
  ws.on(prompt.control, 'keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); run.click(); } });
  const resize = new ResizeObserver(() => renderDialogue(false)); resize.observe(transcript);
  ws.cleanup(() => { clearInterval(timer); resize.disconnect(); selection?.destroy?.(); });
  textEditor.control.value = intentText(latest); await updateStage(); renderDialogue(); return ws;
}
