/* First see an image, then refine it. The accepted image becomes the next edit's source. */
'use strict';
let quickBusy=false,quickMessage='',quickImportContext=null;
const quickInput=document.createElement('input');
quickInput.type='file';quickInput.accept='image/png,image/jpeg,image/webp';quickInput.hidden=true;
document.body.append(quickInput);
const QUICK_STAGES=[['first','底图与方向','从照片开始'],['refine','画笔调整','画着改'],['finish','制作准备','确认后再做']];
function clearQuickMessage(){quickMessage='';quickImportContext=null;}
function currentDraftValid(){return !!state.job&&state.job.artifactKind==='draft'&&state.job.status==='succeeded'&&Number(state.job.projectRevision)===Number(state.revision)&&!hasPendingEdits();}
function currentVisualValid(){return currentDraftValid()||currentResultValid();}
function quickLocked(){return quickBusy||workflowBusy||isJobRunning()||['queued','running'].includes(state.conceptJob?.status);}
function quickEffectNote(type){return {blood:'干燥暗红的哑光戏剧假血，飞溅有主次和方向；不要湿亮、液滴或长条流淌。',slash:'清楚可见的织物割裂，有合理的开口和短毛边；保留衣服版型，避免只有浅线条。',burn:'以深棕到灰黑的色层、磨损边缘表现衣物焦痕，保留结构与接缝。'}[type]||'';}
function ensureQuickSwitch(){
  if(!$('#quickFlowSwitch')){const b=document.createElement('button');b.id='quickFlowSwitch';b.className='button text-button quick-flow-switch';$('.project-heading').append(b);b.addEventListener('click',()=>{state.quickMode=!state.quickMode;dirty({invalidate:false});render();});}
  $('#quickFlowSwitch').textContent=state.quickMode?'完整流程':'返回简洁流程';
  $('#quickFlowSwitch').disabled=quickLocked();
}
function quickMessageHtml(){
  const message=quickMessage|| (state.job?.status==='failed'?state.job.message||'这次没有生成成功。':'' );
  return message?`<div class="quick-error" role="status"><strong>本次未完成</strong><p>${escapeHtml(message)}</p><small>没有自动重试。可以检查图像服务，或改用 ChatGPT 生成包。</small></div>`:'';
}
function quickServiceHtml(){
  const manual=state.mode==='manual_chatgpt',ready=cloudInfo().ready;
  return `<details class="details quick-service"><summary>生成方式 · ${manual?'ChatGPT 生成包':escapeHtml(providerName())}</summary><label class="choice-row"><input type="radio" name="quickService" value="cloud_image_edit" ${!manual?'checked':''} ${quickLocked()?'disabled':''}><span>直接通过图像接口生成</span></label><label class="choice-row"><input type="radio" name="quickService" value="manual_chatgpt" ${manual?'checked':''} ${quickLocked()?'disabled':''}><span>在 ChatGPT 中生成，再导回图片</span></label><button id="configureCloud" class="button text-button full-width">设置图像服务</button>${!manual&&!ready?'<p class="field-hint">接口尚未配置，请在图像服务中填写。</p>':''}</details>`;
}
function quickResultHtml(){
  if(!currentVisualValid())return '';
  return `<div class="quick-result-card"><span class="eyebrow">${currentDraftValid()?'FIRST LOOK':'NEXT VERSION'}</span><h3>${currentDraftValid()?'先看整体，再决定怎么改。':'这一版的修改完成了。'}</h3><p>用右侧原图按钮比较效果。满意的部分保留下来，下一次只修改你选中的地方。</p><button id="quickAccept" class="button primary-button full-width" ${quickLocked()?'disabled':''}>${icon('rect')}继续画着调整这版</button><button id="quickDownload" class="button outline-button full-width" ${quickLocked()?'disabled':''}>${icon('image')}保存这张效果图</button>${currentResultValid()?'<button id="quickFinish" class="button text-button full-width">整理制作建议</button>':''}</div>`;
}
function renderQuickFirst(){
  const busy=quickLocked(),manual=state.mode==='manual_chatgpt',valid=currentVisualValid();
  return `${valid?quickResultHtml():`<button id="uploadButton" class="upload-box" ${busy?'disabled':''}>${icon('upload')}<strong>${state.reference?.uploaded?'更换服装照片':'上传服装照片'}</strong><span>穿着正面照或平铺照 · PNG / JPG / WebP</span></button><button id="quickDirectPaint" class="button primary-button full-width quick-direct-paint" ${!imageReference()||busy?'disabled':''}>${icon('brush')}直接画我的方案</button><p class="field-hint">血迹、割裂、磨损、焦痕。先落笔看效果，再由 AI 融合。</p>`}
  ${!valid?`<details class="details quick-first-alternative"><summary>或者，先让 AI 给一个整体方向</summary><div class="field quick-idea"><label for="quickIdea">想要什么感觉？<span class="muted"> 可选</span></label><textarea id="quickIdea" maxlength="1500" rows="2" ${busy?'disabled':''} placeholder="例如：明显的刀痕与干燥血迹，保留领口装饰。">${escapeHtml(state.customDamageIdea)}</textarea><small>留空也能开始，细节看图之后再调整。</small></div><button id="quickGenerate" class="button outline-button full-width" ${!imageReference()||busy||(!manual&&!cloudInfo().ready)?'disabled':''}>${icon(manual?'folder':'image')}${busy?'正在处理':manual?'下载首版生成包':'先生成一版'}</button>${manual?'<a class="button text-button full-width" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">打开 ChatGPT</a>':''}</details>`:`<button id="quickRegenerate" class="button text-button full-width" ${busy?'disabled':''}>换一个整体方向</button>`}
  ${manual&&!valid?`<button id="quickImport" class="button text-button full-width" ${busy||!imageReference()?'disabled':''}>导入已有的 AI 效果图</button>`:''}
  ${state.job&&isJobRunning()?`<div class="quick-pending" role="status"><span class="quick-spinner"></span><strong>正在生成整体效果</strong><p>${escapeHtml(state.job.message||'正在生成，请稍候。')}</p></div>`:''}${quickMessageHtml()}
  ${!valid?quickServiceHtml():''}<details class="details quick-catalog"><summary>先用示例试一试</summary>${catalog.garments.map(g=>`<button class="garment-option" data-garment="${escapeHtml(g.id)}" ${busy?'disabled':''}><img src="${escapeHtml(safeUrl(g.imageUrl))}" alt=""><span><strong>${escapeHtml(g.name)}</strong><small>流程示例</small></span></button>`).join('')}</details><button id="quickDetailed" class="button text-button full-width">补充剧情或二维参考</button>`;
}
function renderQuickRefine(){
  if(state.brushMode!==false&&typeof renderBrushWorkbench==='function')return renderBrushWorkbench();
  if(currentVisualValid())return `${quickResultHtml()}<button id="quickDiscard" class="button text-button full-width" ${quickLocked()?'disabled':''}>回到修改前这一版</button>${quickMessageHtml()}`;
  const busy=quickLocked(),manual=state.mode==='manual_chatgpt';
  return `<p class="quick-lead">${state.quickParentJobId?'已保留上一版效果。':'可以直接在当前底图上修改。'}只圈出这次想改的地方。</p><div class="damage-types">${Object.entries(DAMAGE).map(([type,d])=>`<button class="damage-type ${currentDamage===type?'active':''}" data-damage-type="${type}" aria-pressed="${currentDamage===type}" ${busy?'disabled':''}>${icon(d.icon)}${d.label}</button>`).join('')}</div><div class="region-actions"><button id="addDamage" class="button outline-button" ${busy?'disabled':''}>${icon('plus')}添加${DAMAGE[currentDamage].label}</button><button id="addProtection" class="button outline-button" ${busy?'disabled':''}>${icon('lock')}保护细节</button></div><p class="field-hint">在图上画框，选中后调整程度，或写一句“减少血迹 / 增加破口”。</p><div class="region-list">${regionList()}</div><div class="divider"></div><button id="quickRefineGenerate" class="button primary-button full-width" ${!state.damageItems.length||busy||(!manual&&!cloudInfo().ready)?'disabled':''}>${icon(manual?'folder':'image')}${busy?'正在处理':manual?'下载局部修改包':'生成这次局部修改'}</button>${manual?`<button id="importCostumeResult" class="button outline-button full-width" ${!state.damageItems.length||busy?'disabled':''}>导回局部效果图</button>`:''}${isJobRunning()?renderProgress():''}${quickMessageHtml()}${quickServiceHtml()}<details class="details"><summary>补充剧情和整体方向</summary><p class="field-hint">角色与情境可稍后补充，不影响先比较外观。</p><button id="quickDetailed" class="button outline-button full-width">进入完整流程</button></details><button id="quickBack" class="button text-button full-width" ${busy?'disabled':''}>返回整体预览</button>`;
}
function renderQuickFinish(){
  return renderCheck()+`<button id="quickExport" class="button primary-button full-width" style="margin-top:16px">导出制作方案</button><button id="quickReturnRefine" class="button text-button full-width">继续调整外观</button>`;
}
function renderQuickLayout(){
  document.body.classList.add('quick-workflow');
  document.body.classList.toggle('quick-first',state.quickStage==='first');
  document.body.classList.toggle('quick-result',currentVisualValid());
  ensureQuickSwitch();
  const stage=QUICK_STAGES.find(s=>s[0]===state.quickStage)||QUICK_STAGES[0];
  $('#studioTitle').textContent=state.quickStage==='refine'&&state.brushMode!==false?'把战斗痕迹，画在衣服上。':'先看见，再决定。';
  $('#stepper').innerHTML=QUICK_STAGES.map(([id,title,subtitle],i)=>`<li><button class="step-button" data-quick-stage="${id}" ${stage[0]===id?'aria-current="step"':''} ${quickLocked()?'disabled':''}><span class="step-number">${String(i+1).padStart(2,'0')}</span><span class="step-label">${title}<span class="step-subtitle">${subtitle}</span></span></button></li>`).join('');
  $('#stepEyebrow').textContent=`STEP ${String(QUICK_STAGES.indexOf(stage)+1).padStart(2,'0')}`;
  $('#stepTitle').textContent={first:'从你的服装照片开始',refine:state.brushMode!==false?'用画笔安排痕迹':'看着图片慢慢改',finish:'把方案带到实物上'}[stage[0]];
  $('#stepDescription').textContent={first:'直接画出战损，也可以先让 AI 给一版，再画着调整。',refine:state.brushMode!==false?'落笔即看见效果。用笔触决定位置和走向，再交给 AI 融合。':'保留满意的部分，再调整位置、形态与程度。',finish:'确认外观后，再核对面料、恢复要求和制作方法。'}[stage[0]];
  $('.panel-bottom').hidden=true;
  $('#stepContent').innerHTML=stage[0]==='first'?renderQuickFirst():stage[0]==='refine'?renderQuickRefine():renderQuickFinish();
  bindPanel();bindWorkflowExtras();bindQuick();renderCanvas();renderEditor();
  if(stage[0]==='first'||currentVisualValid())$('#selectionEditor').hidden=true;
}
function applyQuickCanvas(){
  const preview=currentVisualValid(),editing=state.quickStage==='refine'&&!preview;
  $('#canvasTitle').textContent=preview?'这一版的整体效果':state.quickParentJobId?'已采用的效果底图':state.reference?.uploaded?'我的服装照片':garment()?.name||'服装照片';
  $('#regionOverlay').style.visibility=editing&&showRegions&&!compare?'visible':'hidden';
  $('#regionOverlay').style.pointerEvents=editing&&!quickLocked()?'auto':'none';
  for(const id of ['selectTool','drawTool','protectTool','undoButton','regionsButton'])$('#'+id).hidden=!editing;
  $('#compareButton').hidden=!state.quickParentJobId&&!preview;
  $('.canvas-toolbar').hidden=!editing&&!preview&&!state.quickParentJobId;
  for(const legend of $$('.canvas-legend>span:not(.legend-note)'))legend.hidden=!editing;
  $('.canvas-ruler').hidden=!editing;
  $('#regionCount').textContent=editing?`${state.damageItems.length} 个修改区域`:preview?'整体效果预览':'服装原貌';
  $('#canvasCaption').textContent=compare?'最初上传的服装照片':preview?'视觉方案预览 · 材料效果需试样确认':state.quickParentJobId?'下一次局部修改基于这张图':'保留服装特征，先比较整体外观';
  if(!preview&&!compare&&!editing)$('#canvasModeNotice').textContent=state.quickParentJobId?'已采用的效果底图':'服装原图';
}
function goQuickStage(stage){
  if(quickLocked())return;
  if(stage==='refine'&&currentVisualValid()){acceptQuickResult();return;}
  if(stage!=='first'&&!imageReference()){toast('请先上传服装照片。');return;}
  state.quickStage=stage;if(stage==='refine'){state.customDamageEnabled=true;state.step=2;}if(stage==='finish')state.step=4;
  dirty({invalidate:false});render();
}
function bindQuick(){
  $$('[data-quick-stage]').forEach(b=>b.addEventListener('click',()=>goQuickStage(b.dataset.quickStage)));
  $('#quickIdea')?.addEventListener('input',e=>{state.customDamageIdea=e.target.value;state.customDamageEnabled=true;quickMessage='';dirty();});
  $$('[name=quickService]').forEach(input=>input.addEventListener('change',()=>{state.mode=input.value;quickMessage='';dirty();render();}));
  $('#quickGenerate')?.addEventListener('click',generateQuickDraft);
  $('#quickDirectPaint')?.addEventListener('click',()=>{state.brushMode=true;goQuickStage('refine');});
  if(typeof bindBrushWorkbench==='function')bindBrushWorkbench();
  $('#quickImport')?.addEventListener('click',()=>{if(quickLocked())return;quickInput.click();});
  $('#quickAccept')?.addEventListener('click',acceptQuickResult);
  $('#quickDownload')?.addEventListener('click',downloadQuickResult);
  $('#quickFinish')?.addEventListener('click',()=>goQuickStage('finish'));
  $('#quickReturnRefine')?.addEventListener('click',()=>goQuickStage('refine'));
  if(state.brushMode===false&&state.quickStage==='refine'&&!currentVisualValid()){const b=document.createElement('button');b.className='button text-button full-width';b.textContent='返回战损画笔';b.addEventListener('click',()=>{state.brushMode=true;dirty({invalidate:false});render();});$('#stepContent').prepend(b);}
  $('#quickBack')?.addEventListener('click',()=>goQuickStage('first'));
  $('#quickRegenerate')?.addEventListener('click',()=>{if(quickLocked())return;state.job=null;state.previewUrl=null;dirty({invalidate:false});render();$('#quickIdea')?.focus();});
  $('#quickDiscard')?.addEventListener('click',()=>{if(quickLocked())return;state.job=null;state.previewUrl=null;dirty({invalidate:false});render();});
  $('#quickDetailed')?.addEventListener('click',()=>{if(quickLocked())return;state.quickMode=false;state.step=1;dirty({invalidate:false});render();});
  $('#quickRefineGenerate')?.addEventListener('click',generatePreview);
  $('#quickExport')?.addEventListener('click',()=>{$('#exportResult').hidden=!currentResultValid();$('#exportDialog').showModal();});
}
function quickContext(){return {projectId:state.projectId,revision:state.revision,signature:contentSignature()};}
function quickContextMatches(c){return c.projectId===state.projectId&&c.revision===state.revision&&c.signature===contentSignature()&&!hasPendingEdits();}
async function generateQuickDraft(){
  if(quickLocked()||!imageReference())return;
  quickBusy=true;quickMessage='';render();
  try{
    await saveProject(false);if(hasPendingEdits())throw Error('照片或方向已修改，请先保存当前版本。');const context=quickContext();
    if(state.mode==='manual_chatgpt'){
      const res=await api(`/api/projects/${encodeURIComponent(state.projectId)}/draft-handoff`);
      downloadBlob(await res.blob(),`${state.title}-首版效果-ChatGPT生成包.zip`);
      if(quickContextMatches(context)){quickImportContext=context;state.handoffContexts={...(state.handoffContexts||{}),draft:context};dirty({invalidate:false});}
      toast('解压后，把服装图片和提示词交给 ChatGPT；生成完成后导回图片。');
    }else{
      const job=await api(`/api/projects/${encodeURIComponent(state.projectId)}/draft-jobs`,{method:'POST',body:JSON.stringify({projectRevision:state.revision})});
      if(quickContextMatches(context)){state.job=job;state.previewUrl=null;pollJob(job.id,context);}else toast('本次任务保存在提交时的方案版本中。');
    }
  }catch(error){quickMessage=error.message;toast(error.message);}finally{quickBusy=false;render();}
}
quickInput.addEventListener('change',async()=>{
  const file=quickInput.files[0];quickInput.value='';if(!file||quickLocked())return;
  if(file.size>20*1024*1024){toast('图片超过20MB，请缩小后再导回。');return;}
  const previous=quickImportContext||state.handoffContexts?.draft;
  if(previous&&(previous.projectId!==state.projectId||previous.signature!==contentSignature())){quickMessage='下载生成包后方案已经改变，请重新下载对应版本的首版生成包。';render();return;}
  quickBusy=true;quickMessage='';render();
  try{await saveProject(false);const context=quickContext(),form=new FormData();form.append('file',file);form.append('projectRevision',String(state.revision));const data=await api(`/api/projects/${encodeURIComponent(state.projectId)}/import-draft`,{method:'POST',body:form});if(!quickContextMatches(context))throw Error('方案已修改，图片保存在导回时的版本中。');state.job=data.job||data;state.previewUrl=state.job.outputUrl||state.job.previewUrl;state.qualityChecklist={};dirty({invalidate:false});toast('首版效果已导回。满意后，点击“继续调整这版”。');}catch(error){quickMessage=error.message;toast(error.message);}finally{quickBusy=false;render();}
});
async function acceptedResultBlob(){
  const url=new URL(state.previewUrl||'',location.origin);
  if(url.origin!==location.origin||!/^\/data\/jobs\/[a-zA-Z0-9_-]+\/result\.png$/.test(url.pathname))throw Error('结果图地址无法核对。');
  const res=await fetch(url.href);if(!res.ok)throw Error('结果图暂时无法读取。');return res.blob();
}
async function acceptQuickResult(){
  if(quickLocked()||!currentVisualValid())return;
  const context=quickContext(),jobId=state.job.id,previous=deepCopy(imageReference());
  quickBusy=true;render();
  try{
    const blob=await acceptedResultBlob(),form=new FormData();form.append('file',blob,'accepted-preview.png');
    const ref=await api('/api/uploads',{method:'POST',body:form});
    if(!quickContextMatches(context)||state.job?.id!==jobId||!currentVisualValid())throw Error('方案或待采用结果已修改，未替换当前底图。');
    state.quickOriginalReference=state.quickOriginalReference||previous;
    state.reference={...ref,url:ref.url||ref.imageUrl,uploaded:true,generated:true,jobId,name:'已采用的预览'};
    state.quickParentJobId=jobId;state.quickStage='refine';state.step=2;state.damageItems=[];state.protectedRects=[];state.brushStrokes=[];state.brushMode=true;if(typeof resetBrushHistory==='function')resetBrushHistory();state.planNotes=[];state.customDamageEnabled=true;
    state.job=null;state.previewUrl=null;selected=null;history=[];compare=false;$('#compareButton').setAttribute('aria-pressed','false');quickImportContext=null;state.handoffContexts={};quickMessage='';dirty();await saveProject(false);
    toast('已采用这一版。下一次局部修改会基于它，保留已经满意的效果。');
  }catch(error){quickMessage=error.message;toast(error.message);}finally{quickBusy=false;render();}
}
async function downloadQuickResult(){if(!currentVisualValid())return;try{downloadBlob(await acceptedResultBlob(),`${state.title}-效果预览.png`);}catch(error){toast(error.message);}}
