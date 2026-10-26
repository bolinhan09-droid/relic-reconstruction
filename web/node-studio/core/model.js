/* Pure workflow operations. Rendering and network code never mutate the graph. */
import {getLanes,laneForNode,laneById,branchesFor,hostFor,structural,precedingNodeIds,collectMergeCandidates,markAfter,markStructureChanges,assertGraph,clearInvalidInputs} from './graph.js';
export {getLanes,laneForNode,laneById,rootLaneForNode,precedingNodeIds,collectMergeCandidates,markAfter} from './graph.js';
export const copy = value => structuredClone(value);
export const uid = () => globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 16) || `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export const findNode = (workflow, id) => workflow.nodes.find(node => node.id === id);
export const definitionFor = (catalog, type) => catalog.find(def => (def.type || def.id) === type);
export function upstreamOutput(workflow, nodeId) {
  const host=hostFor(workflow,nodeId);
  const own=findNode(workflow,nodeId);
  const scope=[...precedingNodeIds(workflow,nodeId),...(host?[host.id]:[])];
  if(['garment_input','image_reference'].includes(own?.type)) scope.push(nodeId);
  for(const id of scope.reverse()) {
    const node=findNode(workflow,id);
    // Analysis may carry a preview URL, but it must not replace the garment
    // artifact (including its editable strokes/project) flowing through here.
    if(['intent_assist','design_advice','design_review','production_guide','production_context','scene_context'].includes(node?.type)) continue;
    if(['garment_input','image_reference'].includes(node?.type)) {
      const asset=node.type==='garment_input'?node.params?.front:node.params?.references?.[node.params?.activeReferenceIndex || 0];
      // An emptied reference is a deliberate break, not permission to borrow
      // a photo from the original mainline or a previous input.
      if(!asset) return null;
      const bound=node.output?.originalImageUrl || node.output?.sourceImageUrl || node.output?.imageUrl;
      if(node.output?.imageUrl && bound===(asset.url || asset.imageUrl)) return {...copy(node.output),sourceRole:node.type==='garment_input'?'garment':'reference'};
      return {kind:node.type==='garment_input'?'garment':'reference',...copy(asset),imageUrl:asset.imageUrl || asset.url,reference:copy(asset),sourceRole:node.type==='garment_input'?'garment':'reference'};
    }
    if(node?.type==='branch_merge') {
      const base=upstreamOutput(workflow,node.params.forkId);
      return {kind:'candidate_set',candidates:collectMergeCandidates(workflow,node),mergeNodeId:node.id,baseImageUrl:base?.imageUrl || base?.baseImageUrl};
    }
    if(node?.type!=='branch_create' && node?.output?.imageUrl) return copy(node.output);
  }
  return !scope.length && own?.output?.imageUrl?copy(own.output):null;
}
export function makeNode(type, catalog, params = {}) {
  const definition = definitionFor(catalog, type);
  if (!definition) throw Error('这个节点暂未登记。');
  return {id: uid(), type, label: definition.label, params: copy(params), attachments: {top: [], bottom: []}, status: 'draft', output: null};
}
export function createBranchGroup(current,afterId,catalog) {
  const workflow=copy(current),lane=laneForNode(workflow,afterId);
  if(!lane) throw Error('请选择一条路线中的节点作为分叉起点。');
  if(findNode(workflow,afterId)?.type==='branch_create') throw Error('请在某条分支内部继续分叉，或在合拢节点之后创建新分支。');
  const fork=makeNode('branch_create',catalog),merge=makeNode('branch_merge',catalog,{forkId:fork.id});
  const suffix=lane.order.splice(lane.order.indexOf(afterId)+1);
  const branches=[{id:uid(),forkId:fork.id,label:'方案 A',order:suffix},{id:uid(),forkId:fork.id,label:'方案 B',order:[]}];
  workflow.nodes.push(fork,merge);lane.order.push(fork.id,merge.id);
  workflow.branches=[...(workflow.branches || []),...branches];
  workflow.selectedNodeId=fork.id;workflow.selectedLaneId=branches[1].id;
  markStructureChanges(current,workflow);assertWorkflow(workflow);return workflow;
}
export function addBranch(current,forkId,label) {
  const workflow=copy(current),fork=findNode(workflow,forkId);
  if(fork?.type!=='branch_create' || !laneForNode(workflow,forkId)) throw Error('分支起点不存在。');
  const siblings=branchesFor(workflow,forkId);
  if(siblings.length>=12) throw Error('每个分叉最多保留 12 条探索路线。');
  const branch={id:uid(),forkId,label:String(label || `方案 ${String.fromCharCode(65+siblings.length)}`).slice(0,80),order:[]};
  workflow.branches=[...(workflow.branches || []),branch];workflow.selectedNodeId=forkId;workflow.selectedLaneId=branch.id;
  // A new empty route does not change either existing route's input.
  const merge=workflow.nodes.find(node=>node.type==='branch_merge' && node.params?.forkId===forkId);
  if(merge?.output) merge.status='stale';if(merge) markAfter(workflow,merge.id);return workflow;
}
export function renameBranch(current,branchId,label) {
  const workflow=copy(current),branch=(workflow.branches || []).find(item=>item.id===branchId);
  if(!branch) throw Error('这条路线不存在。');
  branch.label=String(label || '未命名方案').trim().slice(0,80);return workflow;
}
export function insertNode(current, type, catalog, {afterId, at, hostId, slot,laneId} = {}) {
  if(type==='branch_create') return createBranchGroup(current,afterId || laneById(current,laneId)?.order.at(-1),catalog);
  if(type==='branch_merge') throw Error('合拢节点随分支一起建立，请先添加探索分支。');
  const workflow = copy(current), definition = definitionFor(catalog, type);
  if (type === 'garment_input') return insertNodeOnCanvas(current,type,catalog);
  const node = makeNode(type, catalog);
  workflow.nodes.push(node);
  if (definition.placement === 'attachment' || hostId) {
    const host = findNode(workflow, hostId || afterId || workflow.order[0]);
    if (!host || !laneForNode(workflow,host.id)) throw Error('先选择一个路线节点，再插入助手或参考。');
    const side = slot || definition.slot || 'top';
    if (!['top', 'bottom'].includes(side)) throw Error('插槽类型不正确。');
    host.attachments ||= {top: [], bottom: []};
    host.attachments[side] ||= [];
    host.attachments[side].push(node.id);
    markAfter(workflow, host.id);
  } else {
    const lane=laneId?laneById(workflow,laneId):laneForNode(workflow,afterId) || laneById(workflow);
    if(!lane) throw Error('目标路线不存在。');
    const index = at ?? (lane.order.includes(afterId) ? lane.order.indexOf(afterId) + 1 : lane.order.length);
    if(findNode(workflow,lane.order[index-1])?.type==='branch_create') throw Error('请把创作节点放入一条分支路线。');
    lane.order.splice(Math.max(lane.id==='main'?1:0,index),0,node.id);
    workflow.selectedLaneId=lane.id;
    markAfter(workflow, node.id);
  }
  workflow.selectedNodeId = node.id;
  return workflow;
}
export function detachNode(current, id) {
  const workflow = copy(current), node = findNode(workflow, id);
  if (!node || id === workflow.order[0]) throw Error('主线服装输入保留在起点，可另建服装路线');
  if(structural(node)) throw Error('分支与合拢共同保存路线结构，请移动路线中的创作节点。');
  const lane=laneForNode(workflow,id),index=lane?.order.indexOf(id) ?? -1;
  if (index >= 0) {
    markAfter(workflow, id);
    lane.order.splice(index,1);
  }
  for (const host of workflow.nodes) for (const slot of ['top', 'bottom']) {
    if (host.attachments?.[slot]?.includes(id)) {
      host.attachments[slot] = host.attachments[slot].filter(value => value !== id);
      markAfter(workflow, host.id);
    }
  }
  workflow.stash = [...new Set([...(workflow.stash || []), id])];
  workflow.routes=(workflow.routes || []).filter(route=>route.order.length);
  workflow.selectedNodeId = lane?.order[Math.max(0,index-1)] || lane?.forkId || workflow.order[0];
  clearInvalidInputs(workflow);markStructureChanges(current,workflow);
  return workflow;
}
export function moveNode(current, id, index, catalog,laneId='main') {
  const workflow = copy(current), node = findNode(workflow, id);
  if (!node || id === workflow.order[0]) throw Error('主线服装输入保留在起点，可另建服装路线');
  if(structural(node)) throw Error('分支与合拢共同保存路线结构，请移动路线中的创作节点。');
  const definition = definitionFor(catalog, node.type);
  if (!definition) throw Error('这个节点暂未登记。');
  if (definition.placement === 'attachment') throw Error('这张卡要插在节点侧边，请先选择宿主节点。');
  const source=laneForNode(workflow,id),target=laneById(workflow,laneId);
  if(!target) throw Error('目标路线不存在。');
  const old=source?.order.indexOf(id) ?? -1,same=source?.id===target.id;
  const destination=Math.max(laneId==='main'?1:0,Math.min(index,target.order.length-(same?1:0)));
  if(same && old===destination) return workflow;
  if(source) source.order.splice(old,1);
  for (const host of workflow.nodes) for (const slot of ['top', 'bottom']) {
    if (host.attachments?.[slot]) host.attachments[slot] = host.attachments[slot].filter(value => value !== id);
  }
  target.order.splice(destination,0,id);
  workflow.stash = (workflow.stash || []).filter(value => value !== id);
  workflow.routes=(workflow.routes || []).filter(route=>route.order.length);
  clearInvalidInputs(workflow);markStructureChanges(current,workflow);
  workflow.selectedNodeId = id;
  workflow.selectedLaneId=laneId;
  assertWorkflow(workflow);
  return workflow;
}
/* Drag targets name a gap in the original mainline, unlike move buttons which
 * name the node's final index. Removing an earlier node shifts that gap left. */
export function moveNodeToGap(current, id, gapIndex, catalog,laneId='main') {
  if (!Number.isInteger(gapIndex)) throw Error('插入位置无效。');
  const lane=laneById(current,laneId);if(!lane) throw Error('目标路线不存在。');
  const gap=Math.max(laneId==='main'?1:0,Math.min(gapIndex,lane.order.length));
  const previous=lane.order.indexOf(id);
  return moveNode(current,id,gap-(previous>=0 && previous<gap?1:0),catalog,laneId);
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
  return assertGraph(workflow);
}

function canvasPosition(position={},workflow) {
  const offset=(workflow.routes || []).length;
  const result={x:position.x ?? 64,y:position.y ?? (620+offset*360)};
  if(Object.values(result).some(value=>typeof value!=='number' || !Number.isFinite(value) || Math.abs(value)>100000)) throw Error('画布坐标无效');
  return result;
}

/** Keep completed cards on the canvas; moving is not deleting or rerunning. */
export function placeNodeOnCanvas(current,id,position={}) {
  const node=findNode(current,id);
  if(!node) throw Error('节点不存在');
  if(id===current.order[0]) throw Error('主线服装输入保留在起点，可另建服装路线');
  if(structural(node)) throw Error('分支结构请整体保留，创作节点可以拖出');
  const workflow=copy(current),source=laneForNode(workflow,id),coords=canvasPosition(position,workflow);
  if(source && (workflow.routes || []).includes(source) && source.order.length===1) {
    Object.assign(source,coords);workflow.selectedNodeId=id;workflow.selectedLaneId=source.id;return workflow;
  }
  if(source) source.order=source.order.filter(item=>item!==id);
  // The main lane is a view over workflow.order, so mutate its array directly.
  if(source?.id==='main') workflow.order=source.order;
  for(const host of workflow.nodes) for(const slot of ['top','bottom']) if(host.attachments?.[slot]) host.attachments[slot]=host.attachments[slot].filter(item=>item!==id);
  workflow.stash=(workflow.stash || []).filter(item=>item!==id);
  workflow.routes=(workflow.routes || []).filter(route=>route.order.length);
  const route={id:uid(),label:node.label || '独立方案',order:[id],...coords};
  workflow.routes.push(route);workflow.selectedNodeId=id;workflow.selectedLaneId=route.id;
  clearInvalidInputs(workflow);markStructureChanges(current,workflow);assertWorkflow(workflow);return workflow;
}

export function insertNodeOnCanvas(current,type,catalog,position={}) {
  const definition=definitionFor(catalog,type);
  if(!definition) throw Error('这个节点暂未登记');
  if(['branch_create','branch_merge'].includes(type)) throw Error('请在现有方案后建立分支');
  if(definition.placement==='attachment') throw Error('这个节点需要插入侧边槽位');
  const workflow=copy(current),node=makeNode(type,catalog),route={id:uid(),label:node.label,order:[node.id],...canvasPosition(position,workflow)};
  workflow.nodes.push(node);workflow.routes=[...(workflow.routes || []),route];
  workflow.selectedNodeId=node.id;workflow.selectedLaneId=route.id;assertWorkflow(workflow);return workflow;
}

export function positionRoute(current,routeId,position) {
  const workflow=copy(current),route=(workflow.routes || []).find(item=>item.id===routeId);
  if(!route) throw Error('独立路线不存在');
  Object.assign(route,canvasPosition(position,workflow));return workflow;
}

/** Only seed new projects. No fabricated output and no model execution. */
export function makeStandardWorkflow(current,catalog) {
  const workflow=copy(current);
  if(workflow.order.length!==1 || findNode(workflow,workflow.order[0])?.type!=='garment_input') return workflow;
  if((workflow.routes || []).length || (workflow.branches || []).length) return workflow;
  for(const type of ['quick_create','image_generate','precision_edit','production_guide']) {
    const node=makeNode(type,catalog);workflow.nodes.push(node);workflow.order.push(node.id);
  }
  workflow.routes ||= [];workflow.selectedNodeId=workflow.order[0];workflow.selectedLaneId='main';
  workflow.template='standard_v011';assertWorkflow(workflow);return workflow;
}
