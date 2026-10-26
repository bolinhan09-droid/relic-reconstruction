import {copy,findNode,makeNode,laneForNode,assertWorkflow,markAfter} from './model.js';

/** Insert a local fabrication route without evaluating or regenerating any node. */
export function appendMakingRoute(current,anchorId,catalog){
  const workflow=copy(current),lane=laneForNode(workflow,anchorId),anchor=findNode(workflow,anchorId);
  if(!lane||anchor?.type!=='production_guide')throw Error('请从制作指导中开始');
  const at=lane.order.indexOf(anchorId)+1,following=lane.order.slice(at,at+3).map(id=>findNode(workflow,id));
  if(following[0]?.type==='garment_flatten'&&following[0].params?.preparationOnly&&following[1]?.type==='flatten_map'&&following[2]?.type==='stencil_export'){
    return {workflow,firstId:following[0].id,created:false};
  }
  if(following[0]?.type==='flatten_map'&&following[1]?.type==='stencil_export')return {workflow,firstId:following[0].id,created:false};
  const photo=makeNode('garment_flatten',catalog,{preparationOnly:true,makingRouteFor:anchorId}),mapping=makeNode('flatten_map',catalog,{makingRouteFor:anchorId}),kit=makeNode('stencil_export',catalog,{makingRouteFor:anchorId});
  photo.label='平铺照片';mapping.label='核对映射';
  photo.params.nextNodeId=mapping.id;mapping.params.nextNodeId=kit.id;
  workflow.nodes.push(photo,mapping,kit);lane.order.splice(at,0,photo.id,mapping.id,kit.id);
  workflow.selectedNodeId=photo.id;workflow.selectedLaneId=lane.id;markAfter(workflow,kit.id);assertWorkflow(workflow);
  return {workflow,firstId:photo.id,created:true};
}
