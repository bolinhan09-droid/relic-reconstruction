import {findNode, definitionFor} from '../core/model.js';
import {escape, icon, nodeIcon, safeImage} from './icons.js';
import {getWearMask, wearSeedForNode} from './wear-mask.js';
import {intentText} from '../core/text-input.js';

export const categories = [
  {id:'creation',label:'创作',color:'creation'}, {id:'ai',label:'AI 协作',color:'ai'},
  {id:'input',label:'输入',color:'input'}, {id:'context',label:'设定',color:'setting'},
  {id:'structure',label:'结构',color:'structure'}, {id:'production',label:'制作',color:'production'},
];
export function categoryOf(definition) {
  const type = definition.type || definition.id;
  if (['garment_input','image_reference'].includes(type)) return 'input';
  if (['scene_context','production_context'].includes(type)) return 'context';
  if (['quick_create','precision_edit','blend_create','region_generate','gesture_simulation','battle_simulation'].includes(type)) return 'creation';
  if (['garment_split','garment_flatten','flatten_map','branch_create','branch_merge'].includes(type)) return 'structure';
  if (['production_guide','stencil_export'].includes(type)) return 'production';
  return 'ai';
}
export const nodeStyle = definition => {
  const color = categories.find(cat=>cat.id===categoryOf(definition))?.color || 'input';
  const light = ['setting','structure'].includes(color);
  return `--node-color:var(--ns-${color});--node-soft:var(--ns-${color}-soft);--node-ink:${light?'var(--ns-ink)':'#fff8ec'};--node-strong:${light?'var(--ns-ink)':`var(--ns-${color})`};--node-wear:${light?'#788277':'#f8e8d4'}`;
};
const style = nodeStyle;
export const statusLabel = node => ({draft:'待准备',ready:'可以开始',prepared:'待生成',queued:'排队中',running:'处理中',succeeded:'已有输出',complete:'已有输出',completed:'已有输出',stale:'基于旧版本',failed:'未完成',planned:'待接入',experimental:'实验功能',not_implemented:'待接入',blocked:'待补充资料'}[node.status] || (node.output?'已有输出':'待准备'));
function capabilityLabel(definition) {return ({available:'可用',experimental:'实验',planned:'待接入',partial:'部分可用'}[definition.capability] || '可用');}
export function preview(node) {
  const output = node.output, image = safeImage((node.params?.preparationOnly && (output?.flatlayTarget?.url || node.params?.flatlayTarget?.url)) || output?.candidateImageUrl || output?.imageUrl || node.params?.front?.url || node.params?.reference?.url);
  const text = output?.kind === 'intent' ? intentText(output) : '';
  const summary = text ? `文字输出 · ${text.replace(/\s+/g,' ').slice(0,55)}${text.length>55?'…':''}` : output?.candidateImageUrl ? '新结果待采用' : output?.kind === 'generation_task' ? '创作任务已准备' : output?.report ? '查看检查与建议' : output?.kind === 'guide' ? '制作指导' : output?.kind === 'fabrication' ? '模板文件已准备' : '';
  const wear = getWearMask(wearSeedForNode(node), {width:640, height:352});
  const surface = wear.surfaceUrl ? `<span class="ns-wear-surface" style="--wear-surface:url('${wear.surfaceUrl}')" aria-hidden="true"></span>` : '';
  return `<div class="ns-node-preview" data-preview="${escape(node.id)}" data-wear-angle="${Number(wear.angle).toFixed(2)}">${image ? `<div class="ns-wear-reveal" style="--wear-mask:url('${wear.maskUrl}')"><img src="${escape(image)}" alt="${escape(node.label)}的输出预览" draggable="false"></div>` : `<div class="ns-node-empty">${icon(nodeIcon(node.type))}<small>${summary?escape(summary):'双击开始'}</small></div>`}${surface}${summary&&image ? `<span class="ns-node-summary">${escape(summary)}</span>` : ''}</div>`;
}
let activePayload = null;
const payloadIsValid = value => value && ((value.kind === 'insert' && typeof value.type === 'string') || (['move','route'].includes(value.kind) && typeof value.id === 'string'));
export function readDrop(event) {
  try {
    const value = JSON.parse(event.dataTransfer.getData('application/x-relic-node'));
    if (payloadIsValid(value)) return value;
  } catch {}
  // Native dragover protects DataTransfer contents until the final drop.
  return activePayload ? {...activePayload} : null;
}
export function finishNodeDrag() {
  activePayload = null;
  document.body.classList.remove('ns-dragging', 'ns-drag-moving');
  document.querySelectorAll('.dragging,.drop-before,.drop-active,.is-insert-active,.is-return-active').forEach(element => element.classList.remove('dragging','drop-before','drop-active','is-insert-active','is-return-active'));
  window.dispatchEvent(new CustomEvent('relic-node-drag-end'));
}
export function bindNodeDrag(element, payload) {
  element.ondragstart = event => {
    if (element.draggable === false) {event.preventDefault();return;}
    const rect=element.getBoundingClientRect();
    activePayload = {...payload,grabX:rect.width?Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)):.5,grabY:rect.height?Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height)):.5};
    event.dataTransfer.setData('application/x-relic-node',JSON.stringify(activePayload));
    event.dataTransfer.setData('text/plain',payload.id || payload.type);
    event.dataTransfer.effectAllowed = payload.kind === 'insert' ? 'copy' : 'move';
    element.classList.add('dragging');element.closest('.ns-node-wrap')?.classList.add('dragging');
    document.body.classList.add('ns-dragging');
    if(payload.kind === 'move') document.body.classList.add('ns-drag-moving');
    window.dispatchEvent(new CustomEvent('relic-node-drag-start',{detail:{...payload}}));
  };
  element.ondragend = finishNodeDrag;
}
export function ribbonGapAt(element, workflow, clientX) {
  for (let index = 0; index < workflow.order.length; index++) {
    const wrap = element.querySelector(`[data-node-id="${workflow.order[index]}"]`);
    if (!wrap) continue;
    const rect = wrap.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return Math.max(1,index);
  }
  return workflow.order.length;
}
export function highlightRibbonGap(element, index) {
  element.querySelectorAll('.is-insert-active').forEach(item=>item.classList.remove('is-insert-active'));
  element.querySelector(`[data-insert-at="${index}"]`)?.classList.add('is-insert-active');
}
function dropDefinition(data, workflow, catalog) {
  return definitionFor(catalog,data?.type || findNode(workflow,data?.id)?.type);
}
export function renderRibbon(element, workflow, catalog, handlers) {
  const selected = workflow.selectedNodeId;
  const attachment = id => {
    const node = findNode(workflow,id), def = node && definitionFor(catalog,node.type);
    if (!def) return '';
    return `<button class="ns-attachment ${selected===id?'selected':''}" draggable="true" data-attachment="${escape(id)}" style="${style(def)}" title="${escape(node.label)} · 双击进入">${icon(nodeIcon(node.type))}${escape(node.label)}</button>`;
  };
  element.innerHTML = workflow.order.map((id,index) => {
    const node = findNode(workflow,id), def = definitionFor(catalog,node.type);
    if (!def) return '';
    return `<div class="ns-node-wrap ${selected===id?'is-selected':''}" role="listitem" data-node-id="${escape(id)}">
      ${index>0?`<span class="ns-insert-target" data-insert-at="${index}" aria-hidden="true"><span>插入此处</span></span>`:''}
      <div class="ns-slot ns-slot-top" data-host="${escape(id)}" data-slot="top">${(node.attachments?.top||[]).map(attachment).join('')}</div>
      <button class="ns-node-card" style="${style(def)}" draggable="${index>0}" data-node="${escape(id)}" aria-label="${escape(node.label)}，${statusLabel(node)}，按空格进入" aria-pressed="${selected===id}"><span class="ns-node-head">${icon(nodeIcon(node.type))}<strong>${escape(node.label)}</strong><span class="ns-node-number">${String(index+1).padStart(2,'0')}</span></span>${preview(node)}<span class="ns-node-status" data-status="${escape(node.status)}"><i class="ns-status-dot"></i>${capabilityLabel(def)==='待接入'?'待接入':capabilityLabel(def)==='实验'?'实验 · ':''}${statusLabel(node)}</span></button>
      <div class="ns-slot ns-slot-bottom" data-host="${escape(id)}" data-slot="bottom">${(node.attachments?.bottom||[]).map(attachment).join('')}</div>
    </div>`;
  }).join('') + `<div class="ns-add-step"><span class="ns-insert-target ns-insert-end" data-insert-at="${workflow.order.length}" aria-hidden="true"><span>插入此处</span></span><button id="addStepHint" aria-label="选择下一个工作区">${icon('plus')}</button><small>接下来，做什么？</small></div>`;
  element.querySelectorAll('[data-node],[data-attachment]').forEach(button => {
    const id = button.dataset.node || button.dataset.attachment;
    button.onclick = () => handlers.select(id);
    button.ondblclick = () => handlers.enter(id);
    bindNodeDrag(button,{kind:'move',id});
  });
  const acceptMain = event => {
    const data=readDrop(event),def=dropDefinition(data,workflow,catalog);
    return !!def && def.placement !== 'attachment' && (data.kind !== 'move' || findNode(workflow,data.id)?.type !== 'garment_input');
  };
  const mainOver = (event, at) => {
    if(!acceptMain(event))return;
    event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect=readDrop(event).kind==='insert'?'copy':'move';
    highlightRibbonGap(element,at);
  };
  const mainDrop = (event, at) => {
    if(!acceptMain(event))return;
    event.preventDefault();event.stopPropagation();const data=readDrop(event);
    handlers.drop(data,{at,afterId:workflow.order[Math.max(0,at-1)]});finishNodeDrag();
  };
  element.querySelectorAll('[data-insert-at]').forEach(target=>{
    target.ondragover=event=>mainOver(event,Number(target.dataset.insertAt));
    target.ondrop=event=>mainDrop(event,Number(target.dataset.insertAt));
  });
  element.querySelectorAll('.ns-node-wrap,.ns-add-step').forEach(wrap => {
    wrap.ondragover = event => {if(event.target.closest('.ns-slot,[data-insert-at]'))return;mainOver(event,ribbonGapAt(element,workflow,event.clientX));};
    wrap.ondrop = event => {if(event.target.closest('.ns-slot,[data-insert-at]'))return;mainDrop(event,ribbonGapAt(element,workflow,event.clientX));};
  });
  element.querySelectorAll('.ns-slot').forEach(slot => {
    const compatible=event=>{const def=dropDefinition(readDrop(event),workflow,catalog);return def&&def.placement!=='main'&&def.slot===slot.dataset.slot;};
    slot.ondragover=event=>{event.stopPropagation();if(!compatible(event))return;event.preventDefault();element.querySelectorAll('.is-insert-active').forEach(item=>item.classList.remove('is-insert-active'));slot.classList.add('drop-active');};
    slot.ondragleave=event=>{if(!slot.contains(event.relatedTarget))slot.classList.remove('drop-active');};
    slot.ondrop=event=>{event.stopPropagation();if(!compatible(event))return;event.preventDefault();slot.classList.remove('drop-active');const data=readDrop(event);if(data)handlers.drop(data,{hostId:slot.dataset.host,slot:slot.dataset.slot});finishNodeDrag();};
  });
  element.querySelector('#addStepHint').onclick=()=>document.getElementById('nodeLibrary').scrollIntoView({block:'nearest',behavior:'smooth'});
}
export function renderLibrary(element,catalog,category,onAdd) {
  element.innerHTML=catalog.filter(def=>categoryOf(def)===category).map(def=>`<button class="ns-bookmark" style="${style(def)}" draggable="true" data-type="${escape(def.type||def.id)}" data-capability="${escape(def.capability)}" title="${escape(def.description)}">${icon(nodeIcon(def.type||def.id))}<strong>${escape(def.label)}</strong>${def.capability==='available'?'':`<small>${capabilityLabel(def)}</small>`}</button>`).join('');
  element.querySelectorAll('[data-type]').forEach(button=>{
    button.onclick=()=>onAdd(button.dataset.type);
    bindNodeDrag(button,{kind:'insert',type:button.dataset.type});
  });
}
