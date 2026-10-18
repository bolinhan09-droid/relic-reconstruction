/* Directional impacts and absorbed wipes; geometry remains editable and undoable. */
'use strict';
const bloodOldSettings=brushSettings,bloodOldSelect=selectBrush,bloodOldWorkbench=renderBrushWorkbench;
const bloodOldBind=bindBrushWorkbench,bloodOldStart=startBrush,bloodOldMove=moveBrush,bloodOldFinish=finishBrush;
const bloodOldCancel=cancelBrush,bloodOldCanvas=renderBrushCanvas,bloodOldValidate=validateBrushDraft;
let bloodDrag=null,bloodPointer=null;
const DETAIL_EFFECTS={
  blood:[['splatter','定点飞溅'],['soak','浸染晕开'],['drip','沿线流淌'],['contact','接触擦抹']],
  slash:[['slit','细窄刀口'],['frayed','撕裂毛边'],['hole','不规则破洞']],
  wear:[['scuff','磨损纤维'],['fade','磨白褪色'],['mud_splatter','泥点飞溅'],['mud_smear','泥污擦抹'],['dust','细尘积灰'],['water_stain','水渍干痕']],
  burn:[['char','焦黑烧灼'],['smoke','烟熏渐层'],['scorched_edge','沿边焦化']]
};
const DETAIL_TIPS={splatter:'按住起点，拖出飞溅方向，松开生成一组血滴。',soak:'沿布面连续涂抹，预览连片浸染与柔和边缘。',drip:'沿想要的流向画线，预览细长流痕与末端积滴。',contact:'顺着接触方向拖动，预览断续擦痕和浓淡变化。',slit:'沿刀口走向画线，预览窄裂口。',frayed:'沿破损方向画线，预览外翻边缘和纤维毛边。',hole:'点按形成破洞，轻拖可连接破损范围。',scuff:'轻扫容易磨损的位置，预览纤维擦痕。',fade:'在需要的位置轻扫或圈区，预览局部磨白。',mud_splatter:'点按或轻扫，安排大小不一的泥点。',mud_smear:'沿擦碰方向拖动，预览条带状泥污。',dust:'轻扫或圈出区域，预览低浓度细尘。',water_stain:'轻扫或圈区，预览不规则水渍和干燥边线。',char:'沿边描线或圈区，预览焦黑与棕色过渡。',smoke:'轻扫或圈区，预览柔和烟熏，不生成破洞。',scorched_edge:'沿衣服边缘描线，预览单侧焦化与浅色毛边。'};
function detailUi(type){
  if(!DETAIL_EFFECTS[type])return null;
  state.effectSettings=state.effectSettings||{};
  const old=state.effectSettings[type]||{},fallback=type==='blood'?(bloodUi().behavior||'splatter'):DETAIL_EFFECTS[type][0][0];
  const subtype=DETAIL_EFFECTS[type].some(([key])=>key===old.subtype)?old.subtype:fallback;
  const p=old.parameters||{};
  const parameters=Object.fromEntries(['detail','age','wetness'].map(k=>[k,clamp(Number.isFinite(Number(p[k]))?Number(p[k]):k==='detail'?.55:0,0,1)]));
  state.effectSettings[type]={subtype,parameters};return state.effectSettings[type];
}
function effectControls(s){
  if(!DETAIL_EFFECTS[s.type])return '';
  const v=detailUi(s.type),busy=quickLocked(),surface=v.parameters.age>.5?'aged':v.parameters.wetness>.5?'wet':'dry';
  return `<div class="effect-subtypes"><label for="effectSubtype">痕迹类型</label><select id="effectSubtype" ${busy?'disabled':''}>${DETAIL_EFFECTS[s.type].map(([key,name])=>`<option value="${key}" ${v.subtype===key?'selected':''}>${name}</option>`).join('')}</select>${s.type==='blood'?`<label for="effectSurface">表面状态</label><select id="effectSurface" ${busy?'disabled':''}><option value="dry" ${surface==='dry'?'selected':''}>干燥哑光</option><option value="wet" ${surface==='wet'?'selected':''}>湿润微光</option><option value="aged" ${surface==='aged'?'selected':''}>陈旧暗沉</option></select>`:''}<details class="effect-detail-options"><summary>纹理细节</summary>${bloodSlider('effectDetail','细碎程度',v.parameters.detail)}</details></div>`;
}
function detailLabel(stroke){return DETAIL_EFFECTS[stroke.type]?.find(([key])=>key===stroke.effectSubtype)?.[1]||null;}
function loadDetailControls(stroke){
  if(!stroke||!DETAIL_EFFECTS[stroke.type])return;
  state.effectSettings=state.effectSettings||{};
  state.effectSettings[stroke.type]={subtype:DETAIL_EFFECTS[stroke.type].some(([k])=>k===stroke.effectSubtype)?stroke.effectSubtype:stroke.type==='blood'?(stroke.bloodBehavior||'splatter'):DETAIL_EFFECTS[stroke.type][0][0],parameters:{detail:.55,age:0,wetness:0,...stroke.effectParameters}};
}
function bloodUi(){
  const defaults={behavior:'splatter',force:.55,spread:.32,amount:.55,flow:.78,edgeSoftness:.65,direction:-.65};
  state.bloodSettings={...defaults,...state.bloodSettings};
  const value=state.bloodSettings;
  if(!['splatter','soak'].includes(value.behavior))value.behavior='splatter';
  for(const key of ['force','spread','amount','flow','edgeSoftness'])value[key]=clamp(Number(value[key])||defaults[key],.01,1);
  value.direction=Number.isFinite(value.direction)?value.direction:defaults.direction;
  return value;
}
brushSettings=function(){
  const prior=bloodOldSettings(),v=detailUi(prior.type);if(!v)return prior;
  const detailed={...prior,effectSubtype:v.subtype,effectParameters:{...v.parameters}};
  if(prior.type!=='blood')return detailed;
  const behavior=v.subtype==='splatter'?'splatter':'soak';
  return {...detailed,mode:'free',...bloodUi(),behavior,bloodBehavior:behavior};
};
selectBrush=function(type){
  if(bloodDrag||brushStroke){toast('先松开画笔，再切换工具。');return;}
  bloodOldSelect(type);if(type==='blood'){state.brushSettings={...bloodOldSettings(),type,mode:'free'};render();}
};
validateBrushDraft=function(strokes){
  const result=bloodOldValidate(strokes);let vertices=0;
  for(const stroke of strokes){
    for(const shape of stroke.shapes)vertices+=(shape.points||[]).length;
    if(stroke.bloodVersion!==undefined){
      if(stroke.type!=='blood'||stroke.bloodVersion!==2||!['splatter','soak'].includes(stroke.bloodBehavior))throw Error('血迹笔触版本无法读取。');
      const p=stroke.bloodParameters;
      if(!p||typeof p!=='object')throw Error('血迹参数不完整。');
      const keys=stroke.bloodBehavior==='splatter'?['force','spread','amount']:['flow','edgeSoftness'];
      if(keys.some(k=>!Number.isFinite(p[k])||p[k]<0||p[k]>1))throw Error('血迹参数超出范围。');
      if(stroke.bloodBehavior==='soak'&&(!Array.isArray(p.pressures)||p.pressures.length!==stroke.points.length||p.pressures.some(v=>!Number.isFinite(v)||v<0||v>1)))throw Error('浸染笔触压力记录不完整。');
    }
    if(stroke.effectSubtype!==undefined){
      if(!DETAIL_EFFECTS[stroke.type]?.some(([key])=>key===stroke.effectSubtype))throw Error('这种画笔不支持所选痕迹类型。');
      const p=stroke.effectParameters;if(!p||Object.keys(p).some(k=>!['detail','age','wetness'].includes(k))||Object.values(p).some(v=>!Number.isFinite(v)||v<0||v>1))throw Error('痕迹细节参数无法读取。');
    }
  }
  if(vertices>200000)throw Error('本轮纹理细节较多，请先精修或减少笔触。');
  return result;
};
function bloodSlider(id,label,value){return `<label for="${id}"><span>${label}</span><output id="${id}Value">${Math.round(value*100)}%</output></label><input id="${id}" type="range" min="1" max="100" value="${Math.round(value*100)}" ${quickLocked()?'disabled':''}>`;}
renderBrushWorkbench=function(){
  let html=bloodOldWorkbench();const s=brushSettings();if(currentVisualValid())return html;
  if(s.type!=='blood'){
    if(DETAIL_EFFECTS[s.type]){
      html=html.replace('<div class="co-mode-choice"',effectControls(s)+'<div class="co-mode-choice"');
      html=html.replace(/<p class="brush-tip" id="brushTip">[\s\S]*?<\/p>/,`<p class="brush-tip" id="brushTip">${DETAIL_TIPS[s.effectSubtype]}</p>`);
      if(state.brushStrokes.some(p=>p.id===coSelectedStroke&&p.type===s.type))html=html.replace('<div class="brush-actions">','<button id="effectApplyParameters" class="button outline-button full-width">更新所选痕迹类型与细节</button><div class="brush-actions">');
    }
    return html;
  }
  const settings=bloodUi(),busy=quickLocked(),selectedStroke=state.brushStrokes.find(p=>p.id===coSelectedStroke&&p.type==='blood');
  const behavior=s.bloodBehavior,tip=DETAIL_TIPS[s.effectSubtype];
  const modes=effectControls(s);
  html=html.replace(/<div class="co-mode-choice"[^>]*>[\s\S]*?<\/div>/,modes);
  html=html.replace(/<p class="brush-tip" id="brushTip">[\s\S]*?<\/p>/,`<p class="brush-tip" id="brushTip">${tip}</p><div class="blood-parameters">${behavior==='splatter'?bloodSlider('bloodForce','飞溅力度',settings.force)+bloodSlider('bloodAmount','血量',settings.amount):bloodSlider('bloodFlow',s.effectSubtype==='drip'?'流痕浓度':'浸染量',settings.flow)}<details><summary>更多笔触设置</summary>${behavior==='splatter'?bloodSlider('bloodSpread','散布宽度',settings.spread)+`<label for="bloodDirection"><span>点按时的方向</span><output id="bloodDirectionValue">${Math.round(settings.direction*180/Math.PI)}°</output></label><input id="bloodDirection" type="range" min="-180" max="180" value="${Math.round(settings.direction*180/Math.PI)}">`:bloodSlider('bloodSoftness','晕染边缘',settings.edgeSoftness)}</details>${selectedStroke?`<button id="bloodApplyParameters" class="button outline-button full-width" ${busy?'disabled':''}>${selectedStroke.bloodVersion===2?'更新所选血迹':'用新笔刷重做所选血迹'}</button><small class="field-hint">只更新所选痕迹，可撤销。</small>`:''}</div>`);
  html=html.replace('<span>笔触宽度</span>',`<span>${behavior==='splatter'?'主滴尺度':s.effectSubtype==='drip'?'流痕宽度':'涂抹宽度'}</span>`);
  if(state.brushStrokes.some(stroke=>stroke.type==='blood'))html=html.replace('<div class="co-refine-block">',`<button id="bloodClearAll" class="button text-button full-width" ${busy?'disabled':''}>清除这轮血迹，保留其他痕迹</button><div class="co-refine-block">`);
  return html;
};
function loadBloodControls(stroke){
  loadDetailControls(stroke);
  if(stroke)state.brushSettings={...state.brushSettings,size:stroke.size,opacity:stroke.opacity,color:stroke.color||CO_COLORS[stroke.type]};
  if(stroke?.bloodVersion===2&&stroke.type==='blood'){
    state.bloodSettings={...bloodUi(),behavior:stroke.bloodBehavior,...stroke.bloodParameters,
      direction:stroke.direction??bloodUi().direction};
    delete state.bloodSettings.origin;delete state.bloodSettings.target;delete state.bloodSettings.pressures;
  }
}
bindBrushWorkbench=function(){
  bloodOldBind();
  $('#effectSubtype')?.addEventListener('change',event=>{
    if(quickLocked()||brushStroke||bloodDrag||coRegionDraft){render();toast('先结束当前绘制，再切换痕迹类型。');return;}
    const s=brushSettings(),v=detailUi(s.type);if(!DETAIL_EFFECTS[s.type]?.some(([key])=>key===event.target.value))return;
    v.subtype=event.target.value;if(s.type==='blood')state.bloodSettings={...bloodUi(),behavior:v.subtype==='splatter'?'splatter':'soak'};
    dirty({invalidate:false});if(coPendingArea)coRefreshPending();render();
  });
  $('#effectSurface')?.addEventListener('change',event=>{
    const v=detailUi('blood');v.parameters.age=event.target.value==='aged'?1:0;v.parameters.wetness=event.target.value==='wet'?1:0;dirty({invalidate:false});
  });
  $('#effectDetail')?.addEventListener('input',event=>{const v=detailUi(brushSettings().type);v.parameters.detail=Number(event.target.value)/100;$('#effectDetailValue').textContent=event.target.value+'%';dirty({invalidate:false});if(coPendingArea)coRefreshPending();});
  $('#effectApplyParameters')?.addEventListener('click',()=>{
    if(quickLocked()||brushStroke||coPendingArea||bloodDrag)return;
    const old=state.brushStrokes.find(p=>p.id===coSelectedStroke),s=brushSettings();if(!old||old.type!==s.type)return;
    try{const c=$('#brushCanvas');let next;
      if(old.mode==='area'&&old.region?.points)next=BattleBrushEngine.createAreaStroke({...old,...s,id:old.id,seed:old.seed,points:old.region.points},c.width,c.height);
      else {next=BattleBrushEngine.createStroke({...old,...s,id:old.id,seed:old.seed});for(const p of old.points)BattleBrushEngine.appendPoint(next,p,c.width,c.height);}
      const strokes=state.brushStrokes.map(p=>p.id===old.id?next:p);validateBrushDraft(strokes);rememberBrush();state.brushStrokes=strokes;brushHandoff=null;dirty();render();toast('所选痕迹已更新，可以撤销。');
    }catch(error){toast(error.message);}
  });
  $('#bloodClearAll')?.addEventListener('click',()=>{
    if(quickLocked()||brushStroke||bloodDrag)return;
    rememberBrush();state.brushStrokes=state.brushStrokes.filter(stroke=>stroke.type!=='blood');coSelectedStroke=null;brushHandoff=null;dirty();render();toast('已撤掉本轮血迹，其他痕迹保留；可以撤销。');
  });
  for(const button of $$('[data-blood-behavior]'))button.onclick=()=>{
    if(quickLocked()||brushStroke||bloodDrag||coPendingArea){toast('先结束当前操作，再切换血迹方式。');return;}
    state.bloodSettings={...bloodUi(),behavior:button.dataset.bloodBehavior};dirty({invalidate:false});render();
  };
  for(const [id,key] of [['bloodForce','force'],['bloodAmount','amount'],['bloodSpread','spread'],['bloodFlow','flow'],['bloodSoftness','edgeSoftness']])$('#'+id)?.addEventListener('input',event=>{
    state.bloodSettings={...bloodUi(),[key]:Number(event.target.value)/100};$('#'+id+'Value').textContent=event.target.value+'%';dirty({invalidate:false});
  });
  $('#bloodDirection')?.addEventListener('input',event=>{state.bloodSettings={...bloodUi(),direction:Number(event.target.value)*Math.PI/180};$('#bloodDirectionValue').textContent=event.target.value+'°';dirty({invalidate:false});});
  for(const button of $$('[data-select-stroke]')){
    const stroke=state.brushStrokes.find(s=>s.id===button.dataset.selectStroke);
    if(detailLabel(stroke||{}))button.querySelector('small').textContent=detailLabel(stroke)+(stroke.type==='blood'?' · 布面融合':'');
    else if(stroke?.bloodVersion===2)button.querySelector('small').textContent=stroke.bloodBehavior==='soak'?'浸染涂抹 · 布面融合':'定点飞溅 · 布面融合';
    button.addEventListener('click',()=>{loadBloodControls(state.brushStrokes.find(s=>s.id===coSelectedStroke));render();});
  }
  $('#bloodApplyParameters')?.addEventListener('click',()=>{
    if(quickLocked()||brushStroke||bloodDrag)return;
    const old=state.brushStrokes.find(s=>s.id===coSelectedStroke);if(!old||old.type!=='blood')return;
    try{
      const c=$('#brushCanvas'),s=brushSettings(),settings={...bloodUi(),...s,behavior:s.bloodBehavior};let next;
      if(old.bloodVersion===2&&old.bloodBehavior==='splatter'&&settings.behavior==='splatter')next=RelicBloodEngine.regenerateSplatter(old,settings,c.width,c.height);
      else if(old.bloodVersion===2&&old.bloodBehavior==='soak'&&settings.behavior==='soak')next=RelicBloodEngine.regenerateSoak(old,settings,c.width,c.height);
      else if(settings.behavior==='splatter'){
        const origin=old.points[0]||{x:.5,y:.5},target=old.points.at(-1)||origin;
        next=RelicBloodEngine.createSplatter({...s,...settings,id:old.id,seed:old.seed,origin,target},c.width,c.height);
      }else{
        next=RelicBloodEngine.createSoakStroke({...s,...settings,id:old.id,seed:old.seed});
        for(const p of old.points)RelicBloodEngine.appendSoakPoint(next,p,c.width,c.height,1);
      }
      const strokes=state.brushStrokes.map(p=>p.id===old.id?next:p);validateBrushDraft(strokes);rememberBrush();state.brushStrokes=strokes;brushHandoff=null;dirty();render();toast('所选血迹已更新，可撤销恢复。');
    }catch(error){toast(error.message);}
  });
};
function bloodPressure(event){return event.pointerType==='pen'?clamp(Number(event.pressure)||.1,.05,1):1;}
function bloodTarget(origin,s,w,h){const step=.08;return {x:clamp(origin.x+Math.cos(s.direction)*step*Math.min(w,h)/w,0,1),y:clamp(origin.y+Math.sin(s.direction)*step*Math.min(w,h)/h,0,1)};}
function newImpact(target){
  const c=$('#brushCanvas'),s=brushSettings(),origin=bloodDrag.origin;
  const pull=Math.hypot((target.x-origin.x)*c.width,(target.y-origin.y)*c.height)/Math.min(c.width,c.height);
  const force=pull>.008?clamp(pull/.3, .04,1):s.force;
  const end=pull>.008?target:bloodTarget(origin,s,c.width,c.height);
  const stroke=RelicBloodEngine.createSplatter({...s,id:bloodDrag.id,seed:bloodDrag.seed,origin,target:end,force},c.width,c.height);
  stroke._bloodDraft=true;return stroke;
}
startBrush=function(event){
  const s=brushSettings();if(s.type!=='blood'||brushPan||!brushActive)return bloodOldStart(event);
  if(!brushCanEdit()||quickLocked()||compare||event.button!==0||!event.isPrimary||brushStroke||coPendingArea)return;
  if(state.brushStrokes.length>=80){toast('本轮已到80笔，请先精修。');return;}
  bloodPointer=event.pointerId;const c=$('#brushCanvas'),point=brushPoint(event);brushSource=imageReference().url;
  if(s.bloodBehavior==='splatter'){
    bloodDrag={origin:point,target:point,id:uid('impact'),seed:crypto.getRandomValues(new Uint32Array(1))[0]};brushStroke=newImpact(point);
  }else{
    brushStroke=RelicBloodEngine.createSoakStroke({...s,id:uid('soak')});brushStroke._bloodDraft=true;
    RelicBloodEngine.appendSoakPoint(brushStroke,point,c.width,c.height,bloodPressure(event));
  }
  c.focus({preventScroll:true});c.setPointerCapture(event.pointerId);moveBrushCursor(event);event.preventDefault();scheduleBrushRender();
};
moveBrush=function(event){
  if(!brushStroke?.bloodVersion&&!bloodDrag)return bloodOldMove(event);
  if(event.pointerId!==bloodPointer)return;
  const c=$('#brushCanvas'),point=brushPoint(event);moveBrushCursor(event);
  if(bloodDrag){bloodDrag.target=point;brushStroke=newImpact(point);}
  else RelicBloodEngine.appendSoakPoint(brushStroke,point,c.width,c.height,bloodPressure(event));
  event.preventDefault();scheduleBrushRender();
};
finishBrush=function(event){
  if(!brushStroke?.bloodVersion&&!bloodDrag)return bloodOldFinish(event);
  if(event&&event.pointerId!==bloodPointer)return;
  const c=$('#brushCanvas'),stroke=brushStroke;brushStroke=null;bloodDrag=null;bloodPointer=null;
  if(event&&c.hasPointerCapture(event.pointerId))c.releasePointerCapture(event.pointerId);
  if(stroke){delete stroke._bloodDraft;
    if(stroke.bloodBehavior==='splatter'){state.bloodSettings={...bloodUi(),force:stroke.bloodParameters.force,direction:stroke.direction};}
    try{
      const strokes=[...state.brushStrokes,stroke];validateBrushDraft(strokes);
      if(stroke.shapes.length&&brushSource===imageReference()?.url){rememberBrush();state.brushStrokes=strokes;coSelectedStroke=stroke.id;brushHandoff=null;quickMessage='';dirty();}
    }catch(error){toast(error.message);}
  }
  $('#brushCursor').hidden=true;render();
};
cancelBrush=function(){bloodDrag=null;bloodPointer=null;bloodOldCancel();};
renderBrushCanvas=function(){
  bloodOldCanvas();const s=brushSettings(),tip=$('#brushTip');if(tip&&brushActive&&DETAIL_TIPS[s.effectSubtype]&&!coPendingArea)tip.textContent=DETAIL_TIPS[s.effectSubtype];
  if(!bloodDrag||!brushStroke)return;
  const c=$('#brushCanvas');if(!c||c.hidden)return;
  const a=bloodDrag.origin,b=brushStroke.bloodParameters.target,ctx=c.getContext('2d'),x=a.x*c.width,y=a.y*c.height,tx=b.x*c.width,ty=b.y*c.height;
  ctx.save();ctx.globalAlpha=1;ctx.strokeStyle='#e4efde';ctx.fillStyle='#e4efde';ctx.lineWidth=2;ctx.setLineDash([6,5]);ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(tx,ty);ctx.stroke();ctx.setLineDash([]);
  const angle=Math.atan2(ty-y,tx-x);ctx.beginPath();ctx.moveTo(tx,ty);ctx.lineTo(tx-11*Math.cos(angle-.55),ty-11*Math.sin(angle-.55));ctx.lineTo(tx-11*Math.cos(angle+.55),ty-11*Math.sin(angle+.55));ctx.fill();ctx.beginPath();ctx.arc(x,y,5,0,Math.PI*2);ctx.stroke();
  const label='力度 '+Math.round(brushStroke.bloodParameters.force*100)+'%';ctx.font='14px sans-serif';ctx.fillStyle='#08242b';ctx.fillRect(x+9,y-25,88,24);ctx.fillStyle='#e4efde';ctx.fillText(label,x+15,y-8);ctx.restore();
};
