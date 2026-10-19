import {findNode,definitionFor,getLanes} from '../core/model.js';
import {escape,icon,nodeIcon} from './icons.js';
import {preview,nodeStyle,statusLabel,bindNodeDrag,readDrop,finishNodeDrag} from './ribbon.js';

const TAG={w:340,h:220,step:318},JUNCTION={w:110,h:100},ROW=318;
const isJunction=n=>['branch_create','branch_merge'].includes(n?.type);

/** A structured graph keeps every branch a readable horizontal sequence.
 * Layout is derived from data; screen coordinates never change dependencies. */
export function graphLayout(workflow){
  const lanes=getLanes(workflow),byFork=new Map();
  for(const lane of lanes)if(lane.forkId){const list=byFork.get(lane.forkId)||[];list.push(lane);byFork.set(lane.forkId,list);}
  const memo=new Map();
  function measure(lane,seen=new Set()){
    if(memo.has(lane.id))return memo.get(lane.id);
    if(seen.has(lane.id))throw Error('分支不能连接回自己。');
    const visited=new Set([...seen,lane.id]),cells=[];let width=0,height=ROW;
    for(let i=0;i<lane.order.length;i++){
      const id=lane.order[i],n=findNode(workflow,id),children=byFork.get(id)||[];
      const mergeIndex=n?.type==='branch_create'?lane.order.findIndex((mid,j)=>j>i&&findNode(workflow,mid)?.type==='branch_merge'&&findNode(workflow,mid)?.params?.forkId===id):-1;
      if(children.length&&mergeIndex===i+1){
        const routes=children.map(c=>({lane:c,...measure(c,visited)}));
        const h=routes.reduce((s,r)=>s+r.height,0),branchWidth=Math.max(220,...routes.map(r=>r.width));
        const cell={kind:'group',id,mergeId:lane.order[mergeIndex],index:i,mergeIndex,routes,branchWidth,width:160+branchWidth+164,height:h};
        cells.push(cell);width+=cell.width;height=Math.max(height,h);i=mergeIndex;
      }else{const w=isJunction(n)?150:TAG.step;cells.push({kind:'node',id,index:i,width:w});width+=w;}
    }
    width=Math.max(width+100,220);const result={cells,width,height};memo.set(lane.id,result);return result;
  }
  const main=lanes.find(l=>l.id==='main'),tree=measure(main),nodes=[],edges=[],bands=[],ends=[];
  function connect(a,b,kind='plain'){if(a&&b)edges.push({from:a,to:b,kind});}
  function placeNode(id,lane,index,x,y){const junction=isJunction(findNode(workflow,id)),w=junction?JUNCTION.w:TAG.w,h=junction?JUNCTION.h:TAG.h;nodes.push({id,laneId:lane.id,index,x,y:y-h/2,w,h,junction});return{left:{x:x+12,y},right:{x:x+w-8,y}};}
  function place(lane,info,x,y){let cursor=x,prev=null,first=null;
    for(const cell of info.cells){
      if(cell.kind==='node'){
        const rect=placeNode(cell.id,lane,cell.index,cursor,y);connect(prev,rect.left);first||=rect.left;prev=rect.right;cursor+=cell.width;
      }else{
        const fork=placeNode(cell.id,lane,cell.index,cursor,y),joinX=cursor+160+cell.branchWidth+32;
        const join=placeNode(cell.mergeId,lane,cell.mergeIndex,joinX,y);connect(prev,fork.left);first||=fork.left;
        let top=y-cell.height/2;
        for(let j=0;j<cell.routes.length;j++){
          const route=cell.routes[j],center=top+route.height/2,bx=cursor+160;
          bands.push({laneId:route.lane.id,forkId:cell.id,label:route.lane.label||`方案 ${j+1}`,x:bx-12,y:top+14,width:cell.branchWidth+24,height:route.height-28});
          const child=place(route.lane,route,bx,center);
          connect(fork.right,child.first||{x:bx+28,y:center},'branch');
          connect(child.last||{x:bx+120,y:center},join.left,'join');
          top+=route.height;
        }
        cursor+=cell.width;prev=join.right;
      }
    }
    ends.push({laneId:lane.id,x:cursor+18,y,label:lane.id==='main'?'添加下一步':'继续这条路线',at:lane.order.length});
    return{first,last:prev};
  }
  place(main,tree,64,tree.height/2+50);
  return{nodes,edges,bands,ends,width:Math.max(tree.width+180,900),height:Math.max(tree.height+100,440)};
}

const junctionIcon=type=>type==='branch_create'?'<path d="M5 12h5m0 0V5h9m-9 7v7h9M16 2l3 3-3 3m0 8 3 3-3 3"/>':'<path d="M4 5h6v7m-6 7h6v-7m0 0h10m-3-3 3 3-3 3"/>';
function curve(edge){const a=edge.from,b=edge.to,mid=(a.x+b.x)/2;return `M${a.x},${a.y} C${mid},${a.y} ${mid},${b.y} ${b.x},${b.y}`;}

export function renderGraph(element,workflow,catalog,handlers){
  const layout=graphLayout(workflow),selected=workflow.selectedNodeId;
  element.classList.add('ns-graph');element.style.width=`${layout.width}px`;element.style.height=`${layout.height}px`;
  const attachment=id=>{const n=findNode(workflow,id),d=n&&definitionFor(catalog,n.type);return d?`<button class="ns-attachment ${selected===id?'selected':''}" draggable="true" data-attachment="${escape(id)}" style="${nodeStyle(d)}" title="${escape(n.label)} · 双击进入">${icon(nodeIcon(n.type))}<span>${escape(n.label)}</span></button>`:'';};
  element.innerHTML=layout.bands.map(b=>`<section class="ns-route-band ${workflow.selectedLaneId===b.laneId?'is-active':''}" style="left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px" data-route="${escape(b.laneId)}"><button class="ns-route-label" data-lane-select="${escape(b.laneId)}">${escape(b.label)}<span>独立探索</span></button></section>`).join('')+
    `<svg class="ns-graph-links" viewBox="0 0 ${layout.width} ${layout.height}" aria-hidden="true">${layout.edges.map(e=>`<path class="${e.kind}" d="${curve(e)}"/>`).join('')}</svg>`+
    layout.nodes.map(p=>{const n=findNode(workflow,p.id),d=definitionFor(catalog,n.type);if(!d)return'';
      const frame=`class="ns-node-wrap ${p.junction?'ns-junction-wrap':''} ${selected===n.id?'is-selected':''}" data-node-id="${escape(n.id)}" data-lane-id="${escape(p.laneId)}" data-index="${p.index}" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px" role="listitem"`;
      const gap=n.type==='garment_input'?'':`<span class="ns-insert-target" data-insert-at="${p.index}" data-lane="${escape(p.laneId)}" aria-hidden="true"><span>插入此处</span></span>`;
      const head=`<span class="ns-node-head">${icon(nodeIcon(n.type))}<strong>${escape(n.label)}</strong></span>`;
      const face=p.junction?`<span class="ns-junction-symbol"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${junctionIcon(n.type)}</svg></span><strong>${escape(n.label)}</strong><small>${n.type==='branch_create'?getLanes(workflow).filter(l=>l.forkId===n.id).length+' 条路线':'收集方案'}</small>`:`${head}${preview(n)}<span class="ns-node-status" data-status="${escape(n.status)}"><i class="ns-status-dot"></i>${statusLabel(n)}<span class="ns-node-open-hint">双击进入 ↗</span></span>`;
      return `<div ${frame}>${gap}<div class="ns-slot ns-slot-top" data-host="${escape(n.id)}" data-slot="top">${(n.attachments?.top||[]).map(attachment).join('')}</div><button class="${p.junction?'ns-junction-card':'ns-node-card'}" style="${nodeStyle(d)}" data-node="${escape(n.id)}" draggable="${n.type!=='garment_input'&&!p.junction}" aria-pressed="${selected===n.id}" aria-label="${escape(n.label)}，双击进入工作区">${face}</button><div class="ns-slot ns-slot-bottom" data-host="${escape(n.id)}" data-slot="bottom">${(n.attachments?.bottom||[]).map(attachment).join('')}</div></div>`;
    }).join('')+
    layout.ends.map(e=>`<div class="ns-graph-end" data-insert-at="${e.at}" data-lane="${escape(e.laneId)}" style="left:${e.x}px;top:${e.y-28}px"><button data-lane-add="${escape(e.laneId)}" aria-label="${escape(e.label)}">${icon('plus')}</button><small>${escape(e.label)}</small></div>`).join('');
  element.querySelectorAll('[data-node],[data-attachment]').forEach(button=>{
    const id=button.dataset.node||button.dataset.attachment;
    button.onclick=e=>{e.stopPropagation();handlers.select(id);};
    button.ondblclick=e=>{e.preventDefault();e.stopPropagation();handlers.enter(id);};
    if(button.draggable)bindNodeDrag(button,{kind:'move',id});
  });
  element.querySelectorAll('[data-lane-select],[data-lane-add]').forEach(b=>b.onclick=e=>{e.stopPropagation();handlers.selectLane(b.dataset.laneSelect||b.dataset.laneAdd,!!b.dataset.laneAdd);});
  const dropAt=(event,laneId,at)=>{const data=readDrop(event),d=data&&definitionFor(catalog,data.type||findNode(workflow,data.id)?.type);if(!d||d.placement==='attachment')return;event.preventDefault();event.stopPropagation();handlers.drop(data,{laneId,at});finishNodeDrag();};
  const over=(event,target)=>{const data=readDrop(event),d=data&&definitionFor(catalog,data.type||findNode(workflow,data.id)?.type);if(!d||d.placement==='attachment')return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect=data.kind==='insert'?'copy':'move';element.querySelectorAll('.is-insert-active').forEach(t=>t.classList.remove('is-insert-active'));target.classList.add('is-insert-active');};
  element.querySelectorAll('[data-insert-at]').forEach(t=>{t.ondragover=e=>over(e,t);t.ondragleave=()=>t.classList.remove('is-insert-active');t.ondrop=e=>dropAt(e,t.dataset.lane,Number(t.dataset.insertAt));});
  element.querySelectorAll('.ns-node-wrap').forEach(w=>{
    const position=e=>Number(w.dataset.index)+(e.clientX>w.getBoundingClientRect().left+w.getBoundingClientRect().width*.5?1:0);
    w.ondragover=e=>{if(e.target.closest('.ns-slot,[data-insert-at]'))return;over(e,w);};
    w.ondragleave=()=>w.classList.remove('is-insert-active');
    w.ondrop=e=>{if(e.target.closest('.ns-slot,[data-insert-at]'))return;dropAt(e,w.dataset.laneId,position(e));};
  });
  element.querySelectorAll('.ns-slot').forEach(slot=>{
    const compatible=e=>{const data=readDrop(e),d=data&&definitionFor(catalog,data.type||findNode(workflow,data.id)?.type);return d&&d.placement!=='main'&&d.slot===slot.dataset.slot;};
    slot.ondragover=e=>{e.stopPropagation();if(!compatible(e))return;e.preventDefault();slot.classList.add('drop-active');};
    slot.ondragleave=()=>slot.classList.remove('drop-active');
    slot.ondrop=e=>{e.stopPropagation();if(!compatible(e))return;e.preventDefault();handlers.drop(readDrop(e),{hostId:slot.dataset.host,slot:slot.dataset.slot});finishNodeDrag();};
  });
  return layout;
}

/** Viewport zoom and pan are independent of workflow edits and persistence. */
export function createGraphViewport(viewport,element,{onChange=()=>{}}={}){
  const spacer=document.createElement('div');spacer.className='ns-graph-spacer';element.before(spacer);spacer.append(element);
  let zoom=1,bounds={width:900,height:440},pan=null;
  function apply(){element.style.transform=`scale(${zoom})`;spacer.style.width=`${bounds.width*zoom}px`;spacer.style.height=`${bounds.height*zoom}px`;onChange(zoom);}
  function setZoom(value,point){const next=Math.max(.25,Math.min(1.6,Number(value)||1)),rect=viewport.getBoundingClientRect(),px=point?point.x-rect.left:viewport.clientWidth/2,py=point?point.y-rect.top:viewport.clientHeight/2;const x=(viewport.scrollLeft+px)/zoom,y=(viewport.scrollTop+py)/zoom;zoom=next;apply();viewport.scrollLeft=x*zoom-px;viewport.scrollTop=y*zoom-py;}
  function fit(){setZoom(Math.min(1,(viewport.clientWidth-38)/bounds.width,(viewport.clientHeight-24)/bounds.height));viewport.scrollLeft=0;viewport.scrollTop=0;}
  viewport.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();setZoom(zoom*Math.exp(-e.deltaY*.003),{x:e.clientX,y:e.clientY});}else if(e.shiftKey){e.preventDefault();viewport.scrollLeft+=e.deltaY+e.deltaX;}},{passive:false});
  viewport.addEventListener('pointerdown',e=>{if(e.button!==1&&(e.button!==0||e.target.closest('button,.ns-node-wrap,.ns-slot')))return;pan={x:e.clientX,y:e.clientY,left:viewport.scrollLeft,top:viewport.scrollTop,id:e.pointerId};viewport.setPointerCapture(e.pointerId);viewport.classList.add('is-panning');e.preventDefault();});
  viewport.addEventListener('pointermove',e=>{if(!pan)return;viewport.scrollLeft=pan.left-(e.clientX-pan.x);viewport.scrollTop=pan.top-(e.clientY-pan.y);});
  const release=()=>{pan=null;viewport.classList.remove('is-panning');};viewport.addEventListener('pointerup',release);viewport.addEventListener('pointercancel',release);
  return{setBounds(next){bounds=next;apply();},setZoom,fit,getZoom:()=>zoom,focus(id){const target=element.querySelector(`[data-node-id="${id}"]`)||element.querySelector(`[data-route="${id}"]`);if(!target)return;const box=target.getBoundingClientRect(),v=viewport.getBoundingClientRect();viewport.scrollBy({left:box.left-v.left-(v.width-box.width)/2,top:box.top-v.top-(v.height-box.height)/2,behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth'});}};
}
