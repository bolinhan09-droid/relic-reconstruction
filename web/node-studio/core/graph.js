/* Ordered lanes form a directed acyclic graph. A fork/merge pair remains in
 * its parent lane; independent branches contain the exploratory operations. */
const copy=value=>structuredClone(value);
const find=(workflow,id)=>workflow.nodes.find(node=>node.id===id);
export const getLanes=workflow=>[{id:'main',label:'主线',order:workflow.order},...(workflow.branches || [])];
export const laneForNode=(workflow,id)=>getLanes(workflow).find(lane=>lane.order.includes(id)) || null;
export const laneById=(workflow,id='main')=>getLanes(workflow).find(lane=>lane.id===id);
export const branchesFor=(workflow,id)=>(workflow.branches || []).filter(lane=>lane.forkId===id);
export const hostFor=(workflow,id)=>workflow.nodes.find(node=>Object.values(node.attachments || {}).some(ids=>ids.includes(id)));
export const structural=node=>['branch_create','branch_merge'].includes(node?.type);

export function precedingNodeIds(workflow,nodeId,seen=new Set()) {
  if(seen.has(nodeId)) return [];
  seen.add(nodeId);
  const lane=laneForNode(workflow,nodeId);
  if(!lane) {const host=hostFor(workflow,nodeId);return host?precedingNodeIds(workflow,host.id,seen):[];}
  return [...(lane.forkId?[...precedingNodeIds(workflow,lane.forkId,seen),lane.forkId]:[]),...lane.order.slice(0,lane.order.indexOf(nodeId))];
}
export function mergeFor(workflow,nodeOrId) {
  const node=typeof nodeOrId==='string'?find(workflow,nodeOrId):nodeOrId;
  if(!node) return null;
  if(node.type==='branch_merge') return node;
  if(node.type==='branch_create') return workflow.nodes.find(item=>item.type==='branch_merge' && item.params?.forkId===node.id) || null;
  for(const id of precedingNodeIds(workflow,node.id).reverse()) {
    const previous=find(workflow,id);
    if(previous?.type==='branch_merge') return previous;
    if(previous?.output?.imageUrl && previous.type!=='branch_create') break;
  }
  return null;
}
export function collectMergeCandidates(workflow,nodeOrId,{all=false}={}) {
  const merge=mergeFor(workflow,nodeOrId);if(!merge) return [];
  const collect=(forkId,seen=new Set())=>{
    if(seen.has(forkId)) return [];
    const next=new Set(seen).add(forkId),result=[];
    for(const branch of branchesFor(workflow,forkId)) {
      for(const id of [...branch.order].reverse()) {
        const node=find(workflow,id);
        if(node?.type==='branch_merge') {const nested=collect(node.params?.forkId,next),selected=node.params?.selectedCandidateIds;result.push(...(Array.isArray(selected) && selected.length?nested.filter(item=>selected.includes(item.nodeId)):nested));break;}
        if(node?.output?.imageUrl) {result.push({id:node.id,nodeId:node.id,branchId:branch.id,branchLabel:branch.label,label:branch.label || node.label,imageUrl:node.output.imageUrl,output:copy(node.output),status:node.status});break;}
      }
    }
    return result;
  };
  const candidates=collect(merge.params?.forkId),selected=merge.params?.selectedCandidateIds;
  return !all && Array.isArray(selected) && selected.length?candidates.filter(item=>selected.includes(item.nodeId)):candidates;
}
export function dependencyMap(workflow) {
  const dependencies=new Map(workflow.nodes.map(node=>[node.id,new Set()]));
  for(const lane of getLanes(workflow)) for(let i=0;i<lane.order.length;i++) {
    const previous=i?lane.order[i-1]:lane.forkId;
    if(previous) dependencies.get(lane.order[i])?.add(previous);
  }
  for(const node of workflow.nodes) {
    const parents=dependencies.get(node.id),params=node.params || {};
    for(const child of Object.values(node.attachments || {}).flat()) parents.add(child);
    for(const id of [params.sourceNodeId,params.baseNodeId,...(params.sourceNodeIds || []),...(params.candidateIds || [])]) if(id) parents.add(id);
    if(node.type==='branch_merge') for(const lane of branchesFor(workflow,params.forkId)) parents.add(lane.order.at(-1) || params.forkId);
  }
  return dependencies;
}
export function markAfter(workflow,nodeId) {
  const dependencies=dependencyMap(workflow),affected=new Set([nodeId]);let changed=true;
  while(changed) {changed=false;for(const [id,parents] of dependencies) if(!affected.has(id) && [...parents].some(parent=>affected.has(parent))) {affected.add(id);changed=true;}}
  for(const id of affected) if(id!==nodeId) {const node=find(workflow,id);if(node?.output) node.status='stale';}
}
export function markStructureChanges(before,after) {
  const prior=dependencyMap(before);
  for(const [id,parents] of dependencyMap(after)) {
    const old=prior.get(id);
    if(old && old.size===parents.size && [...parents].every(parent=>old.has(parent))) continue;
    const node=find(after,id);if(node?.output) node.status='stale';markAfter(after,id);
  }
}
export function assertGraph(workflow) {
  if(!workflow || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.order) || (workflow.branches!==undefined && !Array.isArray(workflow.branches))) throw Error('工作流格式不正确。');
  const ids=workflow.nodes.map(node=>node.id);if(ids.length!==new Set(ids).size) throw Error('存在重复节点。');
  if(find(workflow,workflow.order[0])?.type!=='garment_input') throw Error('主线需要真实服装起点。');
  const assigned=new Set(),laneIds=new Set();
  for(const lane of getLanes(workflow)) {
    if(!lane.id || laneIds.has(lane.id) || !Array.isArray(lane.order)) throw Error('探索路线无效。');laneIds.add(lane.id);
    for(const id of lane.order) {if(!ids.includes(id) || assigned.has(id)) throw Error('一个节点只能放在一条路线。');assigned.add(id);}
    if(lane.id!=='main' && find(workflow,lane.forkId)?.type!=='branch_create') throw Error('探索路线缺少有效分支起点。');
  }
  for(const id of workflow.stash || []) {if(!ids.includes(id) || assigned.has(id)) throw Error('方案架与路线不能重复。');assigned.add(id);}
  for(const node of workflow.nodes) for(const children of Object.values(node.attachments || {})) {
    if(!Array.isArray(children)) throw Error('附件连接无效。');
    for(const id of children) {if(!ids.includes(id) || id===node.id || assigned.has(id)) throw Error('一个节点只能放在一个位置。');assigned.add(id);}
  }
  for(const node of workflow.nodes.filter(structural)) {
    const lane=laneForNode(workflow,node.id);if(!lane) throw Error('分支结构必须处于探索路线中。');
    const fork=node.type==='branch_create'?node:find(workflow,node.params?.forkId);
    if(fork?.type!=='branch_create' || laneForNode(workflow,fork.id)?.id!==lane.id) throw Error('分支与合拢必须位于同一条父路线。');
    const merges=workflow.nodes.filter(item=>item.type==='branch_merge' && item.params?.forkId===fork.id);
    if(merges.length!==1 || lane.order.indexOf(merges[0].id)!==lane.order.indexOf(fork.id)+1) throw Error('分支与合拢应相邻，创作节点请放入其中的探索路线。');
    if(branchesFor(workflow,fork.id).length<2 || branchesFor(workflow,fork.id).length>12) throw Error('每个分叉需要 2–12 条探索路线。');
  }
  const dependencies=dependencyMap(workflow),visiting=new Set(),visited=new Set();
  const visit=id=>{if(visiting.has(id)) throw Error('节点连接不能形成循环。');if(visited.has(id)) return;if(!dependencies.has(id)) throw Error('候选引用了不存在的节点。');visiting.add(id);for(const parent of dependencies.get(id)) visit(parent);visiting.delete(id);visited.add(id);};
  for(const id of ids) visit(id);
  return true;
}
