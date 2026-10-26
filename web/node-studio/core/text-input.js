/* A text output travels beside the garment, not in place of its image. */
import { precedingNodeIds, hostFor } from './graph.js';

const MAX_TEXT = 16000;
export function intentText(output = {}) {
  for (const key of ['text', 'intent', 'prompt']) if (typeof output[key] === 'string' && output[key].trim()) return output[key].trim().slice(0, MAX_TEXT);
  return (Array.isArray(output.items) ? output.items : []).map(item => {
    if (typeof item === 'string') return item.trim();
    if (!item || typeof item !== 'object') return '';
    const label = String(item.label || '').trim(), value = String(item.value || item.detail || '').trim();
    return value ? `${label ? label + '：' : ''}${value}` : '';
  }).filter(Boolean).join('\n').slice(0, MAX_TEXT);
}

export function textInput(workflow, nodeId) {
  const byId = new Map((workflow?.nodes || []).map(node => [node.id, node])), node = byId.get(nodeId);
  if (!node) return { sources: [], text: '', additionalText: '', combinedText: '', task: null, stale: false };
  const host = hostFor(workflow, nodeId);
  let route = [...precedingNodeIds(workflow, nodeId), ...(host ? [host.id] : [])];
  let start = 0;
  route.forEach((id, i) => { if (['garment_input', 'image_reference'].includes(byId.get(id)?.type)) start = i; });
  route = route.slice(start);
  const entries = [], seen = new Set();
  function append(id, includeSelf = true) {
    if (seen.has(id)) return;
    seen.add(id); const entry = byId.get(id); if (!entry) return;
    if (includeSelf) entries.push(entry);
    for (const slot of ['top', 'bottom']) for (const child of entry.attachments?.[slot] || []) if (child !== nodeId) append(child);
  }
  route.forEach(id => append(id)); append(nodeId, false);
  let sources = [], task = null;
  for (const entry of entries) {
    const output = entry.output || {}; let text = '', kind = '';
    if (entry.type === 'intent_assist' && output.kind === 'intent') { text = intentText(output); kind = 'intent'; }
    else if (output.kind === 'generation_task' && output.task && typeof output.task === 'object') {
      task = structuredClone(output.task); text = String(task.prompt || task.intent || '').trim().slice(0, MAX_TEXT); kind = 'generation_task';
      sources = sources.filter(source => source.kind !== 'generation_task');
    }
    if (text) sources.push({ nodeId: entry.id, label: entry.label || entry.type, kind, text,
      versionId: output.versionId || output.textVersionId || '', stale: entry.status === 'stale' });
  }
  const chunks = [];
  for (const source of sources) {
    if (sources.some(other => other !== source && other.text.length > source.text.length && other.text.includes(source.text))) continue;
    if (!chunks.includes(source.text)) chunks.push(source.text);
  }
  const text = chunks.join('\n\n'), extra = node.params?.intent || node.params?.prompt || '';
  const additionalText = typeof extra === 'string' ? extra.trim().slice(0, MAX_TEXT) : '';
  const combinedText = text + (additionalText && !text.includes(additionalText) ? (text ? '\n\n本次补充：' : '') + additionalText : '');
  return { sources, text, additionalText, combinedText, task, stale: sources.some(source => source.stale) };
}
