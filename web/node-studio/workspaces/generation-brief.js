import { el, field, notice } from './shared.js';
import { textInput } from '../core/text-input.js';

/** Render the exact saved text sources consumed by the backend. */
export function generationBrief(ws, context) {
  const element = el('section', { class: 'ns-generation-brief', 'aria-label': '生成文字输入' });
  const sources = el('p', { class: 'ns-ws-notice', 'data-text-sources': '' });
  const inherited = field(ws, '_upstreamText', '来自上游的文字', { type: 'textarea', rows: 6, persist: false });
  inherited.control.readOnly = true; inherited.control.dataset.upstreamText = '';
  const extra = field(ws, 'intent', '本次补充', { type: 'textarea', rows: 3, value: ws.params.intent || '',
    placeholder: '可选，例如：再减少一点下摆血迹，领巾保持干净', help: '上游文字自动传入，这里的补充单独保存' });
  const warning = notice(''); warning.setAttribute('role', 'status');
  element.append(sources, inherited.group, extra.group, warning);
  function read() {
    const workflow = context.getWorkflow?.() || context.workflow;
    // Include this workspace's most recent text without replacing upstream data.
    const result = textInput(workflow, context.node.id);
    const additionalText = extra.control.value.trim();
    const combinedText = result.text + (additionalText && !result.text.includes(additionalText) ? (result.text ? '\n\n本次补充：' : '') + additionalText : '');
    return { ...result, additionalText, combinedText };
  }
  function refresh() {
    const value = read(); inherited.control.value = value.text;
    inherited.control.placeholder = '连接已完成的想法整理或创作任务，文字会显示在这里';
    sources.textContent = value.sources.length ? `已接收 · ${value.sources.map(source => source.label).join(' + ')}` : '尚无上游文字，可直接填写本次补充';
    warning.textContent = value.stale ? '上游文字已修改，请先更新对应节点的输出，再生成' : '';
    warning.hidden = !value.stale; return value;
  }
  function assertReady({ allowEmpty = false } = {}) {
    const value = refresh();
    if (value.stale) throw Error('上游文字已修改，请先更新对应节点的输出');
    if (!allowEmpty && !value.text && !extra.control.value.trim()) throw Error('请连接想法整理的输出，或填写本次补充');
    return value;
  }
  refresh(); return { element, refresh, assertReady };
}
