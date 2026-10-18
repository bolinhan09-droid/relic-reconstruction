/* Pure workflow operations. Rendering and network code never mutate the graph. */
export const copy = value => structuredClone(value);
export const uid = () => globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 16) || `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export const findNode = (workflow, id) => workflow.nodes.find(node => node.id === id);
export const definitionFor = (catalog, type) => catalog.find(def => (def.type || def.id) === type);
export function upstreamOutput(workflow, nodeId) {
  let index = workflow.order.indexOf(nodeId);
  if (index < 0) {
    const host = workflow.nodes.find(item => Object.values(item.attachments || {}).some(ids => ids.includes(nodeId)));
    if (host?.output?.imageUrl) return copy(host.output);
    index = host ? workflow.order.indexOf(host.id) : 0;
  }
  for (let i = index - 1; i >= 0; i--) {
    const output = findNode(workflow, workflow.order[i])?.output;
    if (output?.imageUrl) return copy(output);
  }
  const first = findNode(workflow, workflow.order[0]);
  const asset = first?.params?.front || workflow.assets?.[0];
  return asset ? {kind: 'garment', ...copy(asset), imageUrl: asset.imageUrl || asset.url, reference: copy(asset)} : null;
}
export function markAfter(workflow, nodeId) {
  const start = workflow.order.indexOf(nodeId);
  for (const id of workflow.order.slice(start + 1)) {
    const node = findNode(workflow, id);
    if (node?.output) node.status = 'stale';
  }
}
export function makeNode(type, catalog, params = {}) {
  const definition = definitionFor(catalog, type);
  if (!definition) throw Error('这个节点暂未登记。');
  return {id: uid(), type, label: definition.label, params: copy(params), attachments: {top: [], bottom: []}, status: 'draft', output: null};
}
export function insertNode(current, type, catalog, {afterId, at, hostId, slot} = {}) {
  const workflow = copy(current), definition = definitionFor(catalog, type);
  if (type === 'garment_input') throw Error('每个项目只有一个服装输入，请进入起点补充照片。');
  const node = makeNode(type, catalog);
  workflow.nodes.push(node);
  if (definition.placement === 'attachment' || hostId) {
    const host = findNode(workflow, hostId || afterId || workflow.order[0]);
    if (!host || !workflow.order.includes(host.id)) throw Error('先选择一个主线节点，再插入助手或参考。');
    const side = slot || definition.slot || 'top';
    if (!['top', 'bottom'].includes(side)) throw Error('插槽类型不正确。');
    host.attachments ||= {top: [], bottom: []};
    host.attachments[side] ||= [];
    host.attachments[side].push(node.id);
    markAfter(workflow, host.id);
  } else {
    const index = at ?? (workflow.order.indexOf(afterId) >= 0 ? workflow.order.indexOf(afterId) + 1 : workflow.order.length);
    workflow.order.splice(Math.max(1, index), 0, node.id);
    markAfter(workflow, node.id);
  }
  workflow.selectedNodeId = node.id;
  return workflow;
}
export function detachNode(current, id) {
  const workflow = copy(current), node = findNode(workflow, id);
  if (!node || node.type === 'garment_input') throw Error('服装输入是项目起点，可以更换照片，不能撤下。');
  const index = workflow.order.indexOf(id);
  if (index >= 0) {
    markAfter(workflow, id);
    workflow.order.splice(index, 1);
  }
  for (const host of workflow.nodes) for (const slot of ['top', 'bottom']) {
    if (host.attachments?.[slot]?.includes(id)) {
      host.attachments[slot] = host.attachments[slot].filter(value => value !== id);
      markAfter(workflow, host.id);
    }
  }
  workflow.stash = [...new Set([...(workflow.stash || []), id])];
  workflow.selectedNodeId = workflow.order[Math.max(0, index - 1)] || workflow.order[0];
  return workflow;
}
export function moveNode(current, id, index, catalog) {
  const workflow = copy(current), node = findNode(workflow, id);
  if (!node || node.type === 'garment_input') throw Error('服装输入固定在主线起点。');
  const definition = definitionFor(catalog, node.type);
  if (!definition) throw Error('这个节点暂未登记。');
  if (definition.placement === 'attachment') throw Error('这张卡要插在节点侧边，请先选择宿主节点。');
  const old = workflow.order.indexOf(id);
  const destination = Math.max(1, Math.min(index, workflow.order.length - (old >= 0 ? 1 : 0)));
  if (old >= 0 && old === destination) return workflow;
  if (old >= 0) workflow.order.splice(old, 1);
  for (const host of workflow.nodes) for (const slot of ['top', 'bottom']) {
    if (host.attachments?.[slot]) host.attachments[slot] = host.attachments[slot].filter(value => value !== id);
  }
  workflow.order.splice(destination, 0, id);
  workflow.stash = (workflow.stash || []).filter(value => value !== id);
  markAfter(workflow, workflow.order[Math.max(0, Math.min(index, old < 0 ? index : old) - 1)]);
  workflow.selectedNodeId = id;
  return workflow;
}
/* Drag targets name a gap in the original mainline, unlike move buttons which
 * name the node's final index. Removing an earlier node shifts that gap left. */
export function moveNodeToGap(current, id, gapIndex, catalog) {
  if (!Number.isInteger(gapIndex)) throw Error('插入位置无效。');
  const gap = Math.max(1, Math.min(gapIndex, current.order.length));
  const previous = current.order.indexOf(id);
  return moveNode(current, id, gap - (previous >= 0 && previous < gap ? 1 : 0), catalog);
}
export function patchNode(current, id, patch) {
  const workflow = copy(current), node = findNode(workflow, id);
  if (!node) throw Error('节点不存在。');
  node.params = {...node.params, ...copy(patch)};
  if (node.output) node.status = 'stale';
  const host = workflow.nodes.find(item => Object.values(item.attachments || {}).some(ids => ids.includes(id)));
  if (host?.output && host.type !== 'garment_input') host.status = 'stale';
  markAfter(workflow, host?.id || id);
  return workflow;
}
export function commitNode(current, id, output) {
  const workflow = copy(current), node = findNode(workflow, id);
  if (!node) throw Error('节点不存在。');
  node.versions ||= [];
  if (node.output) node.versions.push({id: uid(), output: copy(node.output), savedAt: new Date().toISOString()});
  node.versions = node.versions.slice(-30);
  node.output = {...copy(output), versionId: uid()};
  node.status = 'succeeded';
  markAfter(workflow, id);
  return workflow;
}
export function restoreVersion(current, id, versionId) {
  const node = findNode(current, id), version = node?.versions?.find(item => item.id === versionId);
  if (!version) throw Error('没有找到这个历史版本。');
  return commitNode(current, id, version.output);
}
export function assertWorkflow(workflow) {
  if (!workflow || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.order)) throw Error('工作流格式不正确。');
  const ids = workflow.nodes.map(node => node.id);
  if (ids.length !== new Set(ids).size) throw Error('存在重复节点。');
  if (workflow.order.length !== new Set(workflow.order).size || workflow.order.some(id => !ids.includes(id))) throw Error('主线连接无效。');
  if (findNode(workflow, workflow.order[0])?.type !== 'garment_input') throw Error('主线需要真实服装起点。');
  const assigned = new Set(workflow.order);
  for (const node of workflow.nodes) for (const slots of Object.values(node.attachments || {})) for (const id of slots) {
    if (!ids.includes(id) || id === node.id || assigned.has(id)) throw Error('一个节点只能放在一个位置。');
    assigned.add(id);
  }
  return true;
}
