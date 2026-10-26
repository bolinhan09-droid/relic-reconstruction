import {createWorkspace,el,field,actions,uploadControl,inputFor,assetURL} from './shared.js';
import {laneForNode,findNode} from '../core/model.js';

/** A real target photo accompanies the editable source; it never replaces it. */
export async function flatlayPhoto(container,context){
  const ws=createWorkspace(container,context,{title:'准备平铺照片'}),source=inputFor(context);
  ws.root.dataset.inlineResult='true';
  let target=context.node.output?.flatlayTarget||ws.params.flatlayTarget;
  const preview=el('figure',{class:'ns-ws-preview'});
  function show(){preview.replaceChildren();preview.append(assetURL(target)?el('img',{src:assetURL(target),alt:'目标平铺衣片'}):el('div',{class:'ns-ws-empty',text:'把同一衣片铺平，正对拍摄'}),el('figcaption',{text:'这张照片用于制作定位，穿着图和笔触保留在上游'}));}
  const part=field(ws,'componentName','这张照片是什么部件',{value:ws.params.componentName||'前衣片',placeholder:'例如：披风正面、左袖'});
  async function persist(){if(!target)return;if(!assetURL(source))throw Error('先连接已有服装方案');await ws.commit({...source,kind:'garment',flatlayTarget:{...target,componentName:part.control.value||'前衣片'},flatlayPreparation:true,message:'平铺照片已准备，原方案笔触保持可映射'});}
  ws.body.append(preview,uploadControl(ws,context,'放入平铺照片',async asset=>{target=asset;ws.patch({flatlayTarget:asset});show();await persist();}),part.group,
    el('p',{class:'ns-ws-notice',text:'一次拍一件衣片的一面，边缘完整；背面另做一条制作路线'}),
    actions(ws.button('继续核对映射',async()=>{
      if(!target)throw Error('先放入平铺照片');
      const flow=context.getWorkflow(),lane=laneForNode(flow,context.node.id),next=lane?.order[lane.order.indexOf(context.node.id)+1];
      if(findNode(flow,next)?.type!=='flatten_map')throw Error('请在这张平铺照片后接上核对映射节点');
      await persist();await context.openNode?.(next);
    },{primary:true})));
  show();return ws;
}
