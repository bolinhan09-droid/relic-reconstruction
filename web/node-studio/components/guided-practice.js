import {escape, icon} from './icons.js';

const STORAGE = 'relic-guided-practice-v1';
const STEPS = ['open', 'draw', 'save', 'return', 'result', 'done'];
const CONTENT = {
  open: ['进入一个节点', '这份练习已连好：服装输入 → 精致修改 → 制作指导。双击「精致修改」标签，就能进去画', '打开精修'],
  draw: ['在衣服上画一笔', '先试默认血迹笔刷：在衣服上按住，朝一个方向拖动后松开。也可以在左侧换笔刷，画错了可以撤销', '画一笔后继续'],
  save: ['把修改保存为输出', '点击工作区右上角「保存」。保存的是当前节点的效果，后面的节点会接到这份结果', '保存这一步'],
  return: ['回到创作路线', '保存成功了。按 Esc 或点击「返回总览」，查看标签里更新后的衣服', '返回总览'],
  result: ['让下一步读取结果', '精修标签已经有了输出。双击「制作指导」，看看它接到的是不是刚才那件衣服', '查看制作节点'],
  done: ['你已走通一次创作', '现在可以上传自己的照片。需要 AI 时，再到顶部统一配置；画布连接本身不会调用模型', '完成练习'],
};

function readProgress() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE) || '{}');
    return {workflowId: typeof value.workflowId === 'string' ? value.workflowId : '',
      step: STEPS.includes(value.step) ? value.step : 'open', completed: !!value.completed, dismissed: !!value.dismissed};
  } catch { return {workflowId:'', step:'open', completed:false, dismissed:false}; }
}

/** Optional, non-modal practice. Only observes state; all mutations go through
 * the same app actions used by the ordinary workspace. Never runs an AI node. */
export function createGuidedPractice({getState, prepare, openNode, saveEditor, leaveEditor, focusNode, notify}) {
  let progress = readProgress(), active = false, starting = false, busy = false;
  let index = 0, highest = 0, reviewing = false, collapsed = false, timer = null, previousFocus = null;
  let savedOutput = false;
  const panel = document.createElement('aside'); panel.id = 'practiceGuide'; panel.className = 'ns-practice-guide';
  panel.hidden = true; panel.setAttribute('aria-label','新手练习');
  const marker = document.createElement('div'); marker.className = 'ns-practice-highlight'; marker.hidden = true; marker.setAttribute('aria-hidden','true');
  document.body.append(marker, panel);

  function store() {
    try { localStorage.setItem(STORAGE, JSON.stringify(progress)); } catch { /* Practice still works when storage is unavailable. */ }
  }
  function refreshOffer() {
    const button = document.getElementById('startPracticeButton');
    if (button) { button.disabled = starting; button.textContent = starting ? '正在准备练习…' : progress.completed ? '重做新手练习' : progress.workflowId ? '继续新手练习' : '跟着示例做一遍'; }
    const copy = document.getElementById('practiceOfferCopy');
    if (copy) copy.textContent = progress.completed ? '随时从帮助重新练习，也可以直接上传自己的服装' : '示例服装 · 无需 API · 画一笔，学会保存和传递输出';
  }
  function setStep(next) {
    if (index === next) return;
    index = next; highest = Math.max(highest, next); reviewing = false;
    progress.step = STEPS[next]; store(); render();
  }
  function ids(state) {
    const nodes = state.workflow?.nodes || [];
    return {edit: nodes.find(n => n.type === 'precision_edit')?.id, next: nodes.find(n => n.type === 'production_guide')?.id};
  }
  function currentOutput(state) {
    const edit = state.workflow?.nodes.find(n => n.type === 'precision_edit');
    return Boolean(edit?.output?.imageUrl && edit?.output?.projectSnapshot?.brushStrokes?.length);
  }
  function tick() {
    if (!active) return;
    const state = getState();
    if (state.workflow?.id !== progress.workflowId) { stop(false, true); return; }
    const nodeIds = ids(state);
    savedOutput ||= currentOutput(state);
    if (!busy && !reviewing) {
      if (index === 0 && state.workspaceId === nodeIds.edit && state.ready) setStep(1);
      else if (index === 1 && state.workspaceId === nodeIds.edit && state.strokeCount > 0) setStep(2);
      else if (index === 2 && currentOutput(state) && !state.unsaved) setStep(3);
      else if (index === 3 && !state.workspaceId && savedOutput) setStep(4);
      else if (index === 4 && state.workspaceId === nodeIds.next) setStep(5);
    }
    positionHighlight(state);
    syncAction(state);
  }
  function syncAction(state = getState()) {
    const button = panel.querySelector('#practiceAction');
    if (!button) return;
    const step = STEPS[index], awayFromEditor = state.workspaceId !== ids(state).edit;
    const needsEditor = (step === 'draw' || step === 'save') && awayFromEditor;
    button.disabled = busy || (step === 'draw' && !reviewing && !awayFromEditor);
    button.textContent = busy ? '请稍候…' : reviewing && index < highest ? '继续' : needsEditor ? '回到精修' : CONTENT[step][2];
  }
  function positionHighlight(state) {
    if (collapsed || document.querySelector('dialog[open]')) { marker.hidden = true; return; }
    const nodeIds = ids(state), step = STEPS[index]; let target = null;
    if (step === 'open' && !state.workspaceId) target = document.querySelector(`[data-preview="${CSS.escape(nodeIds.edit || '')}"]`);
    if (step === 'save') target = document.getElementById('saveWorkspace');
    if (step === 'return') target = document.getElementById('leaveWorkspace');
    if (step === 'result' && !state.workspaceId) target = document.querySelector(`[data-preview="${CSS.escape(nodeIds.next || '')}"]`);
    if (!target || !target.getClientRects().length) { marker.hidden = true; return; }
    const rect = target.getBoundingClientRect();
    if (rect.right <= 0 || rect.left >= innerWidth || rect.bottom <= 0 || rect.top >= innerHeight) { marker.hidden = true; return; }
    marker.hidden = false;
    Object.assign(marker.style, {left: `${rect.left - 4}px`, top: `${rect.top - 4}px`, width: `${rect.width + 8}px`, height: `${rect.height + 8}px`});
  }
  async function action() {
    if (busy) return;
    if (reviewing && index < highest) { index++; reviewing = index < highest; render(); return; }
    const state = getState(), nodeIds = ids(state), step = STEPS[index];
    busy = true; render();
    try {
      if (step === 'open') await openNode(nodeIds.edit);
      else if (step === 'draw' && state.workspaceId !== nodeIds.edit) await openNode(nodeIds.edit);
      else if (step === 'save') {
        if (state.workspaceId !== nodeIds.edit) await openNode(nodeIds.edit);
        else await saveEditor();
      } else if (step === 'return') await leaveEditor();
      else if (step === 'result') await openNode(nodeIds.next);
      else if (step === 'done') { stop(true); return; }
    } catch (error) { notify(error.message || '这一步未完成，可以重试'); }
    finally { busy = false; if (active) { render(); tick(); } }
  }
  function render() {
    if (!active) return;
    const step = STEPS[index], [title, description, label] = CONTENT[step];
    panel.dataset.step = step; panel.classList.toggle('is-collapsed', collapsed);
    panel.innerHTML = `<div class="ns-practice-heading"><span>${icon('book')} 新手练习 <small>${Math.min(index + 1, 5)} / 5</small></span><button id="practiceCollapse" type="button" class="ns-icon-button" aria-label="${collapsed ? '展开教学' : '收起教学'}" aria-expanded="${!collapsed}">${collapsed ? '+' : '−'}</button></div>
      <div class="ns-practice-body" ${collapsed ? 'hidden' : ''}><h3 id="practiceTitle" aria-live="polite">${escape(title)}</h3><p>${escape(description)}</p>
      <div class="ns-practice-progress" aria-hidden="true">${Array.from({length:5},(_,i)=>`<i class="${i < index ? 'done' : i === index ? 'current' : ''}"></i>`).join('')}</div>
      <button type="button" class="ns-button ns-primary" id="practiceAction" ${busy || (step === 'draw' && !reviewing) ? 'disabled' : ''}>${busy ? '请稍候…' : reviewing && index < highest ? '继续' : escape(label)}</button>
      ${step === 'draw' ? '<p class="ns-practice-tip">左侧参数可滚动查看，画布不会跟着滚动</p>' : ''}
      <div class="ns-practice-navigation"><button type="button" class="ns-button ns-quiet" id="practiceBack" ${index === 0 || busy ? 'disabled' : ''}>上一步</button><button type="button" class="ns-button ns-quiet" id="practiceSkip" ${busy ? 'disabled' : ''}>结束教学</button></div></div>`;
    panel.querySelector('#practiceAction').onclick = action;
    panel.querySelector('#practiceBack').onclick = () => { index = Math.max(0,index-1); reviewing = true; render(); };
    panel.querySelector('#practiceSkip').onclick = () => stop(false);
    panel.querySelector('#practiceCollapse').onclick = () => { collapsed = !collapsed; render(); };
    syncAction();
  }
  async function start() {
    if (starting || busy) return;
    if (active) { collapsed = false; render(); panel.querySelector('#practiceCollapse').focus(); return; }
    starting = true; refreshOffer(); previousFocus = document.activeElement;
    try {
      const state = await prepare(progress.completed ? '' : progress.workflowId);
      if (!state?.workflow?.id) throw Error('练习尚未准备好，请稍后重试');
      const resumed = state.workflow.id === progress.workflowId;
      index = resumed ? Math.max(0, STEPS.indexOf(progress.step)) : 0;
      // Resume from the actual editor state instead of claiming a lost draft exists.
      savedOutput = currentOutput(state);
      if (index > 0 && !savedOutput) index = 0;
      else if (savedOutput && index < 3) index = 4;
      if (index === 3 && !state.workspaceId) index = 4;
      highest = index; reviewing = false; collapsed = false;
      progress = {workflowId: state.workflow.id, step: STEPS[index], completed:false, dismissed:false}; store();
      active = true; panel.hidden = false; document.body.classList.add('ns-practicing'); render();
      focusNode(index >= 4 ? ids(state).next : ids(state).edit);
      timer = setInterval(tick, 250); tick(); panel.querySelector('#practiceCollapse').focus({preventScroll:true});
    } catch (error) { notify(error.message || '练习暂时未能打开'); }
    finally { starting = false; refreshOffer(); }
  }
  function stop(completed = false, silent = false) {
    active = false; clearInterval(timer); timer = null; panel.hidden = true; marker.hidden = true;
    document.body.classList.remove('ns-practicing'); progress.completed = completed; progress.dismissed = !completed;
    progress.step = STEPS[highest]; store(); refreshOffer();
    if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus({preventScroll:true});
    if (!silent) notify(completed ? '练习完成，可上传自己的服装开始创作' : '已结束教学，练习保留在「我的创作」');
  }
  document.getElementById('startPracticeButton')?.addEventListener('click', () => void start());
  document.getElementById('restartPracticeButton')?.addEventListener('click', () => { document.getElementById('helpDialog')?.close(); void start(); });
  window.addEventListener('pagehide', () => { clearInterval(timer); });
  refreshOffer();
  return {start, stop, refreshOffer, getState: () => ({active, step:STEPS[index], workflowId:progress.workflowId, completed:progress.completed})};
}
