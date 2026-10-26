import {api, upload} from './core/api.js';
import {copy,uid,makeNode,findNode,definitionFor,insertNode,detachNode,moveNode,moveNodeToGap,patchNode,commitNode,restoreVersion,upstreamOutput,assertWorkflow,markAfter,getLanes,laneForNode,createBranchGroup,addBranch as addBranchRoute,renameBranch as renameBranchRoute,precedingNodeIds,placeNodeOnCanvas,insertNodeOnCanvas,positionRoute,makeStandardWorkflow} from './core/model.js';
import {WorkflowPersistence} from './core/persistence.js';
import {GenerationTracker} from './core/job-tracker.js';
import {escape,icon,safeImage} from './components/icons.js';
import {categories,categoryOf,statusLabel,renderLibrary,readDrop,bindNodeDrag,finishNodeDrag} from './components/ribbon.js';
import {mountWorkspace} from './workspaces/index.js';
import {openLegacyWorkspace} from './adapters/legacy-bridge.js';
import {createEntryExperience} from './components/entry-experience.js';
import {renderGraph,graphLayout,createGraphViewport} from './components/graph-canvas.js';
import {mountGlobalAiSettings} from './components/global-ai-settings.js';
import {mountApiGuide} from './components/api-guide.js';
import {createGuidedPractice} from './components/guided-practice.js';
import {appendMakingRoute} from './core/making-route.js';

const $=id=>document.getElementById(id);
const entryFrontPlaceholder=$('frontPreview').innerHTML;
let catalog=[],workflow=null,category='creation',front=null,back=null,workspace=null,legacy=null,currentWorkspaceId=null,toastTimer,booting=false,runBusy=false,pendingStudioRender=false,workspaceLifetime=null,workspaceTransition=0;
let catalogReady=false,projectOpening=false,historyRequest=0,addingPictures=false;
let workspaceSaveTask=null,workspaceEntryRequest=0;
const uploadTickets={front:0,back:0},uploadPending={front:false,back:false};
const entryExperience=createEntryExperience({openProject,deleteProject,onRetryHistory:refreshEntryHistory});
const persistence=new WorkflowPersistence(api,text=>$('saveState').textContent=text);
const globalAiSettings=mountGlobalAiSettings({api,notify});
const apiGuide=mountApiGuide({openSettings:section=>globalAiSettings.open(section)});
const tracker=new GenerationTracker({api,getWorkflow:()=>workflow,updateWorkflow:async next=>{changed(next);await saveWorkflow();},onUpdate:(nodeId,output)=>{window.dispatchEvent(new CustomEvent('relic-node-job-updated',{detail:{nodeId,output}}));if(currentWorkspaceId===nodeId)$('workspaceStatus').textContent=output.jobStatus==='succeeded'?'已显示新结果':output.jobStatus||'任务已更新';},notify:message=>notify(message)});
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const graphViewport=createGraphViewport($('ribbonViewport'),$('ribbon'),{onChange:zoom=>{if($('zoomValue'))$('zoomValue').textContent=Math.round(zoom*100)+'%';}});
const practice=createGuidedPractice({getState:practiceState,prepare:preparePractice,openNode:enterWorkspace,saveEditor:()=>saveCurrentWorkspace(true),leaveEditor:leaveWorkspace,focusNode,notify});

function practiceState(){
  let editor={ready:false,strokeCount:0};
  try{editor=legacy?.iframe?.contentWindow?.RelicNodeWorkspace?.getPracticeState?.()||editor;}catch{/* An iframe may be closing. */}
  return{workflow,workspaceId:currentWorkspaceId,ready:!!legacy?.ready&&editor.ready,strokeCount:editor.strokeCount||0,unsaved:!!legacy?.hasUnsavedChanges?.()};
}
async function preparePractice(savedId){
  if(!catalogReady||booting||projectOpening||runBusy||addingPictures)throw Error('创作台正在准备，请稍后开始练习');
  projectOpening=true;
  try{
    await leaveWorkspace(false);if(currentWorkspaceId)throw Error('请先保存当前工作区，再开始练习');
    if(workflow)await saveWorkflow();
    let next;
    if(savedId){
      try{const response=await api('GET',`/api/node-studio/workflows/${encodeURIComponent(savedId)}`);const candidate=response.workflow||response;
        if(candidate.context?.guidedPractice==='v1'&&candidate.nodes?.some(n=>n.type==='precision_edit')&&candidate.nodes.some(n=>n.type==='production_guide'))next=candidate;
      }catch(error){if(error.status!==404)throw error;}
    }
    if(!next){
      const image=await fetch('/resources/garments/demo_coat_front.png');if(!image.ok)throw Error('示例服装暂不可用，请重试');
      const asset={...await upload(new File([await image.blob()],'新手练习服装.png',{type:'image/png'})),name:'新手练习服装'};
      const input=makeNode('garment_input',catalog,{front:asset,back:null});input.output={kind:'garment',imageUrl:asset.url||asset.imageUrl,reference:asset,front:asset,back:null};input.status='completed';
      const edit=makeNode('precision_edit',catalog),making=makeNode('production_guide',catalog);
      const initial={schemaVersion:1,branches:[],routes:[],selectedLaneId:'main',title:'新手练习',nodes:[input,edit,making],order:[input.id,edit.id,making.id],stash:[],selectedNodeId:edit.id,context:{guidedPractice:'v1'},assets:[asset]};
      const response=await api('POST','/api/node-studio/workflows',initial);next=response.workflow||response;
    }
    assertWorkflow(next);workflow=next;persistence.bind(workflow);entryExperience.cancelTransition();
    $('entry').hidden=true;$('studio').hidden=false;renderStudio();renderDock();graphViewport.fit();
    for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
    localStorage.setItem('relic-node-last-project',workflow.id);$('saveState').textContent='练习已保存到本机';return practiceState();
  }finally{projectOpening=false;}
}
function notify(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,4300);}
function selected(){return workflow&&findNode(workflow,workflow.selectedNodeId);}
function saveSucceeded(saved,replace){if(workflow?.id!==saved.id)return;if(replace)workflow=saved;else workflow.revision=saved.revision;}
function changed(next,{render=true}={}){assertWorkflow(next);workflow=next;persistence.changed(()=>workflow,saveSucceeded);if(render){if(document.body.classList.contains('ns-dragging'))pendingStudioRender=true;else renderStudio();}}
async function saveWorkflow(){if(!workflow)return;return persistence.save(()=>workflow,saveSucceeded);}
function focusNode(id=workflow?.selectedNodeId){const host=workflow?.nodes.find(n=>Object.values(n.attachments||{}).some(ids=>ids.includes(id)));graphViewport.focus(host?.id||id);}
function currentLane(){return getLanes(workflow).find(l=>l.id===workflow.selectedLaneId)||laneForNode(workflow,workflow.selectedNodeId)||getLanes(workflow)[0];}
function select(id){workflow.selectedNodeId=id;const host=workflow.nodes.find(n=>Object.values(n.attachments||{}).some(ids=>ids.includes(id)));const lane=laneForNode(workflow,id)||laneForNode(workflow,host?.id);if(lane)workflow.selectedLaneId=lane.id;updateSelection();}
function selectLane(id,showLibrary=false){const lane=getLanes(workflow).find(l=>l.id===id);if(!lane)return;workflow.selectedLaneId=id;workflow.selectedNodeId=lane.order.at(-1)||lane.forkId||workflow.order[0];updateSelection();if(showLibrary){category='creation';renderDock();$('nodeLibrary').querySelector('button')?.focus({preventScroll:true});notify(`下一步将加入「${lane.label}」。从下方选择工作区。`);}}
function updateSelection(){
  if(!workflow)return;const node=selected(),def=node&&definitionFor(catalog,node.type),lane=currentLane();
  $('ribbon').querySelectorAll('[data-node-id]').forEach(w=>w.classList.toggle('is-selected',w.dataset.nodeId===node?.id));
  $('ribbon').querySelectorAll('[data-node],[data-attachment]').forEach(b=>{const yes=(b.dataset.node||b.dataset.attachment)===node?.id;b.setAttribute('aria-pressed',String(yes));b.classList.toggle('selected',yes);});
  $('ribbon').querySelectorAll('[data-route]').forEach(b=>b.classList.toggle('is-active',b.dataset.route===lane?.id));
  $('selectionTitle').textContent=node?.label||'选择一个节点';$('selectionDescription').textContent=node?statusLabel(node):'';
  const junction=['branch_create','branch_merge'].includes(node?.type),index=lane?.order.indexOf(node?.id)??-1;
  const mainInput=node?.type==='garment_input'&&workflow.order[0]===node.id;
  $('detachButton').disabled=!node||mainInput||junction;
  $('floatButton').disabled=!node||mainInput||junction;
  $('connectButton').disabled=!node||mainInput||junction||def?.placement==='attachment';
  $('leftButton').disabled=!node||junction||node.type==='garment_input'||index<=(lane?.id==='main'?1:0);
  $('rightButton').disabled=!node||junction||node.type==='garment_input'||index<0||index>=lane.order.length-1;
  if($('branchButton'))$('branchButton').disabled=!node||node.type==='branch_create'||!laneForNode(workflow,node.id);
}
function renderStudio(){
  if(!workflow)return;
  $('projectTitleButton').textContent=workflow.title||'未命名创作';
  const layout=renderGraph($('ribbon'),workflow,catalog,{select,selectLane,enter:enterWorkspace,drop:dropNode});graphViewport.setBounds(layout);updateSelection();
  $('stashCount').textContent=String((workflow.stash||[]).length);
  renderShelf();
  $('workflowStats').textContent=`${getLanes(workflow).reduce((sum,l)=>sum+l.order.length,0)} 个节点 · ${(workflow.routes||[]).length+1} 条独立路线`;
}
function renderDock(){
  $('categoryTabs').innerHTML=categories.map(cat=>`<button class="ns-category-tab ${category===cat.id?'active':''}" data-category="${cat.id}" role="tab" aria-selected="${category===cat.id}">${cat.label}</button>`).join('');
  $('categoryTabs').querySelectorAll('[data-category]').forEach(button=>button.onclick=()=>{category=button.dataset.category;renderDock();});
  renderLibrary($('nodeLibrary'),catalog,category,type=>addNode(type));
}
function restoreShelfNode(id){
  try{
    const node=findNode(workflow,id),def=node&&definitionFor(catalog,node.type);
    if(!node||!def)throw Error('方案架中的节点不存在。');
    const lane=currentLane(),host=lane.order.includes(workflow.selectedNodeId)?workflow.selectedNodeId:lane.order.at(-1)||lane.forkId||workflow.order[0];
    changed(def.placement==='attachment'?attachExisting(workflow,id,host,def.slot||'top'):moveNodeToGap(workflow,id,lane.order.length,catalog,lane.id));
    focusNode(id);notify('节点已重新接入，原有输出仍然保留。');
  }catch(error){notify(error.message);}
}
function renderShelf(){
  const tray=$('stashTray');if(!tray)return;
  const nodes=(workflow?.stash||[]).map(id=>findNode(workflow,id)).filter(Boolean);
  tray.innerHTML=nodes.length?nodes.map(node=>{
    const image=safeImage(node.output?.imageUrl||node.params?.front?.url);
    return `<article class="ns-shelf-card" draggable="true" data-shelf-node="${escape(node.id)}" title="拖到主线连接处重新接入，输出会保留"><span class="ns-shelf-preview">${image?`<img src="${escape(image)}" alt="${escape(node.label)}的保留结果" draggable="false">`:icon('history')}</span><strong>${escape(node.label)}</strong><button class="ns-shelf-restore" data-shelf-restore="${escape(node.id)}" aria-label="重新接入${escape(node.label)}" title="接入主线末尾或当前侧槽">↗</button></article>`;
  }).join(''):'<div class="ns-shelf-empty"><span aria-hidden="true">↙</span><p>把节点拖回这里<br><small>暂时撤下，保留输出</small></p></div>';
  tray.querySelectorAll('[data-shelf-node]').forEach(card=>bindNodeDrag(card,{kind:'move',id:card.dataset.shelfNode}));
  tray.querySelectorAll('[data-shelf-restore]').forEach(button=>button.onclick=()=>restoreShelfNode(button.dataset.shelfRestore));
}
function returnNodeToShelf(id){
  if(!workflow||!findNode(workflow,id))return;
  if(workflow.stash?.includes(id)){notify('这个节点已经在方案架中。');return;}
  changed(detachNode(workflow,id));notify('节点已放回方案架，输出与历史都保留。');
}
function attachExisting(current,id,hostId,slot){
  const next=copy(current),node=findNode(next,id),host=findNode(next,hostId),def=node&&definitionFor(catalog,node.type);
  if(!node||!host||id===hostId||!laneForNode(next,hostId))throw Error('请选择路线上的其他节点作为宿主。');
  if(node.type==='garment_input'||def.placement==='main')throw Error('这张节点应横向连接，不能作为侧边附件。');
  if((def.slot||'bottom')!==slot)throw Error(slot==='top'?'这里接参考与设定，请放到下方 AI 插槽。':'这里接 AI 协作，请放到上方参考插槽。');
  if(Object.values(node.attachments||{}).some(ids=>ids.length))throw Error('请先撤下这个节点携带的附件。');
  for(const item of next.nodes)for(const side of ['top','bottom'])if(item.attachments?.[side])item.attachments[side]=item.attachments[side].filter(value=>value!==id);
  next.order=next.order.filter(value=>value!==id);for(const lane of [...(next.routes||[]),...(next.branches||[])])lane.order=lane.order.filter(value=>value!==id);next.routes=(next.routes||[]).filter(lane=>lane.order.length);next.stash=(next.stash||[]).filter(value=>value!==id);host.attachments[slot].push(id);next.selectedNodeId=id;next.selectedLaneId=laneForNode(next,hostId).id;markAfter(next,hostId);return next;
}
function openCanvasPosition(){
  const layout=graphLayout(workflow),low=Math.max(100,...layout.nodes.map(node=>node.y+node.h))+100;
  return{x:64,y:low};
}
function floatSelected(){
  try{if(!selected())return;changed(placeNodeOnCanvas(workflow,workflow.selectedNodeId,openCanvasPosition()));focusNode();notify('已放到画布，输出保留');}catch(error){notify(error.message);}
}
function openConnectDialog(){
  const node=selected();if(!node)return;
  const options=[];
  for(const lane of getLanes(workflow)){
    const min=lane.id==='main'||['garment_input','image_reference'].includes(findNode(workflow,lane.order[0])?.type)?1:0;
    for(let at=min;at<=lane.order.length;at++){
      if(lane.order[at-1]===node.id||lane.order[at]===node.id||findNode(workflow,lane.order[at-1])?.type==='branch_create')continue;
      const before=findNode(workflow,lane.order[at-1]),label=`${lane.label||'路线'} · ${before?'接在「'+before.label+'」之后':'路线起点'}`;
      options.push({laneId:lane.id,at,label});
    }
  }
  $('connectTarget').innerHTML=options.map((o,i)=>`<option value="${i}">${escape(o.label)}</option>`).join('');
  $('confirmConnect').disabled=!options.length;
  $('confirmConnect').onclick=()=>{try{const target=options[Number($('connectTarget').value)];if(!target)return;changed(moveNodeToGap(workflow,node.id,target.at,catalog,target.laneId));$('connectDialog').close();focusNode(node.id);notify('节点已接入');}catch(error){notify(error.message);}};
  $('connectDialog').showModal();
}
async function addPictureFiles(files,type){
  if(!workflow||addingPictures||!files?.length)return;
  addingPictures=true;const projectId=workflow.id;
  $('addGarmentButton').disabled=true;$('addReferenceButton').disabled=true;
  try{
    for(const file of Array.from(files)){
      const asset={...await upload(file),name:file.name};
      if(workflow?.id!==projectId)throw Error('创作已切换，请在当前画布重新添加图片');
      let next=insertNodeOnCanvas(workflow,type,catalog,openCanvasPosition()),node=findNode(next,next.selectedNodeId);
      if(type==='garment_input'){
        node.params={...node.params,front:asset,back:null};
        node.output={kind:'garment',imageUrl:asset.url||asset.imageUrl,reference:asset,front:asset,back:null};
      }else{
        node.params={...node.params,references:[asset],activeReferenceIndex:0};
        node.output={kind:'reference',imageUrl:asset.url||asset.imageUrl,reference:asset,references:[asset],activeReferenceIndex:0};
      }
      node.status='completed';next.assets=[...(next.assets||[]),asset];
      const route=next.routes.find(l=>l.order.includes(node.id));if(route)route.label=file.name.replace(/\.[^.]+$/,'').slice(0,40)||node.label;
      changed(next);
    }
    await saveWorkflow();focusNode();notify('图片已加入，可从每张图片继续创作');
  }catch(error){notify(error.message);}finally{addingPictures=false;$('addGarmentButton').disabled=false;$('addReferenceButton').disabled=false;}
}
function forkFromSelected(position={}){try{const node=selected();let host=laneForNode(workflow,node?.id)?node?.id:workflow.nodes.find(n=>Object.values(n.attachments||{}).some(ids=>ids.includes(node?.id)))?.id;if(position.laneId){const lane=getLanes(workflow).find(l=>l.id===position.laneId);host=position.afterId||lane?.order[(position.at??lane.order.length)-1];if(!host)throw Error('请把分支放在这条路线的一个步骤之后。');}if(!host)throw Error('先选择一个已接入路线的节点。');changed(createBranchGroup(workflow,host,catalog));graphViewport.fit();notify('原后续保留在方案 A；方案 B 从这个位置独立探索。');}catch(error){notify(error.message);}}
function addNode(type,position={}){
  try{
    if(!workflow)return;
    if(position.canvas||(['garment_input','image_reference'].includes(type)&&!position.hostId&&!position.laneId&&!Number.isInteger(position.at))){
      changed(insertNodeOnCanvas(workflow,type,catalog,position.canvas||openCanvasPosition()));focusNode();notify('节点已放到画布');return;
    }
    if(type==='branch_create'){forkFromSelected(position);return;}
    if(type==='branch_merge'){const lane=currentLane(),fork=lane.forkId||selected()?.params?.forkId;const merge=workflow.nodes.find(n=>n.type==='branch_merge'&&n.params?.forkId===fork);if(merge){select(merge.id);focusNode(merge.id);notify('这组路线已经有合拢节点，双击查看候选。');}else notify('先加入分支节点，合拢节点会一起放在路线末端。');return;}
    const def=definitionFor(catalog,type),node=selected();let afterId=node?.id;
    if(!laneForNode(workflow,afterId))afterId=workflow.nodes.find(host=>Object.values(host.attachments||{}).some(ids=>ids.includes(afterId)))?.id;
    let lane=getLanes(workflow).find(l=>l.id===position.laneId)||currentLane();
    if(node?.type==='branch_create'&&!position.laneId){lane=(workflow.branches||[]).find(l=>l.id===workflow.selectedLaneId&&l.forkId===node.id)||(workflow.branches||[]).find(l=>l.forkId===node.id)||lane;}
    if(!lane.order.includes(afterId))afterId=lane.order.at(-1);
    if(position.hostId&&def.placement==='main')throw Error('这个工作区应放到横向主线。');
    if(position.slot&&(def.slot||'bottom')!==position.slot)throw Error('插槽不匹配：上方放参考与设定，下方放 AI 协作。');
    const hostId=position.hostId||(def.placement==='attachment'?(afterId||lane.forkId||workflow.order[0]):undefined);
    const next=insertNode(workflow,type,catalog,{afterId,laneId:lane.id,...position,...(hostId?{hostId}:{})});if(hostId)next.selectedLaneId=laneForNode(next,hostId).id;changed(next);focusNode();notify('节点已接好，双击输出区域进入工作台。');
  }catch(error){notify(error.message);}
}
function dropNode(data,position={}){
  try{
    if(!workflow||!data)return;
    if(position.canvas){
      if(data.kind==='route'){changed(positionRoute(workflow,data.id,position.canvas));return;}
      if(data.kind==='insert')return addNode(data.type,position);
      changed(placeNodeOnCanvas(workflow,data.id,position.canvas));notify('已放到画布，输出保留');return;
    }
    const def=definitionFor(catalog,data.type||findNode(workflow,data.id)?.type);
    if(!def)throw Error('这个节点暂未登记。');
    if(!position.hostId&&def.placement==='attachment')throw Error('这张参考卡请放进主线节点的上方侧槽。');
    if(data.kind==='insert')return addNode(data.type,position);
    if(data.kind==='move'){
      const lane=getLanes(workflow).find(l=>l.id===position.laneId)||currentLane();changed(position.hostId?attachExisting(workflow,data.id,position.hostId,position.slot):moveNodeToGap(workflow,data.id,position.at??lane.order.length,catalog,lane.id));
      focusNode(data.id);notify('节点已接入指定位置，已有输出仍然保留。');
    }
  }catch(error){notify(error.message);}finally{finishNodeDrag();}
}
// Empty space always means independent placement. Only a visible card, gap or
// connector can connect steps; being near a route never changes dependencies.
function backgroundDropPosition(event,data){
  const point=graphViewport.clientToWorld(event.clientX,event.clientY);
  if(data.kind==='route')return{canvas:{x:Math.max(24,point.x-54),y:Math.max(56,point.y+25)}};
  return{canvas:{x:Math.max(24,point.x-340*(data.grabX??.5)),y:Math.max(56,point.y-220*(data.grabY??.5))}};
}
async function setEntryFile(file,side){
  if(booting||projectOpening)return;
  const ticket=++uploadTickets[side];uploadPending[side]=true;
  entryExperience.uploadState({pending:true,hasImage:!!front,message:side==='front'?'正在放入正面照片…':'正在补充背面照片…'});
  try{
    const asset=await upload(file);if(ticket!==uploadTickets[side])return;
    if(side==='front'){front={...asset,name:file.name};$('frontPreview').innerHTML=`<img src="${escape(safeImage(asset.url||asset.imageUrl))}" alt="待创作的服装正面">`;$('frontLabel').textContent=file.name;}
    else{back={...asset,name:file.name};$('backPreview').innerHTML=`<img src="${escape(safeImage(asset.url||asset.imageUrl))}" alt="服装背面">`;}
    uploadPending[side]=false;
    entryExperience.uploadState({pending:uploadPending.front||uploadPending.back,hasImage:!!front,message:uploadPending.front||uploadPending.back?'正在放入照片…':front?'照片已就位。开始创作后，它会成为你的第一张标签。':''});
  }catch(error){if(ticket!==uploadTickets[side])return;uploadPending[side]=false;entryExperience.uploadState({pending:uploadPending.front||uploadPending.back,hasImage:!!front,message:error.message,error:true});notify(error.message);}
}
async function start(){
  if(!front||booting||projectOpening||!catalogReady||uploadPending.front||uploadPending.back)return;booting=true;$('startButton').disabled=true;$('startButton').setAttribute('aria-busy','true');$('entryStatus').textContent='正在建立你的创作…';
  try{
    const input=makeNode('garment_input',catalog,{front,back});
    input.output={kind:'garment',imageUrl:front.url||front.imageUrl,reference:front,front,back};input.status='completed';
    const scene=makeNode('scene_context',catalog,{character:'',scene:'',bloodColor:'#782c2b',canonStatus:'user_defined'});
    input.attachments.top.push(scene.id);
    let initial={schemaVersion:1,branches:[],routes:[],selectedLaneId:'main',title:'我的战损创作',nodes:[input,scene],order:[input.id],stash:[],selectedNodeId:input.id,context:{},assets:[front,...(back?[back]:[])]};
    if(document.querySelector('[name="workflowStart"]:checked')?.value!=='blank')initial=makeStandardWorkflow(initial,catalog);
    const result=await api('POST','/api/node-studio/workflows',initial);
    workflow=result.workflow||result;persistence.bind(workflow);
    if(!workflow.nodes?.length)throw Error('工作流创建未完成。');
    await entryExperience.transitionToStudio({source:$('frontPreview').querySelector('img'),show:()=>{$('entry').hidden=true;$('studio').hidden=false;renderStudio();renderDock();},target:()=>$('ribbon').querySelector('.ns-wear-reveal img')||$('ribbon').querySelector('.ns-node-preview')});
    graphViewport.fit();localStorage.setItem('relic-node-last-project',workflow.id);$('saveState').textContent='已保存到本机';notify(initial.order.length>1?'标准流程已就位，双击节点开始':'空白画布已准备');
  }catch(error){entryExperience.cancelTransition();notify(error.message);$('entryStatus').textContent=error.message;$('entry').hidden=false;$('studio').hidden=true;}finally{booting=false;$('startButton').disabled=!front;$('startButton').removeAttribute('aria-busy');}
}
function abortedWorkspace(){return new DOMException('这个工作区已关闭或切换，旧操作没有继续。','AbortError');}
function isWorkspaceActive(scope){return !!scope&&workspaceLifetime===scope&&!scope.controller.signal.aborted&&scope.ticket===workspaceTransition&&workflow?.id===scope.workflowId&&currentWorkspaceId===scope.nodeId&&!!findNode(workflow,scope.nodeId);}
function assertWorkspaceActive(scope){if(!isWorkspaceActive(scope))throw abortedWorkspace();}
async function saveCurrentWorkspace(announce=false){
  if(workspaceSaveTask)return workspaceSaveTask;
  const scope=workspaceLifetime,currentLegacy=legacy,currentWorkspace=workspace;
  if(!scope||!isWorkspaceActive(scope))return;
  const task=(async()=>{
    $('saveWorkspace').disabled=true;$('workspaceStatus').textContent='正在保存…';
    try{
      if(currentLegacy?.save)await currentLegacy.save();else await currentWorkspace?.save?.();
      assertWorkspaceActive(scope);await saveWorkflow();assertWorkspaceActive(scope);
      $('workspaceStatus').textContent='已保存';if(announce)notify('创作已保存到本机。');
    }finally{if(isWorkspaceActive(scope))$('saveWorkspace').disabled=false;}
  })();
  workspaceSaveTask=task;
  try{return await task;}finally{if(workspaceSaveTask===task)workspaceSaveTask=null;}
}
function workspaceContext(id,scope){
  const node=findNode(workflow,id),definition=definitionFor(catalog,node.type);
  const active=()=>assertWorkspaceActive(scope);
  const saveScoped=async()=>{if(!(scope.closing&&workflow?.id===scope.workflowId))active();return saveWorkflow();};
  const scopedApi=async(...args)=>{active();const result=await api(...args);active();return result;};
  return {workflow,node,definition,catalog,api:scopedApi,signal:scope.controller.signal,headerActions:$('workspaceActions'),setStatus:message=>{if(isWorkspaceActive(scope))$('workspaceStatus').textContent=message;},isActive:()=>isWorkspaceActive(scope),notify:message=>{if(isWorkspaceActive(scope))notify(message);},
    getWorkflow:()=>{active();return copy(workflow);},
    startMaking:async()=>{active();await saveCurrentWorkspace();active();const result=appendMakingRoute(workflow,id,catalog);changed(result.workflow,{render:false});await saveScoped();active();notify(result.created?'制作路线已接好':'打开已有制作路线');await enterWorkspace(result.firstId);return result.firstId;},
    openNode:async nodeId=>{active();if(!findNode(workflow,nodeId))throw Error('这个节点已不在当前方案中');await saveCurrentWorkspace();active();return enterWorkspace(nodeId);},
    setResearchConsent:async consent=>{
      active();
      if(!consent||typeof consent!=='object'||Object.keys(consent).some(key=>!['sendThumbnail','provider','baseUrl','grantedAt'].includes(key))||typeof consent.sendThumbnail!=='boolean')throw Error('看图授权格式不正确。');
      const next=copy(workflow);next.context={...next.context,researchConsent:copy(consent)};changed(next,{render:false});const saved=await saveScoped();active();return saved;
    },
    updateResearchDraft:async patch=>{
      active();
      const keys=new Set(['identification','imageFingerprint','sourceImageHash','sourceImageUrl','identifiedCandidates','candidates','autoIdentifyAttemptedFor','draftCharacter','sceneCandidates','researchSources','researchResult','researchError','identificationError','researchStatus','identificationStatus']);
      if(!patch||typeof patch!=='object'||Object.keys(patch).some(key=>!keys.has(key)))throw Error('调研草稿包含需要明确采用后才可生效的字段。');
      const next=copy(workflow),current=findNode(next,id);if(current?.type!=='character_research')throw Error('只有角色与场景检索节点可保存调研草稿。');
      current.params={...current.params,...copy(patch)};changed(next,{render:false});const saved=await saveScoped();active();return saved;
    },
    addCharacterResearch:async()=>{
      active();const current=workspace;await current?.save?.();active();await saveScoped();active();
      const hostId=laneForNode(workflow,id)?id:workflow.nodes.find(host=>Object.values(host.attachments||{}).some(ids=>ids.includes(id)))?.id;
      if(!hostId)throw Error('请先把当前设定节点接入主线。');
      const host=findNode(workflow,hostId),existing=(host.attachments?.top||[]).map(child=>findNode(workflow,child)).find(child=>child?.type==='character_research');
      if(existing){notify('AI 搜索已接好，返回总览后双击它即可开始。');return existing.id;}
      const next=insertNode(workflow,'character_research',catalog,{hostId,slot:'top'}),newId=next.selectedNodeId;changed(next);await saveScoped();notify('AI 搜索已接好，返回总览后双击它即可开始。');return newId;
    },
    startReferenceRoute:async(nodeId=id,referenceIndex)=>{
      active();const reference=findNode(workflow,nodeId);
      if(reference?.type!=='image_reference')throw Error('请选择图片参考节点');
      if(Number.isInteger(referenceIndex)&&referenceIndex!==reference.params?.activeReferenceIndex)throw Error('请先选定当前参考图片');
      const lane=laneForNode(workflow,nodeId);
      if(!lane||lane.forkId||lane.order[0]!==nodeId)changed(placeNodeOnCanvas(workflow,nodeId,openCanvasPosition()),{render:false});
      await saveScoped();active();await leaveWorkspace();select(nodeId);focusNode(nodeId);category='creation';renderDock();notify('参考图已成为独立起点');
      return nodeId;
    },
    addBranch:async(forkId,label)=>{active();changed(addBranchRoute(workflow,forkId,label));await saveScoped();active();return copy(workflow);},
    renameBranch:async(branchId,label)=>{active();changed(renameBranchRoute(workflow,branchId,String(label||'未命名路线').trim().slice(0,40)));await saveScoped();active();return copy(workflow);},
    focusBranch:async(branchId)=>{active();await leaveWorkspace();selectLane(branchId);graphViewport.focus(branchId);},
    getInput:nodeId=>{active();return upstreamOutput(workflow,nodeId||id);},
    updateNode:patch=>{active();changed(patchNode(workflow,id,patch),{render:false});},
    commitOutput:async output=>{active();changed(commitNode(workflow,id,output),{render:false});await saveScoped();active();$('workspaceStatus').textContent='输出已保存';},
    saveWorkflow:saveScoped,
    runNode:async options=>{active();return runNode(id,options||{},scope);},
    openLegacy:mode=>{active();return openLegacy(mode,id,scope);},
    selectCandidate:candidateId=>{active();const candidate=findNode(workflow,candidateId);return candidate?.output;},
  };
}
async function enterWorkspace(id=workflow?.selectedNodeId){
  if(!workflow||runBusy)return;const node=findNode(workflow,id);if(!node)return;
  const entryRequest=++workspaceEntryRequest;
  if(legacy?.canSaveOnLeave?.()&&legacy?.hasUnsavedChanges?.()){
    try{await saveCurrentWorkspace();}catch(error){if(error.name!=='AbortError')notify(error.message);return;}
    if(entryRequest!==workspaceEntryRequest)return;
  }
  const scope={controller:new AbortController(),ticket:++workspaceTransition,workflowId:workflow.id,nodeId:id,closing:false};
  await leaveWorkspace(false,scope.ticket);
  if(scope.ticket!==workspaceTransition||workflow?.id!==scope.workflowId||!findNode(workflow,id)){scope.controller.abort();return;}
  workspaceLifetime=scope;workflow.selectedNodeId=id;currentWorkspaceId=id;
  const def=definitionFor(catalog,node.type),source=$('ribbon').querySelector(`[data-preview="${id}"]`)||$('ribbon').querySelector(`[data-attachment="${id}"]`),rect=source?.getBoundingClientRect();
  $('workspaceTitle').textContent=node.label.replace(/[。．.]+$/,'');$('workspaceSubtitle').textContent='';$('workspaceStatus').textContent=statusLabel(node);$('workspaceActions').replaceChildren();$('saveWorkspace').disabled=false;$('workspaceContent').innerHTML='<div class="ns-workspace-loading">正在打开工作区…</div>';$('workspace').hidden=false;document.body.classList.add('ns-in-workspace');
  if(rect&&!reduced())$('workspace').animate([{opacity:0,transform:`translate(${rect.left+rect.width/2-innerWidth/2}px,${rect.top+rect.height/2-innerHeight/2}px) scale(.2)`},{opacity:1,transform:'translate(0,0) scale(1)'}],{duration:360,easing:'cubic-bezier(.2,.75,.25,1)'});
  const mountHost=document.createElement('div');mountHost.className='ns-workspace-mount';$('workspaceContent').replaceChildren(mountHost);
  try{
    const directMode={precision_edit:'brush',flatten_map:'mapping'}[node.type];
    if(directMode){await openLegacy(directMode,id,scope);return;}
    const mounted=await mountWorkspace(mountHost,workspaceContext(id,scope));
    if(!isWorkspaceActive(scope)){mounted?.destroy?.();return;}
    workspace=mounted;
  }catch(error){if(error.name==='AbortError'||!isWorkspaceActive(scope))return;mountHost.innerHTML=`<div class="ns-error"><h3>这个工作区未能打开</h3><p>${escape(error.message)}</p><button class="ns-button" id="retryWorkspace">重新打开</button></div>`;mountHost.querySelector('#retryWorkspace').onclick=()=>enterWorkspace(id);}
}
async function leaveWorkspace(animate=true,transition=null){
  if(transition===null){
    const request=++workspaceEntryRequest;
    if(legacy?.canSaveOnLeave?.()&&legacy?.hasUnsavedChanges?.()){
      try{await saveCurrentWorkspace();}catch(error){if(error.name!=='AbortError')notify(error.message);return;}
      if(request!==workspaceEntryRequest)return;
    }
  }
  const ticket=transition??++workspaceTransition,scope=workspaceLifetime,leaving=workspace,leavingLegacy=legacy;
  workspaceLifetime=null;workspace=null;legacy=null;currentWorkspaceId=null;
  if(scope){scope.closing=true;scope.controller.abort();}
  leavingLegacy?.destroy?.();
  if(leaving){try{await leaving.save?.();}catch(error){if(error.name!=='AbortError')notify(error.message);}finally{leaving.destroy?.();}}
  if(ticket!==workspaceTransition)return;
  if(!$('workspace').hidden){
    if(animate&&!reduced())await $('workspace').animate([{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(.96)'}],{duration:150,easing:'ease-in'}).finished;
    if(ticket!==workspaceTransition)return;
    $('workspace').hidden=true;document.body.classList.remove('ns-in-workspace');$('workspaceActions').replaceChildren();renderStudio();focusNode();saveWorkflow().catch(error=>notify(error.message));
  }
}
async function openLegacy(mode,id,scope){
  try{
    assertWorkspaceActive(scope);await saveWorkflow();assertWorkspaceActive(scope);
    const node=findNode(workflow,id),input=copy(node.output?.projectSnapshot?node.output:upstreamOutput(workflow,id));
    workspace?.destroy?.();workspace=null;$('workspaceContent').innerHTML='';
    const ancestry=[...precedingNodeIds(workflow,id),id].reverse();const scene=ancestry.flatMap(hostId=>{const host=findNode(workflow,hostId);return [...Object.values(host?.attachments||{}).flat().map(child=>findNode(workflow,child)),host];}).find(item=>item?.type==='scene_context')?.params||{};
    if(input&&/^#[\da-f]{6}$/i.test(scene.bloodColor||'')){
      const snapshot=input.projectSnapshot||{};
      input.projectSnapshot={...snapshot,brushSettings:{...snapshot.brushSettings,color:scene.bloodColor},bloodSettings:{...snapshot.bloodSettings,color:scene.bloodColor}};
    }
    $('saveWorkspace').disabled=true;
    legacy=openLegacyWorkspace($('workspaceContent'),{mode,workflow:copy(workflow),node:{...copy(node),config:copy(node.params)},input,headerActions:$('workspaceActions'),onStatus:message=>{if(isWorkspaceActive(scope))$('workspaceStatus').textContent=message;},onReady:ready=>{if(isWorkspaceActive(scope))$('saveWorkspace').disabled=!ready;},onCommit:async output=>{assertWorkspaceActive(scope);changed(commitNode(workflow,id,output),{render:false});await saveWorkflow();assertWorkspaceActive(scope);$('workspaceStatus').textContent='已保存';},onClose:()=>{if(isWorkspaceActive(scope))return leaveWorkspace();},notify:message=>{if(isWorkspaceActive(scope))notify(message);}});
  }catch(error){if(error.name!=='AbortError')notify(error.message);}
}
async function runNode(id,options,scope){
  if(runBusy)throw Error('当前任务还在处理中。');runBusy=true;
  try{
    if(scope)assertWorkspaceActive(scope);await saveWorkflow();if(scope)assertWorkspaceActive(scope);$('workspaceStatus').textContent='正在处理…';
    const result=await api('POST',`/api/node-studio/workflows/${encodeURIComponent(workflow.id)}/nodes/${encodeURIComponent(id)}/run`,{...options,expectedRevision:workflow.revision,params:findNode(workflow,id)?.params});
    if(scope)assertWorkspaceActive(scope);if(result.workflow){workflow=result.workflow;persistence.bind(workflow);}
    $('workspaceStatus').textContent=statusLabel(findNode(workflow,id));
    renderStudio();return result;
  }catch(error){if(error.name!=='AbortError'&&(!scope||isWorkspaceActive(scope))){$('workspaceStatus').textContent='未完成';notify(error.message);}throw error;}finally{runBusy=false;}
}
async function refreshEntryHistory(){
  const ticket=++historyRequest;entryExperience.historyLoading();
  try{const result=await api('GET','/api/node-studio/workflows');if(ticket===historyRequest)entryExperience.renderHistory(result.workflows||[]);return true;}
  catch(error){if(ticket===historyRequest)entryExperience.historyError(error);return false;}
}
async function openProject(id){
  if(booting||projectOpening||runBusy||!catalogReady)return;
  projectOpening=true;entryExperience.cancelTransition();
  try{
    await leaveWorkspace(false);if(workflow)await saveWorkflow();
    const response=await api('GET',`/api/node-studio/workflows/${encodeURIComponent(id)}`),next=response.workflow||response;
    assertWorkflow(next);workflow=next;persistence.bind(workflow);
    $('entry').hidden=true;$('studio').hidden=false;renderStudio();renderDock();
    if($('projectsDialog').open)$('projectsDialog').close();
    graphViewport.fit();localStorage.setItem('relic-node-last-project',workflow.id);$('saveState').textContent='已读取本机创作';
  }catch(error){notify(error.message);throw error;}finally{projectOpening=false;}
}
async function openProjects(){
  $('projectsDialog').showModal();$('projectsList').textContent='正在读取本机创作…';
  try{const result=await api('GET','/api/node-studio/workflows'),rows=result.workflows||[];
    $('projectsList').innerHTML=rows.length?rows.map(row=>`<article class="ns-project-list-item"><button class="ns-project-row" data-project="${escape(row.id)}" ${!catalogReady?'disabled':''}>${safeImage(row.thumbnailUrl||row.thumbnail||row.imageUrl)?`<img src="${escape(safeImage(row.thumbnailUrl||row.thumbnail||row.imageUrl))}" alt="">`:icon('folder')}<span><strong>${escape(row.title)}</strong><small>${row.nodeCount||row.order?.length||''} 个工作区</small></span><time>${escape((row.updatedAt||'').slice(0,10))}</time></button><button class="ns-project-delete ns-button ns-quiet" data-delete-project="${escape(row.id)}" aria-label="删除创作：${escape(row.title||'未命名创作')}">删除</button></article>`).join(''):'还没有保存的创作';
    $('projectsList').querySelectorAll('[data-project]').forEach(button=>button.onclick=()=>openProject(button.dataset.project).catch(()=>{}));
    $('projectsList').querySelectorAll('[data-delete-project]').forEach(button=>button.onclick=()=>deleteProject(button.dataset.deleteProject));
  }catch(error){$('projectsList').textContent=error.message;}
}
function resetToEntry(){
  entryExperience.cancelTransition();workflow=null;persistence.bind({revision:0});front=null;back=null;
  uploadTickets.front++;uploadTickets.back++;uploadPending.front=false;uploadPending.back=false;
  $('frontFile').value='';$('backFile').value='';$('entry').hidden=false;$('studio').hidden=true;$('workspace').hidden=true;
  $('startButton').disabled=true;$('frontLabel').textContent='放入服装正面照片';$('frontPreview').innerHTML=entryFrontPlaceholder;$('backPreview').textContent='＋';
  $('projectTitleButton').textContent='未命名创作';$('saveState').textContent='本机工作区';entryExperience.uploadState();
}
async function deleteProject(id){
  if(!id||booting||projectOpening||runBusy||addingPictures)return;
  projectOpening=true;
  let deletingCurrent=false;
  try{
    const endpoint=`/api/node-studio/workflows/${encodeURIComponent(id)}`;
    let preview=await api('GET',`${endpoint}/deletion`);
    const bytes=Number(preview.estimatedBytes)||0,size=bytes>=1048576?`${(bytes/1048576).toFixed(1)} MB`:`${Math.ceil(bytes/1024)} KB`;
    if(!confirm(`删除「${preview.title||'未命名创作'}」？\n\n将删除方案和仅供它使用的素材，预计释放 ${size}\n其他方案使用中的素材会保留\n此操作无法撤销`))return;
    projectOpening=true;deletingCurrent=workflow?.id===id;
    if(deletingCurrent){
      tracker.stop();await leaveWorkspace(false);await saveWorkflow();
      // Refresh the revision after settling this window's pending changes.
      preview=await api('GET',`${endpoint}/deletion`);
    }
    const result=await api('DELETE',endpoint,{expectedRevision:preview.revision,deleteUnusedAssets:true});
    if(deletingCurrent){resetToEntry();if(localStorage.getItem('relic-node-last-project')===id)localStorage.removeItem('relic-node-last-project');}
    await refreshEntryHistory();
    if($('projectsDialog').open)await openProjects();
    const freed=Number(result.freedBytes)||0;notify(`创作已删除，释放 ${freed>=1048576?(freed/1048576).toFixed(1)+' MB':Math.ceil(freed/1024)+' KB'}`);
  }catch(error){
    notify(error.message);
    if($('projectsDialog').open)await openProjects();await refreshEntryHistory();
  }finally{projectOpening=false;if(deletingCurrent)tracker.start();}
}
function openStash(){
  const rows=[];
  for(const id of workflow.stash||[]){const node=findNode(workflow,id);if(node)rows.push({node,detached:true,output:node.output});}
  for(const node of workflow.nodes){for(const version of node.versions||[])rows.push({node,version,output:version.output});}
  $('stashList').innerHTML=rows.length?`<div class="ns-stash-grid">${rows.map((row,index)=>`<article class="ns-stash-card">${safeImage(row.output?.imageUrl)?`<img src="${escape(safeImage(row.output.imageUrl))}" alt="${escape(row.node.label)}的历史输出">`:icon('history')}<strong>${escape(row.node.label)}</strong><small>${row.detached?'已撤下，结果仍然保留':'历史输出 · '+escape((row.version.savedAt||'').slice(0,16))}</small><button class="ns-button" data-restore="${index}">${row.detached?'重新接入':'采用这个版本'}</button></article>`).join('')}</div>`:'<p class="ns-notice">撤下节点或生成新的输出后，可以在这里找回旧结果。</p>';
  $('stashList').querySelectorAll('[data-restore]').forEach(button=>button.onclick=()=>{const row=rows[Number(button.dataset.restore)];try{if(row.detached){restoreShelfNode(row.node.id);}else changed(restoreVersion(workflow,row.node.id,row.version.id));$('stashDialog').close();focusNode();}catch(error){notify(error.message);}});$('stashDialog').showModal();
}
function setupEvents(){
  for(const id of ['aiSettingsButton','workspaceAiSettingsButton']){
    $(id).innerHTML=icon('settings')+'<span>AI 设置</span>';
    $(id).onclick=()=>globalAiSettings.open('assistant');
  }
  $('frontFile').onchange=event=>{const file=event.target.files[0];if(file)setEntryFile(file,'front');};$('backFile').onchange=event=>{const file=event.target.files[0];if(file)setEntryFile(file,'back');};
  $('frontDrop').onkeydown=event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();$('frontFile').click();}};
  $('backFile').closest('label').onkeydown=event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();$('backFile').click();}};
  $('frontDrop').ondragover=event=>{event.preventDefault();$('frontDrop').classList.add('drag-over');};$('frontDrop').ondragleave=()=>$('frontDrop').classList.remove('drag-over');$('frontDrop').ondrop=event=>{event.preventDefault();$('frontDrop').classList.remove('drag-over');const file=event.dataTransfer.files[0];if(file)setEntryFile(file,'front');};
  $('startButton').onclick=start;
  $('floatButton').onclick=floatSelected;$('connectButton').onclick=openConnectDialog;
  $('addGarmentButton').onclick=()=>$('canvasGarmentFile').click();
  $('addReferenceButton').onclick=()=>$('canvasReferenceFile').click();
  $('canvasGarmentFile').onchange=async event=>{await addPictureFiles(event.target.files,'garment_input');event.target.value='';};
  $('canvasReferenceFile').onchange=async event=>{await addPictureFiles(event.target.files,'image_reference');event.target.value='';};
  $('sampleButton').onclick=async()=>{try{const response=await fetch('/resources/garments/demo_coat_front.png');if(!response.ok)throw Error('示例图暂不可用。');const file=new File([await response.blob()],'示例服装.png',{type:'image/png'});await setEntryFile(file,'front');}catch(error){notify(error.message);}};
  $('saveButton').onclick=async()=>{try{if(currentWorkspaceId)await saveCurrentWorkspace(true);else{await saveWorkflow();notify(workflow?'创作已保存到本机。':'先上传服装，开始一份创作。');}}catch(error){notify(error.message);}};
  $('saveWorkspace').onclick=()=>saveCurrentWorkspace(true).catch(error=>{if(error.name!=='AbortError')notify(error.message);});
  $('projectsButton').onclick=openProjects;
  for(const id of ['helpButton','workspaceHelpButton'])$(id).onclick=()=>$('helpDialog').showModal();
  $('stashButton').onclick=openStash;
  document.querySelectorAll('dialog [data-close]').forEach(button=>button.onclick=()=>button.closest('dialog').close());
  $('enterButton').onclick=()=>enterWorkspace();$('leaveWorkspace').onclick=()=>leaveWorkspace();$('fitButton').innerHTML=icon('expand');$('fitButton').onclick=()=>graphViewport.fit();
  $('zoomOut').onclick=()=>graphViewport.setZoom(graphViewport.getZoom()/1.2);$('zoomIn').onclick=()=>graphViewport.setZoom(graphViewport.getZoom()*1.2);$('zoomValue').onclick=()=>graphViewport.setZoom(1);$('branchButton').onclick=()=>forkFromSelected();
  $('detachButton').onclick=()=>{try{returnNodeToShelf(workflow.selectedNodeId);}catch(error){notify(error.message);}};
  $('leftButton').onclick=()=>{try{const lane=currentLane();changed(moveNode(workflow,workflow.selectedNodeId,lane.order.indexOf(workflow.selectedNodeId)-1,catalog,lane.id));focusNode();}catch(error){notify(error.message);}};
  $('rightButton').onclick=()=>{try{const lane=currentLane();changed(moveNode(workflow,workflow.selectedNodeId,lane.order.indexOf(workflow.selectedNodeId)+1,catalog,lane.id));focusNode();}catch(error){notify(error.message);}};
  $('projectTitleButton').onclick=()=>{if(!workflow)return;const value=prompt('给这份创作起个名字',workflow.title);if(value?.trim())changed({...workflow,title:value.trim().slice(0,100)});};
  $('newButton').onclick=async()=>{if(booting||projectOpening||runBusy||addingPictures)return;projectOpening=true;try{await leaveWorkspace(false);if(currentWorkspaceId)throw Error('请先保存当前工作区');await saveWorkflow();resetToEntry();clearTimeout(toastTimer);$('toast').hidden=true;void refreshEntryHistory();}catch(error){notify(error.message);}finally{projectOpening=false;}};
  document.querySelector('.ns-brand').onclick=event=>{event.preventDefault();$('newButton').click();};
  $('ribbonViewport').addEventListener('dragover',event=>{
    if(!readDrop(event))return;
    const rect=$('ribbonViewport').getBoundingClientRect(),edge=48;
    if(event.clientX<rect.left+edge)$('ribbonViewport').scrollLeft-=24;
    else if(event.clientX>rect.right-edge)$('ribbonViewport').scrollLeft+=24;
    if(event.clientY<rect.top+edge)$('ribbonViewport').scrollTop-=20;
    else if(event.clientY>rect.bottom-edge)$('ribbonViewport').scrollTop+=20;
  },{capture:true});
  $('ribbonViewport').ondragover=event=>{
    if(!workflow)return;
    const data=readDrop(event);if(!data)return;
    const def=data.kind==='route'?null:definitionFor(catalog,data.type||findNode(workflow,data.id)?.type);
    if(data.kind!=='route'&&!def)return;
    event.preventDefault();event.dataTransfer.dropEffect=data.kind==='insert'?'copy':'move';
    $('ribbonViewport').classList.add('is-canvas-drop');
  };
  $('ribbonViewport').ondrop=event=>{
    event.preventDefault();const data=readDrop(event);
    if(data&&workflow)dropNode(data,backgroundDropPosition(event,data));
    $('ribbonViewport').classList.remove('is-canvas-drop');
    finishNodeDrag();
  };
  $('ribbonViewport').ondragleave=event=>{if(!$('ribbonViewport').contains(event.relatedTarget))$('ribbonViewport').classList.remove('is-canvas-drop');};
  const returnTargets=[$('nodeDock'),$('stashButton')];
  for(const target of returnTargets){
    const canReturn=event=>{const data=readDrop(event),node=data?.kind==='move'&&workflow&&findNode(workflow,data.id);return node&&node.id!==workflow.order[0]&&!['branch_create','branch_merge'].includes(node.type)&&!workflow.stash?.includes(node.id);};
    target.ondragover=event=>{if(!canReturn(event))return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';target.classList.add('is-return-active');$('ribbon').querySelectorAll('.is-insert-active').forEach(item=>item.classList.remove('is-insert-active'));};
    target.ondragleave=event=>{if(!target.contains(event.relatedTarget))target.classList.remove('is-return-active');};
    target.ondrop=event=>{if(!canReturn(event))return;event.preventDefault();event.stopPropagation();const data=readDrop(event);try{returnNodeToShelf(data.id);}catch(error){notify(error.message);}finally{finishNodeDrag();}};
  }
  window.addEventListener('relic-node-drag-start',event=>{
    const data=event.detail,isMove=data?.kind==='move',fromShelf=isMove&&workflow?.stash?.includes(data.id);
    document.body.classList.toggle('ns-drag-returnable',!!isMove&&!fromShelf);
    $('dockDropHint').hidden=!isMove;$('dockHelp').hidden=isMove;
    $('dockDropHint').textContent=fromShelf?'拖到主线连接处，重新接入这次尝试':'放回底部，收进方案架 · 输出会保留';
  });
  window.addEventListener('relic-node-drag-end',()=>{document.body.classList.remove('ns-drag-returnable');$('ribbonViewport').classList.remove('is-canvas-drop');$('dockDropHint').hidden=true;$('dockHelp').hidden=false;if(pendingStudioRender){pendingStudioRender=false;renderStudio();}});
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.isComposing||document.querySelector('dialog[open]'))return;
    if(event.key==='Escape'){
      const menu=[...$('workspaceActions').querySelectorAll('details[open]')].at(-1);
      if(menu){event.preventDefault();menu.open=false;menu.querySelector('summary')?.focus();return;}
      if(!$('workspace').hidden){event.preventDefault();event.stopPropagation();leaveWorkspace();}
      return;
    }
    const typing=event.target.matches('input,textarea,select,[contenteditable=true]');
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();(currentWorkspaceId?saveCurrentWorkspace(true):saveWorkflow()).catch(error=>notify(error.message));return;}
    if(typing)return;
    if(event.code==='Space'&&workflow&&$('workspace').hidden){event.preventDefault();enterWorkspace();}
    else if(event.key==='Delete'&&workflow&&$('workspace').hidden){event.preventDefault();try{returnNodeToShelf(workflow.selectedNodeId);}catch(error){notify(error.message);}}
    else if(event.altKey&&workflow&&$('workspace').hidden&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();$(event.key==='ArrowLeft'?'leftButton':'rightButton').click();}
    else if((event.ctrlKey||event.metaKey)&&event.key==='s'){event.preventDefault();(currentWorkspaceId?saveCurrentWorkspace(true):saveWorkflow()).catch(error=>notify(error.message));}
  });
  window.addEventListener('beforeunload',event=>{if(persistence.generation>persistence.savedGeneration){event.preventDefault();event.returnValue='';}});
}
async function boot(){
  setupEvents();
  await Promise.allSettled([
    (async()=>{try{const response=await api('GET','/api/node-studio/catalog');catalog=response.nodes||response.catalog||response;renderDock();catalogReady=true;entryExperience.markBootPart('catalog',true);entryExperience.uploadState({hasImage:!!front,pending:uploadPending.front||uploadPending.back});$('saveState').textContent='本机工作区';tracker.start();}catch(error){entryExperience.markBootPart('catalog',false);$('entryStatus').innerHTML=`创作台暂未就绪：${escape(error.message)} <button class="ns-button ns-quiet" id="retryEntryBoot">重新连接</button>`;$('retryEntryBoot').onclick=()=>location.reload();$('startButton').disabled=true;}})(),
    (async()=>{const success=await refreshEntryHistory();entryExperience.markBootPart('history',success);})(),
  ]);
}
// A small read-only facade makes integration probes inspect public state, not internals.
window.RelicNodeStudio={getWorkflow:()=>workflow?copy(workflow):null,getCatalog:()=>copy(catalog),openNode:enterWorkspace,save:saveWorkflow,getPracticeState:()=>practice.getState()};
boot();
