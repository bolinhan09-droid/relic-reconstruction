/* Three-stage co-design workspace. Original projects and manual image handoffs remain usable. */
'use strict';
let coRegionDraft=null,coRegionPointer=null,coPendingArea=null,coSelectedStroke=null,coRawView=false;
const CO_COLORS={blood:'#782c2b',burn:'#342d28',wear:'#b4aa91',slash:'#372f29',erase:'#ffffff'};
const previousProjectPayload=projectPayload,previousContentSignature=contentSignature;
const previousSaveProject=saveProject;
const previousBrushCanvas=renderBrushCanvas,previousRenderCanvas=renderCanvas;
const previousStartBrush=startBrush,previousMoveBrush=moveBrush,previousFinishBrush=finishBrush,previousCancelBrush=cancelBrush;
const previousBindBrush=bindBrushWorkbench,previousUploadImage=uploadImage,previousAcceptResult=acceptQuickResult;
QUICK_STAGES.splice(0,QUICK_STAGES.length,['first','准备素材','服装与故事'],['refine','一起设计','圈选、讨论、精修'],['finish','制作辅助','从方案到实物']);

function ensureV2State(){
  if(typeof ensureCoState==='function')ensureCoState();
  state.brushStrokes=state.brushStrokes||[];
  if(!state.brushRefineMode)state.brushRefineMode=state.projectId||state.brushStrokes.length?'strict':'natural';
  if(!state.coVersion){state.coVersion=2;state.quickMode=true;state.brushSettings={...state.brushSettings,mode:'area',spread:.55,direction:-.6};}
  if(!['first','refine','finish'].includes(state.quickStage))state.quickStage='first';
}
projectPayload=function(){
  const p=previousProjectPayload();
  p.brushRefineMode=state.brushRefineMode||'strict';
  p.brushEditRegions=(state.brushStrokes||[]).filter(s=>s.mode==='area'&&s.region?.points?.length>=3).map(s=>({id:s.id,type:s.type,points:s.region.points}));
  p.preparation=state.preparation||{};
  p.makingSamples=state.makingSamples||[];
  p.makingDesignHistory=state.makingDesignHistory||[];
  p.coAssistant={messages:state.coAssistant?.messages||[]};
  return p;
};
contentSignature=function(payload=projectPayload()){
  const {coAssistant,makingSamples,makingDesignHistory,preparation,...visual}=payload;
  if(visual.brushRefineMode==='strict')delete visual.brushRefineMode;
  if(!visual.brushEditRegions?.length)delete visual.brushEditRegions;
  // Unknown material is the legacy default; confirmed material changes remain revisioned.
  if(preparation?.materialKind&&preparation.materialKind!=='unknown')visual.materialKind=preparation.materialKind;
  return previousContentSignature(visual);
};
function coContextPayload(){
  return {projectRevision:state.revision,preparation:state.preparation||{},coAssistant:{messages:state.coAssistant?.messages||[]},makingSamples:state.makingSamples||[],makingDesignHistory:state.makingDesignHistory||[]};
}
saveProject=async function(notify=true){
  const result=await previousSaveProject(false),id=state.projectId,payload=coContextPayload(),fingerprint=JSON.stringify({id,...payload});
  if(fingerprint!==state.coSavedContextSignature){
    $('#saveButton').disabled=true;
    try{await api(`/api/projects/${encodeURIComponent(id)}/context`,{method:'PATCH',body:JSON.stringify(payload)});
      if(state.projectId===id&&fingerprint===JSON.stringify({id,...coContextPayload()})){state.coSavedContextSignature=fingerprint;persistDraft();}
    }finally{$('#saveButton').disabled=false;}
  }
  if(notify)toast('方案、讨论和小样记录已保存。');return result;
};
brushSettings=function(){
  const s=state.brushSettings||{},type=[...Object.keys(BRUSHES),'erase'].includes(s.type)?s.type:'blood';
  return {type,size:clamp(Number(s.size)||.065,.008,.2),opacity:clamp(Number(s.opacity)||.82,.1,1),color:/^#[a-f\d]{6}$/i.test(s.color||'')?s.color:CO_COLORS[type],mode:type==='erase'||type==='slash'?'free':['area','edge','free'].includes(s.mode)?s.mode:'area',spread:clamp(Number(s.spread) || .55,.1,1),direction:Number.isFinite(s.direction)?s.direction:-.6};
};
selectBrush=function(type){
  if(quickLocked())return;
  if(coPendingArea||coRegionDraft){toast('先采用或取消当前区域预览，再切换画笔。');return;}
  brushActive=true;brushPan=false;compare=false;coSelectedStroke=null;
  const old=brushSettings();state.brushSettings={...old,type,color:type==='blood'?(state.bloodColor||CO_COLORS.blood):CO_COLORS[type],mode:type==='burn'?'edge':type==='slash'||type==='erase'?'free':'area'};
  $('#compareButton').setAttribute('aria-pressed','false');tool='select';selected=null;dirty({invalidate:false});render();
};

renderQuickLayout=function(){
  ensureV2State();document.body.classList.add('quick-workflow','co-workflow');
  document.body.dataset.coStage=state.quickStage;
  document.body.classList.toggle('quick-first',state.quickStage==='first');document.body.classList.toggle('quick-result',currentVisualValid());
  ensureQuickSwitch();$('#quickFlowSwitch').hidden=true;
  const stage=QUICK_STAGES.find(s=>s[0]===state.quickStage)||QUICK_STAGES[0];
  $('#studioTitle').textContent={first:'让每一道痕迹，都有来处。',refine:'你的想法，我们一起画出来。',finish:'把满意的方案，慢慢做出来。'}[stage[0]];
  $('#stepper').innerHTML=QUICK_STAGES.map(([id,title,subtitle],i)=>`<li><button class="step-button" data-quick-stage="${id}" ${stage[0]===id?'aria-current="step"':''} ${quickLocked()?'disabled':''}><span class="step-number">0${i+1}</span><span class="step-label">${title}<span class="step-subtitle">${subtitle}</span></span></button></li>`).join('');
  $('#stepEyebrow').textContent=`CHAPTER 0${QUICK_STAGES.indexOf(stage)+1}`;
  $('#stepTitle').textContent={first:'照片、角色与场景',refine:'痕迹工作台',finish:'你的制作手册'}[stage[0]];
  $('#stepDescription').textContent={first:'从你知道的信息开始。不清楚的材料，可以稍后核对。',refine:'先圈出位置，再看分布。随时和右侧助手讨论。',finish:'按区域拆解工具和动作，先试小样，再处理服装。'}[stage[0]];
  $('.panel-bottom').hidden=true;
  $('#stepContent').innerHTML=stage[0]==='first'?renderCoPrepare():stage[0]==='refine'?renderQuickRefine():renderCoMaking();
  $('#coAssistantPane').hidden=false;$('#coAssistantPane').innerHTML=renderCoAssistant();
  bindPanel();bindWorkflowExtras();bindQuick();
  if(stage[0]==='first'){bindCoPrepare();$('#coStartDesign')?.addEventListener('click',()=>goQuickStage('refine'));}
  if(stage[0]==='finish')bindCoMaking();
  bindCoAssistant();renderCanvas();renderEditor();
  if(!$('#coMobileNav')){const nav=document.createElement('nav');nav.id='coMobileNav';nav.setAttribute('aria-label','共创区域快捷跳转');nav.innerHTML='<button type="button" id="coJumpCanvas">服装画布</button><button type="button" id="coJumpAssistant">和助手讨论</button>';$('#studioShell').append(nav);$('#coJumpCanvas').onclick=()=>$('.canvas-panel').scrollIntoView({block:'start',behavior:'smooth'});$('#coJumpAssistant').onclick=()=>{$('#coAssistantPane').scrollIntoView({block:'start',behavior:'smooth'});};}
  if(stage[0]!=='refine'||currentVisualValid()||brushActive)$('#selectionEditor').hidden=true;
};
goQuickStage=function(stage){
  if(quickLocked())return;
  if(coPendingArea){toast('请先采用或取消当前的区域预览。');return;}
  if(stage!=='first'&&!imageReference()){toast('先上传一张服装照片。');return;}
  if(stage==='refine'&&!state.characterId){toast('先选定角色，让助手了解你要保留的特征。');return;}
  if(stage==='refine'&&!state.scenarioId&&!state.preparation?.customScene){toast('先选择一个场景，或写下自己的情境。');return;}
  state.quickStage=stage;state.step=stage==='first'?0:stage==='refine'?2:4;
  if(stage==='refine')state.brushMode=true;
  coRawView=false;dirty({invalidate:false});render();$('#controlPanel').scrollTop=0;
};
uploadImage=async function(file){
  const before=imageReference()?.url;await previousUploadImage(file);
  if(imageReference()?.url!==before){coPendingArea=null;coSelectedStroke=null;coRegionDraft=null;coRawView=false;state.brushRefineMode='natural';state.customDamageEnabled=false;state.preparation={productUrl:'',merchant:'',materialKind:'unknown',materialEvidence:[],lookupStatus:'idle'};state.makingSamples=[];state.makingDesignHistory=[];state.coAssistant={messages:[],candidates:[]};dirty({invalidate:false});render();toast('照片已载入。选定角色和场景，就可以开始。');}
};
acceptQuickResult=async function(){
  const source=imageReference()?.url,marks={brushStrokes:(state.brushStrokes||[]).map(s=>({id:s.id,type:s.type,points:s.points.filter((_,i)=>i%Math.max(1,Math.ceil(s.points.length/256))===0),...(s.region?{region:s.region}:{}),...(s.mode?{mode:s.mode}:{}),...(s.color?{color:s.color}:{})})),damageItems:deepCopy(state.damageItems||[]),jobId:state.job?.id};
  coRawView=false;await previousAcceptResult();coPendingArea=null;coSelectedStroke=null;state.brushEditRegions=[];
  if(source!==imageReference()?.url&&marks.jobId){state.makingDesignHistory=[...(state.makingDesignHistory||[]),marks].slice(-10);persistDraft();}render();
};

function coModeHelp(){
  const s=brushSettings();
  return !brushActive?'拖动保护框，保留领口、标志和配件。':s.type==='erase'?'沿着需要撤掉的笔触擦除。':s.mode==='area'?'按住并圈出一个区域，松开后预览分布。':s.mode==='edge'?'沿衣服边缘描一条线，焦痕会顺着线连续展开。':'按住画出走向，放大后处理局部细节。';
}
function coLayerList(){
  const strokes=state.brushStrokes||[];
  if(!strokes.length)return '<p class="co-empty-mini">先在照片上圈一个区域。</p>';
  return `<div class="co-layers">${strokes.map((s,i)=>`<div class="co-layer ${coSelectedStroke===s.id?'is-selected':''}"><button data-select-stroke="${escapeHtml(s.id)}" ${quickLocked()?'disabled':''}><i style="background:${/^#[a-f\d]{6}$/i.test(s.color||'')?s.color:CO_COLORS[s.type]}"></i><span>${String(i+1).padStart(2,'0')} · ${BRUSHES[s.type]?.label||'擦除'}<small>${s.mode==='area'?'圈区分布':s.mode==='edge'?'沿边蔓延':'手绘笔触'}</small></span></button><button data-delete-stroke="${escapeHtml(s.id)}" aria-label="删除第${i+1}笔" ${quickLocked()?'disabled':''}>${icon('trash')}</button></div>`).reverse().join('')}</div>`;
}
renderBrushWorkbench=function(){
  if(currentVisualValid())return `${quickResultHtml()}${state.job?.rawOutputUrl?`<div class="co-result-choice"><p>对比导回结果</p><button class="button outline-button full-width" id="coRawToggle">${coRawView?'查看区域融合版':'查看 AI 返回原图'}</button><small>区域融合保留未选中的服装和背景；原图可能改动更多位置。</small></div>`:''}<button id="quickDiscard" class="button text-button full-width">回到这轮绘制</button>${quickMessageHtml()}`;
  const s=brushSettings(),busy=quickLocked(),has=(state.brushStrokes||[]).some(s=>s.type!=='erase'),manual=state.mode==='manual_chatgpt';
  return `<div class="co-status-line"><span class="brush-live-dot"></span>本地绘制预览 <span>尚未 AI 融合</span></div>
  <div class="brush-palette">${Object.entries(BRUSHES).map(([type,b])=>`<button class="brush-choice ${b.className} ${s.type===type&&brushActive?'active':''}" data-brush-type="${type}" aria-pressed="${s.type===type&&brushActive}" ${busy?'disabled':''}>${icon(b.icon)}<span>${b.label}</span></button>`).join('')}</div>
  <div class="co-mode-choice" role="group" aria-label="绘制方式">${(s.type==='slash'||s.type==='erase'?[['free','手绘细节']]:s.type==='burn'?[['edge','沿边蔓延'],['area','圈区焦化'],['free','手绘细节']]:[['area','圈区分布'],['free','手绘细节']]).map(([mode,name])=>`<button data-co-mode="${mode}" aria-pressed="${s.mode===mode}" class="${s.mode===mode?'active':''}" ${busy?'disabled':''}>${name}</button>`).join('')}</div>
  <p class="brush-tip" id="brushTip">${coModeHelp()}</p>
  ${coPendingArea?'<div class="co-pending"><strong>这个区域的分布如何？</strong><div><button id="coAdoptArea" class="button primary-button">采用</button><button id="coRerollArea" class="button outline-button">换一种分布</button><button id="coCancelArea" class="button text-button">取消</button></div></div>':''}
  ${s.type==='blood'?`<div class="co-color-section"><label for="coBloodColor">痕迹颜色 <span>以场景设定为准</span></label><div class="co-swatches">${[['#782c2b','干燥暗红'],['#335c43','深绿'],['#315f86','深蓝'],['#452f4e','深紫']].map(([c,n])=>`<button data-co-color="${c}" style="--swatch:${c}" aria-label="${n}" title="${n}" class="${s.color===c?'active':''}" ${busy?'disabled':''}></button>`).join('')}<input id="coBloodColor" type="color" value="${s.color}" aria-label="自定义痕迹颜色" ${busy?'disabled':''}></div></div>`:''}
  <div class="brush-controls"><label for="brushSize"><span>${s.mode==='area'?'纹理尺度':'笔触宽度'}</span><output id="brushSizeValue">${Math.round(s.size*100)}%</output></label><input id="brushSize" type="range" min="0.8" max="20" step=".2" value="${s.size*100}" ${busy?'disabled':''}><label for="brushOpacity"><span>浓淡</span><output id="brushOpacityValue">${Math.round(s.opacity*100)}%</output></label><input id="brushOpacity" type="range" min="10" max="100" value="${s.opacity*100}" ${busy?'disabled':''}>
  ${s.type==='burn'?`<label for="coSpread"><span>蔓延范围</span><output id="coSpreadValue">${Math.round(s.spread*100)}%</output></label><input id="coSpread" type="range" min="10" max="100" value="${s.spread*100}" ${busy?'disabled':''}>`:''}
  ${s.type==='blood'&&s.mode==='area'?`<label for="coDirection"><span>飞溅走向</span><output id="coDirectionValue">${Math.round(s.direction*180/Math.PI)}°</output></label><input id="coDirection" type="range" min="-180" max="180" value="${Math.round(s.direction*180/Math.PI)}" ${busy?'disabled':''}>`:''}</div>
  <div class="brush-actions"><button id="brushUndo" class="button text-button" ${!state.brushStrokes.length||busy?'disabled':''}>${icon('undo')}撤销</button><button id="brushRedo" class="button text-button" ${!brushRedoFrames.length||busy?'disabled':''}>重做</button><button id="brushErase" class="button text-button ${s.type==='erase'?'active':''}" ${busy?'disabled':''}>${icon('erase')}擦除</button></div>
  <button id="brushProtect" class="button outline-button full-width ${!brushActive?'active':''}" ${busy?'disabled':''}>${icon('lock')}保护角色细节</button>
  <details class="co-layer-details" ${coSelectedStroke?'open':''}><summary>本轮痕迹 <span>${state.brushStrokes.length}</span></summary>${coLayerList()}${coSelectedStroke&&state.brushStrokes.find(s=>s.id===coSelectedStroke)?.type!=='erase'?`<button id="coApplyLayerSettings" class="button outline-button full-width" ${busy?'disabled':''}>把当前颜色与浓淡应用到所选痕迹</button>`:''}<button id="brushClear" class="button text-button full-width" ${!has||busy?'disabled':''}>清空本轮痕迹</button></details>
  <div class="co-refine-block"><label for="coRefineMode">AI 融合范围</label><select id="coRefineMode" ${busy?'disabled':''}><option value="natural" ${state.brushRefineMode==='natural'?'selected':''}>自然融合 · 允许区域内毛边与晕染</option><option value="strict" ${state.brushRefineMode==='strict'?'selected':''}>严格笔触 · 尽量贴合每一笔</option></select><p class="field-hint">圈区限制修改位置。保护区域优先保留。</p><button id="brushRefine" class="button primary-button full-width" ${!has||busy||coPendingArea||(!manual&&!cloudInfo().ready)?'disabled':''}>${icon(manual?'folder':'image')}${busy?'正在处理':manual?'下载 AI 精修包':'让 AI 融合这轮痕迹'}</button>${manual?`<button id="brushImportResult" class="button outline-button full-width" ${!has||busy||coPendingArea?'disabled':''}>导回 AI 精修图</button>`:''}</div>
  ${isJobRunning()?renderProgress():''}${quickMessageHtml()}
  <details class="details"><summary>补充精修要求</summary><textarea id="brushNote" rows="2" maxlength="1500" ${busy?'disabled':''} placeholder="例如：保留深蓝披风，让血迹呈干燥哑光。">${escapeHtml(state.customDamageIdea||'')}</textarea></details>${quickServiceHtml()}
  <button id="coGoMaking" class="button outline-button full-width">查看制作辅助 ${icon('right')}</button><button id="brushSaveSketch" class="button text-button full-width" ${!has||busy?'disabled':''}>保存绘制预览</button>`;
};

function coRecolor(stroke,color,opacity){
  if(!color){const r=deepCopy(stroke),ratio=opacity/Math.max(.001,stroke.opacity);r.opacity=opacity;r.shapes=r.shapes.map(p=>({...p,alpha:clamp(p.alpha*ratio,0,1)}));return r;}
  if(BattleBrushEngine.recolorStroke){const r=BattleBrushEngine.recolorStroke(deepCopy(stroke),color);const ratio=opacity/Math.max(.001,stroke.opacity);r.opacity=opacity;r.shapes=r.shapes.map(p=>({...p,alpha:clamp(p.alpha*ratio,0,1)}));return r;}
  const copy=deepCopy(stroke);copy.color=color;copy.opacity=opacity;
  const rgb=color.match(/[a-f\d]{2}/gi).map(x=>parseInt(x,16));
  copy.shapes=copy.shapes.map(p=>{const before=p.color.replace('#',''),hex=before.length===3?before.split('').map(x=>x+x).join(''):before;const v=[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16));const shade=clamp((v[0]+v[1]+v[2])/330,.28,1.4);return {...p,alpha:clamp(p.alpha*opacity/Math.max(.001,stroke.opacity),0,1),color:'#'+rgb.map(c=>Math.round(clamp(c*shade,0,255)).toString(16).padStart(2,'0')).join('')};});
  return copy;
}
function applyCoAction(action){
  if(quickLocked()||coPendingArea||coRegionDraft||brushStroke)throw Error('先结束当前操作，再采用建议。');
  if(!BRUSHES[action.brushType])throw Error('这项建议没有可用的画笔。');
  if(action.type==='set_brush'){
    selectBrush(action.brushType);const settings=brushSettings();
    state.brushSettings={...settings,...(action.color&&/^#[a-f\d]{6}$/i.test(action.color)?{color:action.color}:{}),...(Number.isFinite(action.opacity)?{opacity:clamp(action.opacity,.1,1)}:{}),...(Number.isFinite(action.size)?{size:clamp(action.size,.008,.2)}:{})};
    if(action.brushType==='blood')state.bloodColor=state.brushSettings.color;
    dirty({invalidate:false});render();toast('已准备好这支画笔。在图上圈区或描边即可。');return;
  }
  if(action.type==='adjust_effect'){
    if(currentVisualValid())throw Error('先采用效果继续绘制，或回到这轮绘制后调整。');
    const targets=state.brushStrokes.filter(s=>s.type===action.brushType&&(!coSelectedStroke||s.id===coSelectedStroke));
    if(!targets.length)throw Error('当前没有这种痕迹，请先画一个区域。');
    rememberBrush();state.brushStrokes=state.brushStrokes.map(s=>targets.includes(s)?coRecolor(s,action.color||null,clamp(s.opacity*(action.opacityScale||1),.1,1)):s);
    brushHandoff=null;dirty();render();toast('已采用建议，可用撤销恢复。');return;
  }
  throw Error('这项建议暂不支持直接应用。');
}
function coRefreshPending(){
  if(!coPendingArea)return;
  const c=$('#brushCanvas');coPendingArea=BattleBrushEngine.createAreaStroke({...coPendingArea,...brushSettings(),id:coPendingArea.id,points:coPendingArea.region.points,seed:coPendingArea.seed},c.width,c.height);renderBrushCanvas();
}
bindBrushWorkbench=function(){
  previousBindBrush();
  $$('[data-co-mode]').forEach(b=>b.addEventListener('click',()=>{if(coPendingArea){toast('先采用或取消区域预览。');return;}state.brushSettings={...brushSettings(),mode:b.dataset.coMode};brushActive=true;brushPan=false;dirty({invalidate:false});render();}));
  const colorChange=color=>{state.bloodColor=color;state.brushSettings={...brushSettings(),color};dirty({invalidate:false});coRefreshPending();render();};
  $$('[data-co-color]').forEach(b=>b.addEventListener('click',()=>colorChange(b.dataset.coColor)));
  $('#coBloodColor')?.addEventListener('change',e=>colorChange(e.target.value));
  for(const [id,key,unit] of [['coSpread','spread',100],['coDirection','direction',180/Math.PI]])$('#'+id)?.addEventListener('input',e=>{state.brushSettings={...brushSettings(),[key]:Number(e.target.value)/unit};$('#'+id+'Value').textContent=e.target.value+(id==='coDirection'?'°':'%');dirty({invalidate:false});coRefreshPending();});
  for(const id of ['brushSize','brushOpacity'])$('#'+id)?.addEventListener('input',coRefreshPending);
  $('#coRefineMode')?.addEventListener('change',e=>{state.brushRefineMode=e.target.value;brushHandoff=null;dirty();});
  $('#coAdoptArea')?.addEventListener('click',()=>{if(!coPendingArea)return;try{validateBrushDraft([...state.brushStrokes,coPendingArea]);rememberBrush();state.brushStrokes=[...state.brushStrokes,coPendingArea];coSelectedStroke=coPendingArea.id;coPendingArea=null;brushHandoff=null;dirty();render();}catch(e){toast(e.message);}});
  $('#coRerollArea')?.addEventListener('click',()=>{coPendingArea.seed=crypto.getRandomValues(new Uint32Array(1))[0];coRefreshPending();});
  $('#coCancelArea')?.addEventListener('click',()=>{coPendingArea=null;render();});
  $$('[data-select-stroke]').forEach(b=>b.addEventListener('click',()=>{coSelectedStroke=coSelectedStroke===b.dataset.selectStroke?null:b.dataset.selectStroke;const s=state.brushStrokes.find(s=>s.id===coSelectedStroke);if(s)state.brushSettings={...brushSettings(),type:s.type,color:s.color||CO_COLORS[s.type],opacity:s.opacity,mode:s.mode||'free'};render();}));
  $$('[data-delete-stroke]').forEach(b=>b.addEventListener('click',()=>{rememberBrush();state.brushStrokes=state.brushStrokes.filter(s=>s.id!==b.dataset.deleteStroke);coSelectedStroke=null;brushHandoff=null;dirty();render();}));
  $('#coApplyLayerSettings')?.addEventListener('click',()=>{if(quickLocked()||coPendingArea)return;const selectedStroke=state.brushStrokes.find(s=>s.id===coSelectedStroke);if(!selectedStroke||selectedStroke.type==='erase'){toast('擦除痕迹可以删除或撤销，不需要换色。');return;}const settings=brushSettings();rememberBrush();state.brushStrokes=state.brushStrokes.map(s=>s.id===coSelectedStroke?coRecolor(s,settings.color,settings.opacity):s);brushHandoff=null;dirty();render();});
  $('#coGoMaking')?.addEventListener('click',()=>goQuickStage('finish'));
  $('#coRawToggle')?.addEventListener('click',()=>{coRawView=!coRawView;render();});
};

startBrush=function(event){
  if(coPendingArea){toast('先采用或取消当前区域预览。');return;}
  if(brushSettings().mode!=='area'||brushPan||!brushActive)return previousStartBrush(event);
  if(!brushCanEdit()||quickLocked()||compare||event.button!==0||!event.isPrimary)return;
  if(state.brushStrokes.length>=80){toast('本轮已到80笔，先精修后继续。');return;}
  coRegionDraft=[brushPoint(event)];coRegionPointer=event.pointerId;brushSource=imageReference().url;
  const c=$('#brushCanvas');c.focus({preventScroll:true});c.setPointerCapture(event.pointerId);event.preventDefault();scheduleBrushRender();
};
moveBrush=function(event){
  if(!coRegionDraft)return previousMoveBrush(event);
  if(event.pointerId!==coRegionPointer)return;
  const p=brushPoint(event),last=coRegionDraft.at(-1);
  if(Math.hypot(p.x-last.x,p.y-last.y)>.004&&coRegionDraft.length<256)coRegionDraft.push(p);
  event.preventDefault();scheduleBrushRender();
};
finishBrush=function(event){
  if(!coRegionDraft)return previousFinishBrush(event);
  if(event&&event.pointerId!==coRegionPointer)return;
  const points=coRegionDraft;coRegionDraft=null;coRegionPointer=null;
  const c=$('#brushCanvas');if(event&&c.hasPointerCapture(event.pointerId))c.releasePointerCapture(event.pointerId);
  const area=Math.abs(points.reduce((v,p,i)=>{const q=points[(i+1)%points.length];return v+p.x*q.y-q.x*p.y;},0))/2;
  if(points.length<3||area<.0005){toast('圈出的区域太小。请沿区域外围画一圈。');renderBrushCanvas();return;}
  if(brushSource!==imageReference()?.url)return;
  try{coPendingArea=BattleBrushEngine.createAreaStroke({...brushSettings(),id:uid('region'),points,seed:crypto.getRandomValues(new Uint32Array(1))[0]},c.width,c.height);validateBrushDraft([...state.brushStrokes,coPendingArea]);render();toast('区域分布已预览。可以调整浓淡或换一种分布，再采用。');}catch(e){coPendingArea=null;toast(e.message);renderBrushCanvas();}
};
cancelBrush=function(){coRegionDraft=null;coRegionPointer=null;previousCancelBrush();};
function coDrawOutline(ctx,points,w,h,fill=false){
  if(!points?.length)return;ctx.save();ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x*w,p.y*h):ctx.moveTo(p.x*w,p.y*h));ctx.closePath();
  if(fill){ctx.fillStyle='rgba(145,211,210,.1)';ctx.fill();}ctx.setLineDash([7,5]);ctx.lineWidth=Math.max(1.2,w/700);ctx.strokeStyle='#ddf7ef';ctx.stroke();ctx.restore();
}
renderBrushCanvas=function(){
  previousBrushCanvas();const c=$('#brushCanvas');if(!c||c.hidden)return;
  if(coPendingArea)BattleBrushEngine.draw(c,[...state.brushStrokes,coPendingArea],{protectedRects:state.protectedRects});
  const ctx=c.getContext('2d'),outline=coRegionDraft||coPendingArea?.region?.points||state.brushStrokes.find(s=>s.id===coSelectedStroke)?.region?.points;
  if(outline)coDrawOutline(ctx,outline,c.width,c.height,!!coRegionDraft);
  $('#canvasCaption').textContent=coPendingArea?'区域预览 · 采用后加入本轮方案':coModeHelp();
  const tip=$('#brushTip');if(tip)tip.textContent=coModeHelp();
};
renderCanvas=function(){
  previousRenderCanvas();
  if(coRawView&&currentVisualValid()&&state.job?.rawOutputUrl&&!compare){$('#garmentImage').src=state.job.rawOutputUrl;$('#canvasCaption').textContent='AI 返回原图 · 尚未按保护区域与编辑范围融合';$('#canvasModeNotice').textContent='AI 原始返回';}
};
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&coPendingArea){coPendingArea=null;render();}});
