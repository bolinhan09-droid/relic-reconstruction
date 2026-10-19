/* Immediate drawing is a local sketch. AI refinement is a separate, explicit action. */
'use strict';
const BRUSHES={blood:{label:'血迹',icon:'drop',hint:'顺着飞溅的方向画',className:'blood'},slash:{label:'割裂',icon:'slash',hint:'沿破口的走向画',className:'slash'},wear:{label:'磨损',icon:'wear',hint:'在边角轻扫几笔',className:'wear'},burn:{label:'焦痕',icon:'burn',hint:'安排焦黑的边缘',className:'burn'}};
let brushActive=true,brushStroke=null,brushSource='',brushFrame=0,brushUndoFrames=[],brushRedoFrames=[],brushHandoff=null,brushZoom=1,brushPan=false,brushPanPointer=null,brushOffset={x:0,y:0};
const brushImport=document.createElement('input');brushImport.type='file';brushImport.accept='image/png,image/jpeg,image/webp';brushImport.hidden=true;document.body.append(brushImport);

function validateBrushDraft(strokes){
  if(!Array.isArray(strokes)||strokes.length>80)throw new Error('笔触数据超过80笔，请拆成几轮精修。');
  let shapes=0;
  for(const s of strokes){
    if(!s||![...Object.keys(BRUSHES),'erase'].includes(s.type)||!Array.isArray(s.points)||s.points.length>2000||!Array.isArray(s.shapes))throw new Error('笔触文件格式不完整。');
    if(!Number.isFinite(s.size)||s.size<=0||s.size>1||!Number.isFinite(s.opacity)||s.opacity<0||s.opacity>1||!Number.isInteger(s.seed)||s.seed<0||s.seed>4294967295)throw new Error('笔触参数无法读取。');
    for(const p of s.points){if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.x>1||p.y<0||p.y>1)throw new Error('笔触坐标超出了图片。');}
    for(const p of s.shapes){
      if(!['ellipse','polygon'].includes(p.kind)||!/^#[a-f\d]{3}([a-f\d]{3})?$/i.test(p.color)||!Number.isFinite(p.alpha)||p.alpha<0||p.alpha>1)throw new Error('笔触形状无法读取。');
      const values=p.kind==='ellipse'?[p.cx,p.cy,p.rx,p.ry]:(Array.isArray(p.points)&&p.points.length>=3&&p.points.length<=256?p.points.flatMap(q=>[q.x,q.y]):[NaN]);
      if(values.some(v=>!Number.isFinite(v)||v<0||v>1))throw new Error('笔触形状超出了图片。');
    }
    shapes+=s.shapes.length;
  }
  if(shapes>20000)throw new Error('笔触过于复杂，请先精修这一轮，再继续绘制。');
  return strokes;
}
function brushSettings(){const s=state.brushSettings||{};return {type:[...Object.keys(BRUSHES),'erase'].includes(s.type)?s.type:'blood',size:clamp(s.size||.075,.015,.2),opacity:clamp(s.opacity||.88,.2,1)};}
function brushCanEdit(){return state.quickMode&&state.quickStage==='refine'&&state.brushMode!==false&&!currentVisualValid()&&!!imageReference();}
function resetBrushHistory(){brushUndoFrames=[];brushRedoFrames=[];brushStroke=null;brushHandoff=null;brushActive=true;brushZoom=1;brushPan=false;brushPanPointer=null;brushOffset={x:0,y:0};}
function rememberBrush(){brushUndoFrames.push([...(state.brushStrokes||[])]);if(brushUndoFrames.length>35)brushUndoFrames.shift();brushRedoFrames=[];}
function brushSummary(){const strokes=state.brushStrokes||[];return `${strokes.filter(s=>s.type!=='erase').length} 笔痕迹 · ${state.protectedRects.length} 个保护区域`;}
function brushMakingSummary(){return Object.entries(BRUSHES).filter(([type])=>(state.brushStrokes||[]).some(s=>s.type===type)).map(([type,b])=>`<li><strong>画笔 · ${b.label}</strong><br>位置与走向见绘制引导图；擦除和保护部分不参与精修。<br>${escapeHtml(type==='wear'?'先在同材质废布或可拆贴片上试磨毛、褪色与固定方式，避免损伤承重接缝。':recipe(type))}</li>`).join('');}
function renderBrushWorkbench(){
  if(currentVisualValid())return `${quickResultHtml()}<button id="quickDiscard" class="button text-button full-width" ${quickLocked()?'disabled':''}>回到精修前的画笔方案</button>${quickMessageHtml()}`;
  const busy=quickLocked(),s=brushSettings(),has=(state.brushStrokes||[]).some(stroke=>stroke.type!=='erase'),manual=state.mode==='manual_chatgpt';
  return `<div class="brush-intro"><span class="brush-live-dot"></span><span>画笔草图 · 即时预览</span><small>尚未经过 AI 融合</small></div>
    <div class="brush-palette" role="group" aria-label="战损画笔">${Object.entries(BRUSHES).map(([type,b])=>`<button class="brush-choice ${b.className} ${s.type===type&&brushActive?'active':''}" data-brush-type="${type}" aria-pressed="${s.type===type&&brushActive}" ${busy?'disabled':''}>${icon(b.icon)}<span>${b.label}</span><small>${b.hint}</small></button>`).join('')}</div>
    <div class="brush-controls"><label for="brushSize"><span>笔触大小</span><output id="brushSizeValue">${Math.round(s.size*100)}%</output></label><input id="brushSize" type="range" min="1.5" max="20" step=".5" value="${s.size*100}" ${busy?'disabled':''}><label for="brushOpacity"><span>浓淡</span><output id="brushOpacityValue">${Math.round(s.opacity*100)}%</output></label><input id="brushOpacity" type="range" min="20" max="100" step="5" value="${s.opacity*100}" ${busy?'disabled':''}></div>
    <div class="brush-actions"><button id="brushErase" class="button text-button ${s.type==='erase'&&brushActive?'active':''}" aria-pressed="${s.type==='erase'&&brushActive}" ${busy?'disabled':''}>${icon('erase')}橡皮</button><button id="brushUndo" class="button text-button" ${!(state.brushStrokes||[]).length||busy?'disabled':''}>${icon('undo')}撤销</button><button id="brushRedo" class="button text-button" ${!brushRedoFrames.length||busy?'disabled':''}>重做</button></div>
    <div class="brush-focus-row"><button id="brushProtect" class="button outline-button ${!brushActive?'active':''}" ${busy?'disabled':''}>${icon('lock')}保护领口 / 标志</button><button id="brushClear" class="button text-button" ${!(state.brushStrokes||[]).length||busy?'disabled':''}>清空笔触</button></div>
    <p class="brush-tip" id="brushTip">${brushActive?'点一下可以盖印，拖动画出走向。画错了可以擦掉或撤销。':'在图上框出要保留的细节，或使用下方数值修改范围。选一种画笔即可继续画。'}</p>
    <div class="brush-summary" id="brushSummary">${brushSummary()}</div>${state.damageItems.length?'<p class="field-hint">额外框选区域也会参与精修。橡皮只擦除笔触；取消框选请在区域设置中删除。</p>':''}
    <button id="brushRefine" class="button primary-button full-width" ${!has||busy||(!manual&&!cloudInfo().ready)?'disabled':''}>${icon(manual?'folder':'image')}${busy?'正在处理':manual?'下载画笔精修包':'AI 融合这些笔触'}</button>
    ${manual?`<button id="brushImportResult" class="button outline-button full-width" ${!has||busy?'disabled':''}>导回 AI 精修效果图</button>`:''}
    <button id="brushSaveSketch" class="button text-button full-width" ${!has||busy?'disabled':''}>${icon('save')}保存绘制预览</button>
    ${isJobRunning()?renderProgress():''}${quickMessageHtml()}
    <p class="field-hint brush-boundary">AI 按笔触位置融合材质。保护区域与笔触之外的像素保留原图；实际面料效果仍需小样确认。</p>
    <details class="details"><summary>补充一句精修要求</summary><label class="sr-only" for="brushNote">精修要求</label><textarea id="brushNote" maxlength="1500" rows="2" placeholder="例如：血迹更干燥，刀痕保留短毛边。">${escapeHtml(state.customDamageIdea)}</textarea></details>
    ${quickServiceHtml()}<button id="brushAdvanced" class="button text-button full-width">使用区域框与详细设置</button><button id="quickBack" class="button text-button full-width" ${busy?'disabled':''}>返回整体方向</button>`;
}
function ensureBrushCanvas(){
  if($('#brushCanvas'))return;
  const canvas=document.createElement('canvas');canvas.id='brushCanvas';canvas.tabIndex=0;canvas.setAttribute('role','img');canvas.setAttribute('aria-label','战损绘制画布，点击盖印或拖动画出笔触。数字1至4选择画笔，Ctrl加Z撤销，Escape取消当前笔触。');
  $('#garmentCanvas').append(canvas);
  const bar=document.createElement('div');bar.id='brushCanvasTools';bar.className='brush-canvas-bar';bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','画布旁的画笔工具');$('#canvasStage').before(bar);
  const view=document.createElement('div');view.id='brushViewTools';view.className='tool-group brush-view-tools';view.innerHTML='<button id="brushZoom" class="tool-button" aria-label="放大照片查看细节">放大 · 100%</button><button id="brushFit" class="tool-button">适应画布</button>';$('.canvas-toolbar').prepend(view);
  $('#brushZoom').addEventListener('click',()=>{if(brushStroke)return;const levels=[1,1.5,2,3];brushZoom=levels[(levels.indexOf(brushZoom)+1)%levels.length];if(brushZoom===1)brushOffset={x:0,y:0};renderBrushCanvas();});
  $('#brushFit').addEventListener('click',()=>{brushZoom=1;brushOffset={x:0,y:0};brushPan=false;renderBrushCanvas();});
  const cursor=document.createElement('span');cursor.id='brushCursor';cursor.setAttribute('aria-hidden','true');cursor.hidden=true;$('#garmentCanvas').append(cursor);
  canvas.addEventListener('pointerdown',startBrush);canvas.addEventListener('pointermove',moveBrush);
  canvas.addEventListener('pointerup',finishBrush);canvas.addEventListener('pointercancel',cancelBrush);canvas.addEventListener('lostpointercapture',()=>{if(brushStroke||brushPanPointer)cancelBrush();});
  canvas.addEventListener('pointerleave',()=>{if(!brushStroke)cursor.hidden=true;});
  canvas.addEventListener('keydown',e=>{if(e.key==='Escape'){cancelBrush();return;}if(e.ctrlKey||e.metaKey){if(e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redoBrush():undoBrush();}if(e.key.toLowerCase()==='y'){e.preventDefault();redoBrush();}}else if(['1','2','3','4'].includes(e.key)){e.preventDefault();selectBrush(Object.keys(BRUSHES)[Number(e.key)-1]);}});
}
function scheduleBrushRender(){if(brushFrame)return;brushFrame=requestAnimationFrame(()=>{brushFrame=0;renderBrushCanvas();});}
function renderBrushCanvas(){
  ensureBrushCanvas();const canvas=$('#brushCanvas'),cursor=$('#brushCursor'),edit=brushCanEdit(),visible=edit&&!compare;
  document.body.classList.toggle('brush-workflow',edit);
  $('#brushViewTools').hidden=!edit;$('#garmentCanvas').style.transform=edit?`translate(${brushOffset.x}px,${brushOffset.y}px) scale(${brushZoom})`:'';
  $('#brushZoom').textContent=`放大 · ${Math.round(brushZoom*100)}%`;
  const bar=$('#brushCanvasTools');bar.hidden=!edit;
  if(edit){const s=brushSettings();bar.innerHTML=Object.entries(BRUSHES).map(([type,b])=>`<button data-canvas-brush="${type}" class="tool-button ${s.type===type&&brushActive&&!brushPan?'active':''}" aria-label="${b.label}画笔" aria-pressed="${s.type===type&&brushActive&&!brushPan}" ${quickLocked()?'disabled':''}>${icon(b.icon)}<span>${b.label}</span></button>`).join('')+`<button data-canvas-brush="erase" class="tool-button ${s.type==='erase'&&brushActive&&!brushPan?'active':''}" aria-label="橡皮" ${quickLocked()?'disabled':''}>${icon('erase')}</button><button id="brushCanvasUndo" class="tool-button" aria-label="撤销笔触" ${!(state.brushStrokes||[]).length||quickLocked()?'disabled':''}>${icon('undo')}</button><button id="brushPan" class="tool-button ${brushPan?'active':''}" aria-label="移动放大后的照片" aria-pressed="${brushPan}" ${quickLocked()?'disabled':''}>${icon('pan')}</button>`;$$('[data-canvas-brush]',bar).forEach(b=>b.addEventListener('click',()=>selectBrush(b.dataset.canvasBrush)));$('#brushCanvasUndo').addEventListener('click',undoBrush);$('#brushPan').addEventListener('click',()=>{brushPan=!brushPan;brushActive=true;renderBrushCanvas();toast(brushPan?'拖动画面查看细节；选一种画笔即可继续绘制。':'已返回画笔绘制。');});}
  if(edit){$('#compareButton').hidden=false;$('.canvas-toolbar').hidden=false;for(const id of ['selectTool','drawTool','protectTool','undoButton','regionsButton'])$('#'+id).hidden=brushActive;}
  canvas.hidden=!visible;if(!visible){cursor.hidden=true;return;}
  const img=$('#garmentImage'),w=img.naturalWidth||imageReference()?.width||900,h=img.naturalHeight||imageReference()?.height||1100,scale=Math.min(1,1400/Math.max(w,h));
  const width=Math.max(1,Math.round(w*scale)),height=Math.max(1,Math.round(h*scale));if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
  if(window.BattleBrushEngine)BattleBrushEngine.draw(canvas,state.brushStrokes||[],{protectedRects:state.protectedRects,draftStroke:brushStroke});
  canvas.style.pointerEvents=brushActive&&!quickLocked()?'auto':'none';canvas.classList.toggle('eraser-active',brushSettings().type==='erase');
  canvas.style.cursor=brushPan?'grab':'crosshair';
  const overlay=$('#regionOverlay');overlay.style.pointerEvents=!brushActive&&!quickLocked()?'auto':'none';overlay.style.visibility=(!brushActive||state.protectedRects.length)&&showRegions?'visible':'hidden';
  $('#compareButton').hidden=false;$('.canvas-toolbar').hidden=false;
  for(const id of ['selectTool','drawTool','protectTool','undoButton','regionsButton'])$('#'+id).hidden=brushActive;
  $('#canvasTitle').textContent=state.quickParentJobId?'在已采用的效果上绘制':'我的服装 · 绘制方案';
  $('#canvasModeNotice').textContent='画笔草图 · 即时预览';$('#canvasCaption').textContent='笔触决定位置与走向 · 点击精修后由 AI 融合';$('#regionCount').textContent=brushSummary();$('.canvas-ruler').hidden=true;
  const summary=$('#brushSummary');if(summary)summary.textContent=brushSummary();
}
function brushPoint(event){const b=$('#brushCanvas').getBoundingClientRect();return {x:clamp((event.clientX-b.left)/b.width,0,1),y:clamp((event.clientY-b.top)/b.height,0,1)};}
function moveBrushCursor(event){const cursor=$('#brushCursor'),b=$('#brushCanvas').getBoundingClientRect(),s=brushSettings();cursor.hidden=event.pointerType==='touch'||brushPan;cursor.style.left=`${(event.clientX-b.left)/brushZoom}px`;cursor.style.top=`${(event.clientY-b.top)/brushZoom}px`;cursor.style.width=cursor.style.height=`${Math.min(b.width,b.height)*s.size/brushZoom}px`;}
function startBrush(event){
  if(!brushCanEdit()||!brushActive||quickLocked()||compare||event.button!==0||!event.isPrimary||brushStroke)return;
  if(brushPan){brushPanPointer={id:event.pointerId,x:event.clientX,y:event.clientY,offset:{...brushOffset}};$('#brushCanvas').setPointerCapture(event.pointerId);event.preventDefault();return;}
  if((state.brushStrokes||[]).length>=80){toast('这一轮已到80笔。先精修或清空后继续。');return;}
  if((state.brushStrokes||[]).reduce((n,s)=>n+s.shapes.length,0)>16000){toast('这一轮笔触较多，请先精修这一轮，再继续绘制。');return;}
  const c=$('#brushCanvas'),s=brushSettings();brushStroke=BattleBrushEngine.createStroke({id:uid('stroke'),...s,seed:crypto.getRandomValues(new Uint32Array(1))[0]});brushSource=imageReference().url;
  BattleBrushEngine.appendPoint(brushStroke,brushPoint(event),c.width,c.height);c.focus({preventScroll:true});c.setPointerCapture(event.pointerId);moveBrushCursor(event);event.preventDefault();scheduleBrushRender();
}
function moveBrush(event){
  if(brushPanPointer){const stage=$('#canvasStage');brushOffset={x:clamp(brushPanPointer.offset.x+event.clientX-brushPanPointer.x,-stage.clientWidth,stage.clientWidth),y:clamp(brushPanPointer.offset.y+event.clientY-brushPanPointer.y,-stage.clientHeight,stage.clientHeight)};$('#garmentCanvas').style.transform=`translate(${brushOffset.x}px,${brushOffset.y}px) scale(${brushZoom})`;event.preventDefault();return;}
  moveBrushCursor(event);if(!brushStroke)return;
  if(brushStroke.points.length>=1200||brushStroke.shapes.length>=3000||(state.brushStrokes||[]).reduce((n,s)=>n+s.shapes.length,0)+brushStroke.shapes.length>=18000){finishBrush(event);toast('已保存当前笔触。可以继续下一笔。');return;}
  const c=$('#brushCanvas');BattleBrushEngine.appendPoint(brushStroke,brushPoint(event),c.width,c.height);event.preventDefault();scheduleBrushRender();
}
function finishBrush(event){
  if(brushPanPointer){brushPanPointer=null;const c=$('#brushCanvas');if(event&&c.hasPointerCapture(event.pointerId))c.releasePointerCapture(event.pointerId);return;}
  if(!brushStroke)return;const stroke=brushStroke;brushStroke=null;
  if(imageReference()?.url===brushSource&&stroke.shapes.length){try{validateBrushDraft([stroke]);rememberBrush();state.brushStrokes=[...(state.brushStrokes||[]),stroke];brushHandoff=null;quickMessage='';dirty();render();}catch(error){toast(error.message);renderBrushCanvas();}}
  const c=$('#brushCanvas');if(event&&c.hasPointerCapture(event.pointerId))c.releasePointerCapture(event.pointerId);$('#brushCursor').hidden=true;
}
function cancelBrush(){brushStroke=null;brushPanPointer=null;$('#brushCursor')?.setAttribute('hidden','');scheduleBrushRender();}
function selectBrush(type){if(quickLocked())return;brushActive=true;brushPan=false;compare=false;$('#compareButton').setAttribute('aria-pressed','false');state.brushSettings={...brushSettings(),type};tool='select';selected=null;dirty({invalidate:false});render();}
function undoBrush(){if(quickLocked()||brushStroke||!(state.brushStrokes||[]).length)return;brushRedoFrames.push([...(state.brushStrokes||[])]);state.brushStrokes=brushUndoFrames.length?brushUndoFrames.pop():state.brushStrokes.slice(0,-1);brushHandoff=null;dirty();render();}
function redoBrush(){if(quickLocked()||brushStroke||!brushRedoFrames.length)return;brushUndoFrames.push([...(state.brushStrokes||[])]);state.brushStrokes=brushRedoFrames.pop();brushHandoff=null;dirty();render();}
function bindBrushWorkbench(){
  $$('[data-brush-type]').forEach(b=>b.addEventListener('click',()=>selectBrush(b.dataset.brushType)));
  $('#brushErase')?.addEventListener('click',()=>selectBrush('erase'));$('#brushUndo')?.addEventListener('click',undoBrush);$('#brushRedo')?.addEventListener('click',redoBrush);
  for(const [id,key,out] of [['brushSize','size','brushSizeValue'],['brushOpacity','opacity','brushOpacityValue']])$('#'+id)?.addEventListener('input',e=>{state.brushSettings={...brushSettings(),[key]:Number(e.target.value)/100};$('#'+out).textContent=`${Number(e.target.value)}%`;dirty({invalidate:false});});
  $('#brushClear')?.addEventListener('click',()=>{if(quickLocked())return;rememberBrush();state.brushStrokes=[];brushHandoff=null;dirty();render();});
  $('#brushProtect')?.addEventListener('click',()=>{if(quickLocked())return;brushActive=false;setTool('protect');dirty({invalidate:false});render();if(!state.protectedRects.length)addRegion(true,{x:.35,y:.1,w:.3,h:.12});setTool('protect');renderBrushCanvas();toast('已添加可移动的保护框。可修改下方位置数值，或再拖出保护区域。');});
  $('#brushAdvanced')?.addEventListener('click',()=>{state.brushMode=false;dirty({invalidate:false});render();});
  $('#brushNote')?.addEventListener('input',e=>{state.customDamageIdea=e.target.value;state.customDamageEnabled=true;dirty();});
  $('#brushRefine')?.addEventListener('click',refineBrush);$('#brushImportResult')?.addEventListener('click',()=>{if(!quickLocked())brushImport.click();});$('#brushSaveSketch')?.addEventListener('click',saveBrushSketch);
}
async function saveBrushSketch(){
  try{const image=new Image();image.src=imageReference().url;await image.decode();const c=BattleBrushEngine.renderGuide(image,state.brushStrokes||[],state.protectedRects);c.toBlob(blob=>{if(blob)downloadBlob(blob,`${state.title}-绘制草图-非AI结果.png`);},'image/png');}catch(error){toast(`绘制预览未导出：${error.message}`);}
}
async function refineBrush(){
  if(quickLocked())return;quickBusy=true;quickMessage='';render();
  try{
    await saveProject(false);if(hasPendingEdits())throw new Error('笔触刚刚有新修改，请保存后再精修。');
    const context={signature:contentSignature(),revision:state.revision,projectId:state.projectId};
    if(state.mode==='manual_chatgpt'){
      const response=await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/brush-handoff?projectRevision=${state.revision}`);if(!response.ok){const err=await response.json();throw new Error(err.detail||'画笔精修包未完成。');}
      if(context.signature!==contentSignature())throw new Error('绘制已经改变，请重新导出当前笔触。');
      brushHandoff=context;state.brushHandoffContext=context;persistDraft();downloadBlob(await response.blob(),`${state.title}-画笔精修-ChatGPT生成包.zip`);toast('已包含原图、绘制引导和精确蒙版。在 ChatGPT 中生成后导回。');
    }else{
      const job=await api(`/api/projects/${encodeURIComponent(state.projectId)}/brush-jobs`,{method:'POST',body:JSON.stringify({projectRevision:state.revision})});
      if(context.signature!==contentSignature()||context.projectId!==state.projectId)throw new Error('绘制已经改变，此次任务会保留旧版本记录。');state.job=job;state.previewUrl=null;pollJob(job.id||job.jobId,context);
    }
  }catch(error){quickMessage=error.message;toast(error.message);}finally{quickBusy=false;render();}
}
brushImport.addEventListener('change',async()=>{
  const file=brushImport.files[0];brushImport.value='';if(!file||quickLocked())return;if(file.size>20*1024*1024){toast('图片超过20MB，请缩小后导入。');return;}
  const handoff=brushHandoff||state.brushHandoffContext;if(handoff&&(handoff.signature!==contentSignature()||handoff.projectId!==state.projectId||Number(handoff.revision)!==Number(state.revision))){toast('笔触已改变，请按当前绘制重新导出精修包。');return;}
  quickBusy=true;quickMessage='';render();
  try{await saveProject(false);const context={signature:contentSignature(),revision:state.revision,projectId:state.projectId};const form=new FormData();form.append('file',file);form.append('projectRevision',String(state.revision));const job=await api(`/api/projects/${encodeURIComponent(state.projectId)}/import-brush-result`,{method:'POST',body:form});if(context.signature!==contentSignature())throw new Error('绘制已经改变，导回结果保留在上一版本。');state.job=job;state.previewUrl=job.outputUrl||job.previewUrl;state.pendingEdits=false;dirty({invalidate:false});toast('精修图已导回。笔触以外的像素和保护区域保留原图。');}catch(error){quickMessage=error.message;toast(error.message);}finally{quickBusy=false;render();}
});
document.addEventListener('DOMContentLoaded',ensureBrushCanvas,{once:true});
