import { createWorkspace, el, field, actions, notice, inputFor, assetURL, renderReport } from './shared.js';
import { createRectangleCanvas } from './canvas-selection.js';
import { assistantSettings } from './assistant-settings.js';
import { precedingNodeIds } from '../core/model.js';

const definitions = {
  intent_assist: { title: '一起把想法说清楚', description: '结合当前服装与场景，整理目标、保留条件和下一步。', label: '你目前的想法', action: '一起整理想法' },
  design_advice: { title: '一起看看，下一步还能怎么改', description: '查看当前画面，讨论具体部位和候选方向。', label: '最想讨论什么', action: '看看修改建议' },
  design_review: { title: '对照前后，审阅这一版', description: '视觉模型查看原图与当前效果，大模型结合场景和修改要求解释问题。', label: '特别希望检查什么', action: '审阅当前方案' },
  agent_execute: { title: '告诉助手，你想怎么改', description: '围绕连接的节点执行修改；需要其他能力时，准备相应节点。先看候选，再决定采用。', label: '这次一起完成什么', action: '执行并预览' }
};
const tools = { adjust_strokes: '调整已有笔触', remove_strokes: '移除笔触', add_stroke: '添加痕迹', protect_region: '保护区域', create_node: '接入工作节点', run_local_tool: '运行本机工具' };

export async function assistantWorkspace(container, context) {
  const definition = definitions[context.node.type], ws = createWorkspace(container, context, definition);
  const execution = context.node.type === 'agent_execute';
  let latest = context.node.output || {}, working = false, timer;
  const flow = context.getWorkflow?.() || context.workflow;
  const host = flow.nodes.find(node => Object.values(node.attachments || {}).some(ids => ids.includes(context.node.id)));
  const target = host || flow.nodes.find(node => node.id === inputFor(context).sourceNodeId)
    || precedingNodeIds(flow, context.node.id).reverse().map(id => flow.nodes.find(node => node.id === id)).find(node => assetURL(node?.output));
  const stage = el('section', { class: 'ns-assistant-stage', 'aria-label': '作品与候选' });
  stage.append(el('div', { class: 'ns-assistant-target' }, el('strong', { text: `协作对象 · ${target?.label || '当前路线的上游作品'}` }), el('span', { text: execution ? '理解目标 → 调用工具 → 比较候选 → 采用' : '服装图片 + 已连接的场景与条件' })));
  const selection = execution ? await createRectangleCanvas(ws, inputFor(context), ws.params.regions || [], regions => ws.patch({ regions })) : null;
  stage.append(selection ? selection.element : ws.preview());
  if (selection) stage.append(actions(ws.button('撤销选区', () => selection.undo()), ws.button('清除选区', () => selection.clear())), notice('先框选协作位置，或让视觉助手定位。图片内的痕迹与可编辑笔触会分别处理。'));
  const comparison = el('section', { class: 'ns-assistant-comparison', hidden: true, 'aria-label': '执行前后对比' });
  // Keep the candidate beside adoption controls, before the large selection canvas.
  stage.insertBefore(comparison, stage.children[1] || null);
  const side = el('aside', { class: 'ns-assistant-dialogue', 'aria-label': 'AI 协作对话' });
  const transcript = el('div', { class: 'ns-assistant-transcript', 'aria-live': 'polite' });
  const prompt = field(ws, 'intent', definition.label, { type: 'textarea', rows: 4, placeholder: execution ? '例如：选中的披风下摆加少量暗红飞溅，保留领巾。需要分割时帮我接上服装分割。' : '例如：下摆的血迹是不是太密了？想更自然，同时保留角色原本的轮廓。' });
  const progress = el('p', { class: 'ns-assistant-progress', role: 'status' });
  const service = await assistantSettings(ws, context);
  if (ws.signal.aborted) return ws;
  async function invoke(action) {
    if (working) return;
    const useModel = !['adopt', 'restore'].includes(action);
    if (useModel && !String(ws.params.intent || '').trim() && context.node.type !== 'design_review') throw Error('先告诉助手，这次想完成什么。');
    working = true; const started = Date.now();
    progress.textContent = useModel ? '正在读取作品并分析任务…' : '正在保存这次选择…';
    timer = setInterval(() => { progress.textContent = `${useModel ? '助手正在处理，首次加载可能较慢' : '正在更新方案'} · ${Math.round((Date.now() - started) / 1000)} 秒`; }, 1000);
    side.querySelectorAll('button').forEach(button => button.disabled = true);
    try {
      const result = await ws.run({ assistantAction: action, ...(useModel ? {} : { runId: latest.runId }), confirmedExternal: service.isExternal() });
      latest = result.result || result.node?.output || result; renderResult(); progress.textContent = latest.message || '处理完成。';
    } finally {
      clearInterval(timer); working = false;
      if (!ws.signal.aborted) { side.querySelectorAll('button').forEach(button => button.disabled = false); updateActions(); }
    }
  }
  const run = ws.button(definition.action, () => invoke(execution ? 'preview' : 'plan'), { primary: true });
  const adopt = ws.button('采用这版修改', () => invoke('adopt'), { primary: true });
  const restore = ws.button('恢复采用前', () => invoke('restore'));
  const candidateActions = actions(adopt, restore);
  function updateActions() { adopt.hidden = latest.kind !== 'assistant_candidate'; restore.hidden = latest.kind !== 'assistant_adoption'; candidateActions.hidden = adopt.hidden && restore.hidden; }
  function renderResult() {
    transcript.replaceChildren(); comparison.replaceChildren(); comparison.hidden = !assetURL(latest.candidateImageUrl);
    if (!comparison.hidden) for (const [label, url] of [['修改前', latest.beforeImageUrl], ['协作候选', latest.candidateImageUrl]]) if (assetURL(url)) comparison.append(el('figure', {}, el('img', { src: assetURL(url), alt: label }), el('figcaption', { text: label })));
    if (latest.message) transcript.append(el('p', { class: 'ns-assistant-message', text: latest.message }));
    if (latest.semanticAI) transcript.append(el('small', { text: `${latest.model || '已连接模型'} · ${latest.visualInspection || latest.imageSent ? '已读取图片' : '基于文字与结构信息'}` }));
    for (const key of ['intentCard', 'items', 'suggestions', 'checks', 'questions']) {
      const value = latest[key]; if (!value || Array.isArray(value) && !value.length) continue;
      const readable = key === 'checks' && Array.isArray(value) ? value.map(check => ({ ...check, status: ({ pass: '已检查', concern: '需要关注', unknown: '待确认' })[check.status] || check.status })) : value;
      renderReport(transcript, { [({ intentCard: '本次目标', questions: '需要补充' })[key] || key]: readable });
    }
    if (latest.toolCalls?.length) {
      const steps = el('ol', { class: 'ns-assistant-steps' });
      for (const call of latest.toolCalls) {
        const args = call.arguments || call.args || {}, kind = call.name || call.tool || call.function?.name;
        const nodeLabel = (context.catalog || []).find(item => item.type === (args.type || args.name))?.label;
        steps.append(el('li', { text: `${tools[kind] || kind || '执行操作'}${nodeLabel ? ' · ' + nodeLabel : ''}` }));
      }
      transcript.append(el('h3', { text: '本次操作' }), steps);
    }
    if (latest.proposedNodes?.length) transcript.append(notice(`采用后将接入 ${latest.proposedNodes.map(node => node.label || node.type).join('、')}。`));
    if (latest.validation?.warnings?.length) renderReport(transcript, { warnings: latest.validation.warnings });
    if (!transcript.children.length) transcript.append(el('p', { class: 'ns-assistant-empty', text: execution ? '选中一处，或者直接说出想法。助手先看当前节点，再决定需要哪些工具。' : '这里保留本节点最近的分析结果，可以继续补充要求。' }));
    updateActions();
  }
  side.append(service.element, transcript, prompt.group);
  if (context.node.type === 'design_review') side.append(field(ws, 'reviewFocus', '审阅重点', { options: [{ value: 'overall', label: '整体分布与场景' }, { value: 'preservation', label: '角色特征与保护区域' }, { value: 'production', label: '制作准备' }], value: ws.params.reviewFocus || 'overall' }).group);
  side.append(progress, actions(run), candidateActions); ws.body.append(el('div', { class: 'ns-assistant-bench' }, stage, side));
  ws.root.classList.add('ns-ws-wide'); ws.root.dataset.arranged = 'true'; ws.cleanup(() => clearInterval(timer)); renderResult(); return ws;
}
