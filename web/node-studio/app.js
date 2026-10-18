import {api, upload} from './core/api.js';
import {copy,uid,makeNode,findNode,definitionFor,insertNode,detachNode,moveNode,moveNodeToGap,patchNode,commitNode,restoreVersion,upstreamOutput,assertWorkflow,markAfter} from './core/model.js';
import {WorkflowPersistence} from './core/persistence.js';
import {GenerationTracker} from './core/job-tracker.js';
import {escape,icon,safeImage} from './components/icons.js';
import {categories,categoryOf,statusLabel,renderRibbon,renderLibrary,readDrop,bindNodeDrag,finishNodeDrag,ribbonGapAt,highlightRibbonGap} from './components/ribbon.js';
import {mountWorkspace} from './workspaces/index.js';
import {openLegacyWorkspace} from './adapters/legacy-bridge.js';

const $=id=>document.getElementById(id);
let catalog=[],workflow=null,category='creation',front=null,back=null,workspace=null,legacy=null,currentWorkspaceId=null,toastTimer,booting=false,runBusy=false,pendingStudioRender=false,workspaceLifetime=null,workspaceTransition=0;
const persistence=new WorkflowPersistence(api,text=>$('saveState').textContent=text);
const tracker=new GenerationTracker({api,getWorkflow:()=>workflow,updateWorkflow:next=>changed(next),onUpdate:(nodeId,output)=>{window.dispatchEvent(new CustomEvent('relic-node-job-updated',{detail:{nodeId,output}}));if(currentWorkspaceId===nodeId)$('workspaceStatus').textContent=output.jobStatus==='succeeded'?'新结果待采用':output.jobStatus||'任务已更新';},notify:message=>notify(message)});
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
function notify(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,4300);}
function selected(){return workflow&&findNode(workflow,workflow.selectedNodeId);}
function saveSucceeded(saved,replace){if(workflow?.id!==saved.id)return;if(replace)workflow=saved;else workflow.revision=saved.revision;}
function changed(next,{render=true}={}){assertWorkflow(next);workflow=next;persistence.changed(()=>workflow,saveSucceeded);if(render){if(document.body.classList.contains('ns-dragging'))pendingStudioRender=true;else renderStudio();}}
async function saveWorkflow(){if(!workflow)return;return persistence.save(()=>workflow,saveSucceeded);}
function focusNode(id=workflow?.selectedNodeId){const wrap=$('ribbon').querySelector(`[data-node-id="${id}"]`)||$('ribbon').querySelector(`[data-attachment="${id}"]`);wrap?.scrollIntoView({behavior:reduced()?'instant':'smooth',block:'nearest',inline:'center'});}
function select(id){workflow.selectedNodeId=id;renderStudio();}
function renderStudio(){
  if(!workflow)return;
  $('projectTitleButton').textContent=workflow.title||'未命名创作';
  renderRibbon($('ribbon'),workflow,catalog,{select,enter:enterWorkspace,drop:dropNode});
  const node=selected(),def=node&&definitionFor(catalog,node.type);
  $('selectionTitle').textContent=node?.label||'选择一个节点';$('selectionDescription').textContent=def?.description||'';
  $('detachButton').disabled=!node||node.type==='garment_input';
  $('leftButton').disabled=!node||workflow.order.indexOf(node.id)<=1;
  $('rightButton').disabled=!node||workflow.order.indexOf(node.id)<1||workflow.order.indexOf(node.id)>=workflow.order.length-1;
  $('stashCount').textContent=String((workflow.stash||[]).length);
  renderShelf();
  $('workflowStats').textContent=`${workflow.order.length} 个步骤 · ${workflow.nodes.length-workflow.order.length-(workflow.stash||[]).length} 张协作卡 · 本机保存`;
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
    const host=workflow.order.includes(workflow.selectedNodeId)?workflow.selectedNodeId:workflow.order.at(-1);
    changed(def.placement==='attachment'?attachExisting(workflow,id,host,def.slot||'top'):moveNodeToGap(workflow,id,workflow.order.length,catalog));
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
async function openAddedResearch(id){
  try{await saveWorkflow();if(workflow&&findNode(workflow,id))await enterWorkspace(id);}catch(error){if(error.name!=='AbortError')notify(error.message);}
}
function attachExisting(current,id,hostId,slot){
  const next=copy(current),node=findNode(next,id),host=findNode(next,hostId),def=node&&definitionFor(catalog,node.type);
  if(!node||!host||id===hostId||!next.order.includes(hostId))throw Error('请选择主线上的其他节点作为宿主。');
  if(node.type==='garment_input'||def.placement==='main')throw Error('这张节点应横向连接，不能作为侧边附件。');
  if((def.slot||'bottom')!==slot)throw Error(slot==='top'?'这里接参考与设定，请放到下方 AI 插槽。':'这里接 AI 协作，请放到上方参考插槽。');
  if(Object.values(node.attachments||{}).some(ids=>ids.length))throw Error('请先撤下这个节点携带的附件。');
  for(const item of next.nodes)for(const side of ['top','bottom'])if(item.attachments?.[side])item.attachments[side]=item.attachments[side].filter(value=>value!==id);
  next.order=next.order.filter(value=>value!==id);next.stash=(next.stash||[]).filter(value=>value!==id);host.attachments[slot].push(id);next.selectedNodeId=id;markAfter(next,hostId);return next;
}
function addNode(type,position={}){
  try{
    if(!workflow)return;
    const def=definitionFor(catalog,type),node=selected();let afterId=node?.id;
    if(!workflow.order.includes(afterId))afterId=workflow.nodes.find(host=>Object.values(host.attachments||{}).some(ids=>ids.includes(afterId)))?.id||workflow.order.at(-1);
    if(position.hostId&&def.placement==='main')throw Error('这个工作区应放到横向主线。');
    if(position.slot&&(def.slot||'bottom')!==position.slot)throw Error('插槽不匹配：上方放参考与设定，下方放 AI 协作。');
    const next=insertNode(workflow,type,catalog,{afterId,...position});changed(next);focusNode();notify(def.placement==='attachment'?'已插入当前工作区，双击进入。':'工作区已接好，按空格进入。');
    if(type==='character_research'){const id=next.selectedNodeId;queueMicrotask(()=>openAddedResearch(id));}
  }catch(error){notify(error.message);}
}
function dropNode(data,position={}){
  try{
    if(!workflow||!data)return;
    const def=definitionFor(catalog,data.type||findNode(workflow,data.id)?.type);
    if(!def)throw Error('这个节点暂未登记。');
    if(!position.hostId&&def.placement==='attachment')throw Error('这张参考卡请放进主线节点的上方侧槽。');
    if(data.kind==='insert')return addNode(data.type,position);
    if(data.kind==='move'){
      changed(position.hostId?attachExisting(workflow,data.id,position.hostId,position.slot):moveNodeToGap(workflow,data.id,position.at??workflow.order.length,catalog));
      focusNode(data.id);notify('节点已接入指定位置，已有输出仍然保留。');
    }
  }catch(error){notify(error.message);}finally{finishNodeDrag();}
}
async function setEntryFile(file,side){try{const asset=await upload(file);if(side==='front'){front={...asset,name:file.name};$('frontPreview').innerHTML=`<img src="${escape(safeImage(asset.url||asset.imageUrl))}" alt="待创作的服装正面">`;$('frontLabel').textContent=file.name;$('startButton').disabled=false;}else{back={...asset,name:file.name};$('backPreview').innerHTML=`<img src="${escape(safeImage(asset.url||asset.imageUrl))}" alt="服装背面">`;}}catch(error){notify(error.message);}}
async function start(){
  if(!front||booting)return;booting=true;$('startButton').disabled=true;
  try{
    const input=makeNode('garment_input',catalog,{front,back});
    input.output={kind:'garment',imageUrl:front.url||front.imageUrl,reference:front,front,back};input.status='completed';
    const scene=makeNode('scene_context',catalog,{character:'',scene:'',bloodColor:'#782c2b',canonStatus:'user_defined'});
    input.attachments.top.push(scene.id);
    const initial={schemaVersion:1,title:'我的战损创作',nodes:[input,scene],order:[input.id],stash:[],selectedNodeId:input.id,context:{},assets:[front,...(back?[back]:[])]};
    const result=await api('POST','/api/node-studio/workflows',initial);
    workflow=result.workflow||result;persistence.bind(workflow);
    if(!workflow.nodes?.length)throw Error('工作流创建未完成。');
    const source=$('frontPreview').querySelector('img'),rect=source?.getBoundingClientRect(),src=source?.src;
    $('entry').hidden=true;$('studio').hidden=false;renderStudio();renderDock();
    const target=$('ribbon').querySelector('.ns-node-preview');
    if(rect&&target&&src&&!reduced()){
      const dest=target.getBoundingClientRect(),ghost=document.createElement('img');ghost.className='ns-flip-image';ghost.src=src;Object.assign(ghost.style,{left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px'});document.body.append(ghost);
      await ghost.animate([{transform:'translate(0,0) scale(1)',opacity:1},{transform:`translate(${dest.left-rect.left}px,${dest.top-rect.top}px) scale(${dest.width/rect.width},${dest.height/rect.height})`,opacity:1}],{duration:650,easing:'cubic-bezier(.22,.75,.15,1)',fill:'forwards'}).finished;ghost.remove();
    }
    localStorage.setItem('relic-node-last-project',workflow.id);$('saveState').textContent='已保存到本机';notify('服装已就位。从下方选择第一个创作工作区。');
  }catch(error){notify(error.message);$('entry').hidden=false;$('studio').hidden=true;}finally{booting=false;$('startButton').disabled=!front;}
}
function abortedWorkspace(){return new DOMException('这个工作区已关闭或切换，旧操作没有继续。','AbortError');}
function isWorkspaceActive(scope){return !!scope&&workspaceLifetime===scope&&!scope.controller.signal.aborted&&scope.ticket===workspaceTransition&&workflow?.id===scope.workflowId&&currentWorkspaceId===scope.nodeId&&!!findNode(workflow,scope.nodeId);}
function assertWorkspaceActive(scope){if(!isWorkspaceActive(scope))throw abortedWorkspace();}
function workspaceContext(id,scope){
  const node=findNode(workflow,id),definition=definitionFor(catalog,node.type);
  const active=()=>assertWorkspaceActive(scope);
  const saveScoped=async()=>{if(!(scope.closing&&workflow?.id===scope.workflowId))active();return saveWorkflow();};
  const scopedApi=async(...args)=>{active();const result=await api(...args);active();return result;};
  return {workflow,node,definition,catalog,api:scopedApi,signal:scope.controller.signal,isActive:()=>isWorkspaceActive(scope),notify:message=>{if(isWorkspaceActive(scope))notify(message);},
    getWorkflow:()=>{active();return copy(workflow);},
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
      const hostId=workflow.order.includes(id)?id:workflow.nodes.find(host=>Object.values(host.attachments||{}).some(ids=>ids.includes(id)))?.id;
      if(!hostId)throw Error('请先把当前设定节点接入主线。');
      const host=findNode(workflow,hostId),existing=(host.attachments?.top||[]).map(child=>findNode(workflow,child)).find(child=>child?.type==='character_research');
      if(existing){await enterWorkspace(existing.id);return existing.id;}
      const next=insertNode(workflow,'character_research',catalog,{hostId,slot:'top'}),newId=next.selectedNodeId;changed(next);await openAddedResearch(newId);return newId;
    },
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
  const scope={controller:new AbortController(),ticket:++workspaceTransition,workflowId:workflow.id,nodeId:id,closing:false};
  await leaveWorkspace(false,scope.ticket);
  if(scope.ticket!==workspaceTransition||workflow?.id!==scope.workflowId||!findNode(workflow,id)){scope.controller.abort();return;}
  workspaceLifetime=scope;workflow.selectedNodeId=id;currentWorkspaceId=id;
  const def=definitionFor(catalog,node.type),source=$('ribbon').querySelector(`[data-preview="${id}"]`)||$('ribbon').querySelector(`[data-attachment="${id}"]`),rect=source?.getBoundingClientRect();
  $('workspaceTitle').textContent=node.label;$('workspaceSubtitle').textContent=def.description||'';$('workspaceStatus').textContent=statusLabel(node);$('workspaceContent').innerHTML='<div class="ns-workspace-loading">正在打开工作区…</div>';$('workspace').hidden=false;
  if(rect&&!reduced())$('workspace').animate([{opacity:0,transform:`translate(${rect.left+rect.width/2-innerWidth/2}px,${rect.top+rect.height/2-innerHeight/2}px) scale(.2)`},{opacity:1,transform:'translate(0,0) scale(1)'}],{duration:360,easing:'cubic-bezier(.2,.75,.25,1)'});
  const mountHost=document.createElement('div');mountHost.className='ns-workspace-mount';$('workspaceContent').replaceChildren(mountHost);
  try{
    const mounted=await mountWorkspace(mountHost,workspaceContext(id,scope));
    if(!isWorkspaceActive(scope)){mounted?.destroy?.();return;}
    workspace=mounted;
  }catch(error){if(error.name==='AbortError'||!isWorkspaceActive(scope))return;mountHost.innerHTML=`<div class="ns-error"><h3>这个工作区未能打开</h3><p>${escape(error.message)}</p><button class="ns-button" id="retryWorkspace">重新打开</button></div>`;mountHost.querySelector('#retryWorkspace').onclick=()=>enterWorkspace(id);}
}
async function leaveWorkspace(animate=true,transition=null){
  const ticket=transition??++workspaceTransition,scope=workspaceLifetime,leaving=workspace,leavingLegacy=legacy;
  workspaceLifetime=null;workspace=null;legacy=null;currentWorkspaceId=null;
  if(scope){scope.closing=true;scope.controller.abort();}
  leavingLegacy?.destroy?.();
  if(leaving){try{await leaving.save?.();}catch(error){if(error.name!=='AbortError')notify(error.message);}finally{leaving.destroy?.();}}
  if(ticket!==workspaceTransition)return;
  if(!$('workspace').hidden){
    if(animate&&!reduced())await $('workspace').animate([{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(.96)'}],{duration:150,easing:'ease-in'}).finished;
    if(ticket!==workspaceTransition)return;
    $('workspace').hidden=true;renderStudio();focusNode();saveWorkflow().catch(error=>notify(error.message));
  }
}
async function openLegacy(mode,id,scope){
  try{
    assertWorkspaceActive(scope);await saveWorkflow();assertWorkspaceActive(scope);
    const node=findNode(workflow,id),input=upstreamOutput(workflow,id);
    workspace?.destroy?.();workspace=null;$('workspaceContent').innerHTML='';
    const scene=workflow.nodes.find(item=>item.type==='scene_context')?.params||{};
    if(input&&/^#[\da-f]{6}$/i.test(scene.bloodColor||'')){
      const snapshot=input.projectSnapshot||{};
      input.projectSnapshot={...snapshot,brushSettings:{...snapshot.brushSettings,color:scene.bloodColor},bloodSettings:{...snapshot.bloodSettings,color:scene.bloodColor}};
    }
    legacy=openLegacyWorkspace($('workspaceContent'),{mode,workflow:copy(workflow),node:{...copy(node),config:copy(node.params)},input,onCommit:async output=>{assertWorkspaceActive(scope);changed(commitNode(workflow,id,output),{render:false});await saveWorkflow();assertWorkspaceActive(scope);const previous=legacy;legacy=null;previous?.destroy?.();await enterWorkspace(id);notify('画布输出已保存到当前节点。');},onClose:()=>{if(isWorkspaceActive(scope))return enterWorkspace(id);},notify:message=>{if(isWorkspaceActive(scope))notify(message);}});
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
async function openProjects(){
  $('projectsDialog').showModal();$('projectsList').textContent='正在读取本机创作…';
  try{const result=await api('GET','/api/node-studio/workflows'),rows=result.workflows||[];
    $('projectsList').innerHTML=rows.length?rows.map(row=>`<button class="ns-project-row" data-project="${escape(row.id)}">${safeImage(row.thumbnail||row.imageUrl)?`<img src="${escape(safeImage(row.thumbnail||row.imageUrl))}" alt="">`:icon('folder')}<span><strong>${escape(row.title)}</strong><small>${row.nodeCount||row.order?.length||''} 个工作区</small></span><time>${escape((row.updatedAt||'').slice(0,10))}</time></button>`).join(''):'还没有保存的创作。上传照片即可开始。';
    $('projectsList').querySelectorAll('[data-project]').forEach(button=>button.onclick=async()=>{try{if(workflow)await saveWorkflow();const response=await api('GET',`/api/node-studio/workflows/${encodeURIComponent(button.dataset.project)}`);await leaveWorkspace(false);workflow=response.workflow||response;persistence.bind(workflow);$('entry').hidden=true;$('studio').hidden=false;renderStudio();renderDock();$('projectsDialog').close();focusNode();localStorage.setItem('relic-node-last-project',workflow.id);}catch(error){notify(error.message);}});
  }catch(error){$('projectsList').textContent=error.message;}
}
function openStash(){
  const rows=[];
  for(const id of workflow.stash||[]){const node=findNode(workflow,id);if(node)rows.push({node,detached:true,output:node.output});}
  for(const node of workflow.nodes){for(const version of node.versions||[])rows.push({node,version,output:version.output});}
  $('stashList').innerHTML=rows.length?`<div class="ns-stash-grid">${rows.map((row,index)=>`<article class="ns-stash-card">${safeImage(row.output?.imageUrl)?`<img src="${escape(safeImage(row.output.imageUrl))}" alt="${escape(row.node.label)}的历史输出">`:icon('history')}<strong>${escape(row.node.label)}</strong><small>${row.detached?'已撤下，结果仍然保留':'历史输出 · '+escape((row.version.savedAt||'').slice(0,16))}</small><button class="ns-button" data-restore="${index}">${row.detached?'重新接入':'采用这个版本'}</button></article>`).join('')}</div>`:'<p class="ns-notice">撤下节点或生成新的输出后，可以在这里找回旧结果。</p>';
  $('stashList').querySelectorAll('[data-restore]').forEach(button=>button.onclick=()=>{const row=rows[Number(button.dataset.restore)];try{if(row.detached){const def=definitionFor(catalog,row.node.type);if(def.placement==='attachment')changed(attachExisting(workflow,row.node.id,workflow.order.includes(workflow.selectedNodeId)?workflow.selectedNodeId:workflow.order[0],def.slot||'top'));else changed(moveNode(workflow,row.node.id,workflow.order.length,catalog));}else changed(restoreVersion(workflow,row.node.id,row.version.id));$('stashDialog').close();focusNode();}catch(error){notify(error.message);}});$('stashDialog').showModal();
}
function setupEvents(){
  $('frontFile').onchange=event=>{const file=event.target.files[0];if(file)setEntryFile(file,'front');};$('backFile').onchange=event=>{const file=event.target.files[0];if(file)setEntryFile(file,'back');};
  $('frontDrop').onkeydown=event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();$('frontFile').click();}};
  $('frontDrop').ondragover=event=>{event.preventDefault();$('frontDrop').classList.add('drag-over');};$('frontDrop').ondragleave=()=>$('frontDrop').classList.remove('drag-over');$('frontDrop').ondrop=event=>{event.preventDefault();$('frontDrop').classList.remove('drag-over');const file=event.dataTransfer.files[0];if(file)setEntryFile(file,'front');};
  $('startButton').onclick=start;
  $('sampleButton').onclick=async()=>{try{const response=await fetch('/resources/garments/demo_coat_front.png');if(!response.ok)throw Error('示例图暂不可用。');const file=new File([await response.blob()],'示例服装.png',{type:'image/png'});await setEntryFile(file,'front');}catch(error){notify(error.message);}};
  $('saveButton').onclick=async()=>{try{await workspace?.save?.();await saveWorkflow();notify(workflow?'创作已保存到本机。':'先上传服装，开始一份创作。');}catch(error){notify(error.message);}};
  $('projectsButton').onclick=openProjects;$('helpButton').onclick=()=>$('helpDialog').showModal();$('stashButton').onclick=openStash;
  document.querySelectorAll('dialog [data-close]').forEach(button=>button.onclick=()=>button.closest('dialog').close());
  $('enterButton').onclick=()=>enterWorkspace();$('leaveWorkspace').onclick=()=>leaveWorkspace();$('fitButton').innerHTML=icon('expand');$('fitButton').onclick=()=>focusNode();
  $('detachButton').onclick=()=>{try{returnNodeToShelf(workflow.selectedNodeId);}catch(error){notify(error.message);}};
  $('leftButton').onclick=()=>{try{changed(moveNode(workflow,workflow.selectedNodeId,workflow.order.indexOf(workflow.selectedNodeId)-1,catalog));focusNode();}catch(error){notify(error.message);}};
  $('rightButton').onclick=()=>{try{changed(moveNode(workflow,workflow.selectedNodeId,workflow.order.indexOf(workflow.selectedNodeId)+1,catalog));focusNode();}catch(error){notify(error.message);}};
  $('projectTitleButton').onclick=()=>{if(!workflow)return;const value=prompt('给这份创作起个名字',workflow.title);if(value?.trim())changed({...workflow,title:value.trim().slice(0,100)});};
  $('newButton').onclick=async()=>{try{await leaveWorkspace(false);await saveWorkflow();workflow=null;front=null;back=null;$('entry').hidden=false;$('studio').hidden=true;$('startButton').disabled=true;$('frontLabel').textContent='放入新的服装正面照片';$('frontPreview').innerHTML=icon('garment');$('backPreview').textContent='＋';$('projectTitleButton').textContent='未命名创作';}catch(error){notify(error.message);}};
  $('ribbonViewport').addEventListener('wheel',event=>{if(event.ctrlKey||event.metaKey)return;event.preventDefault();$('ribbonViewport').scrollLeft+=event.deltaY+event.deltaX;},{passive:false});
  $('ribbonViewport').addEventListener('dragover',event=>{
    if(!readDrop(event))return;
    const rect=$('ribbonViewport').getBoundingClientRect(),edge=48;
    if(event.clientX<rect.left+edge)$('ribbonViewport').scrollLeft-=24;
    else if(event.clientX>rect.right-edge)$('ribbonViewport').scrollLeft+=24;
  },{capture:true});
  $('ribbonViewport').ondragover=event=>{
    if(!workflow)return;
    const data=readDrop(event),def=definitionFor(catalog,data?.type||findNode(workflow,data?.id)?.type);
    if(!workflow||!def||def.placement==='attachment')return;
    event.preventDefault();event.dataTransfer.dropEffect=data.kind==='insert'?'copy':'move';
    highlightRibbonGap($('ribbon'),ribbonGapAt($('ribbon'),workflow,event.clientX));
  };
  $('ribbonViewport').ondrop=event=>{
    event.preventDefault();const data=readDrop(event);
    if(data&&workflow){const at=ribbonGapAt($('ribbon'),workflow,event.clientX);dropNode(data,{at,afterId:workflow.order[Math.max(0,at-1)]});}
    finishNodeDrag();
  };
  const returnTargets=[$('nodeDock'),$('stashButton')];
  for(const target of returnTargets){
    const canReturn=event=>{const data=readDrop(event),node=data?.kind==='move'&&workflow&&findNode(workflow,data.id);return node&&node.type!=='garment_input'&&!workflow.stash?.includes(node.id);};
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
  window.addEventListener('relic-node-drag-end',()=>{document.body.classList.remove('ns-drag-returnable');$('dockDropHint').hidden=true;$('dockHelp').hidden=false;if(pendingStudioRender){pendingStudioRender=false;renderStudio();focusNode();}});
  document.addEventListener('keydown',event=>{
    const typing=event.target.matches('input,textarea,select,[contenteditable=true]');if(typing||document.querySelector('dialog[open]'))return;
    if(event.code==='Space'&&workflow&&$('workspace').hidden){event.preventDefault();enterWorkspace();}
    else if(event.key==='Escape'&&!$('workspace').hidden){event.preventDefault();leaveWorkspace();}
    else if(event.key==='Delete'&&workflow&&$('workspace').hidden){event.preventDefault();try{returnNodeToShelf(workflow.selectedNodeId);}catch(error){notify(error.message);}}
    else if(event.altKey&&workflow&&$('workspace').hidden&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();$(event.key==='ArrowLeft'?'leftButton':'rightButton').click();}
    else if((event.ctrlKey||event.metaKey)&&event.key==='s'){event.preventDefault();saveWorkflow().catch(error=>notify(error.message));}
  });
  window.addEventListener('beforeunload',event=>{if(persistence.generation>persistence.savedGeneration){event.preventDefault();event.returnValue='';}});
}
async function boot(){
  setupEvents();
  try{const response=await api('GET','/api/node-studio/catalog');catalog=response.nodes||response.catalog||response;renderDock();$('saveState').textContent='本机工作区';tracker.start();}
  catch(error){$('entry').innerHTML=`<div class="ns-error"><h2>创作台暂未就绪</h2><p>${escape(error.message)}</p><button class="ns-button" onclick="location.reload()">重新连接</button></div>`;}
}
// A small read-only facade makes integration probes inspect public state, not internals.
window.RelicNodeStudio={getWorkflow:()=>workflow?copy(workflow):null,getCatalog:()=>copy(catalog),openNode:enterWorkspace,save:saveWorkflow};
boot();
