/* 遗迹重构：局部方案、云端图像编辑与订阅生成文件交接。 */
'use strict';
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const icon = name => `<svg aria-hidden="true"><use href="#icon-${name}"/></svg>`;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl = value => { try { const url = new URL(value, location.origin); return ['http:','https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const deepCopy = value => JSON.parse(JSON.stringify(value));
const uid = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
const DAMAGE = {slash:{label:'刀痕',icon:'slash',color:'#45583f',prefix:'D'},blood:{label:'血迹',icon:'drop',color:'#88443f',prefix:'B'},burn:{label:'焦痕',icon:'burn',color:'#816144',prefix:'C'}};
const STEPS = [
  {title:'建立服装底图',short:'服装底图',subtitle:'保留原貌',description:'上传穿着服装的正面照片，或平铺服装照。选择角色，保留结构和辨识细节。'},
  {title:'剧情与二维参考',short:'故事参考',subtitle:'沿着故事',description:'核对剧情依据，选择痕迹方向。也可先编辑一张二维角色参考，再用于服装预览。'},
  {title:'规划痕迹与保护区域',short:'痕迹规划',subtitle:'确定区域',description:'根据情境推导战损方向。区域与力度都可以调整，关键细节可设为保护区域。'},
  {title:'生成服装预览',short:'效果预览',subtitle:'比较外观',description:'在 ChatGPT 中生成后导回，或调用 GPT / 千问接口。仅修改选区，保留其余服装与人物。'},
  {title:'核查与制作导出',short:'制作导出',subtitle:'核查方案',description:'检查保护区域与视觉连贯性，再带着位置编号和制作清单进行试样。'}
];
let catalog = {characters:[],merchants:[],garments:[]};
let scenarios = [];
let storyMeta = {};
let models = {models:[],environment:{}};
let state = {
  title:'我的战损方案',step:0,garmentId:'',characterId:'',scenarioId:'',merchantId:'',
  reference:null,conceptReference:null,conceptJob:null,uploadMerchant:'',uploadMaterial:'',reversibleRequired:'unknown',customDamageIdea:'',customDamageEnabled:false,damageItems:[],protectedRects:[],
  modelSelections:{slash:'',blood:'',burn:''},mode:'manual_chatgpt',qualityChecklist:{},
  planNotes:[],projectId:null,revision:null,previewUrl:null,job:null,pendingEdits:true,
  quickMode:true,quickStage:'first',quickOriginalReference:null,quickParentJobId:null,
  brushStrokes:[],brushMode:true,brushSettings:{type:'blood',size:.075,opacity:.88}
};
let tool = 'select', selected = null, currentDamage = 'slash', history = [], showRegions = true, compare = false, pointer = null, online = false, saveTimer = null, toastTimer = null, jobPoll = null;
const STORAGE_KEY = 'relic-reconstruction-draft-v1';
let draftReady=false;

async function api(path, options = {}) {
  const response = await fetch(path, {headers: options.body instanceof FormData ? {} : {'Content-Type':'application/json'},...options});
  if (!response.ok) { let detail; try { const data = await response.json(); detail = data.detail || data.message; } catch { detail = await response.text(); } const error=new Error(typeof detail === 'string' ? detail : `请求未完成（${response.status}）`);error.status=response.status;throw error; }
  return response.headers.get('content-type')?.includes('application/json') ? response.json() : response;
}
function toast(message) { $('#notification').textContent = message; $('#notification').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#notification').classList.remove('visible'), 5000); }
function persistDraft(){
  if(!draftReady)return;
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify({...state,job:null}));$('#saveStatus').textContent='本机草稿已保存';}catch{$('#saveStatus').textContent='草稿空间不足，请导出保存';}
}
function dirty({invalidate=true} = {}) {
  if(invalidate){state.pendingEdits=true;state.qualityChecklist={};state.previewUrl=null;state.job=null;clearTimeout(jobPoll);renderCanvas();}
  $('#saveStatus').textContent = '草稿已更新';
  clearTimeout(saveTimer); saveTimer = setTimeout(persistDraft,250);
}
function checkpoint() { history.push(deepCopy({damageItems:state.damageItems,protectedRects:state.protectedRects})); if(history.length > 30) history.shift(); $('#undoButton').disabled = !history.length; }
function garment() { return catalog.garments.find(g => g.id === state.garmentId); }
function scenario() { return scenarios.find(s => s.id === state.scenarioId); }
function character() { return catalog.characters.find(c => c.id === state.characterId); }
function itemById(id) { return state.damageItems.find(i => i.id === id) || state.protectedRects.find(i => i.id === id); }
function isProtected(id) { return state.protectedRects.some(i => i.id === id); }
function selectedItem() { return itemById(selected); }
function rectOf(item) { return item?.rect || {x:0,y:0,w:0,h:0}; }
function displayCode(item) { const protectedMode=isProtected(item.id),list=protectedMode?state.protectedRects:state.damageItems;return `${protectedMode?'P':''}${String(list.findIndex(i=>i.id===item.id)+1).padStart(2,'0')}`; }
function itemName(item) { return isProtected(item.id) ? '保护区域' : DAMAGE[item.type]?.label || '战损'; }
function imageReference() { return state.reference || (garment() ? {id:garment().id,url:garment().imageUrl,width:garment().width || 900,height:garment().height || 1100} : null); }
function normalizedRect(rect) {
  const x=clamp(rect?.x,0,.99), y=clamp(rect?.y,0,.99);
  return {x,y,w:clamp(rect?.w,.01,1-x),h:clamp(rect?.h,.01,1-y)};
}
function validateItems(items, protectedMode=false) {
  if (!Array.isArray(items) || items.length > (protectedMode?30:20)) throw new Error(protectedMode?'保护区域数据不完整或超过30个。':'战损区域数据不完整或超过20个。');
  return items.map(item => {
    if(!protectedMode && !DAMAGE[item.type]) throw new Error('方案包含无法识别的痕迹类型。');
    return {...item,id:String(item.id || uid(protectedMode?'protect':'damage')),rect:normalizedRect(item.rect || item),...(protectedMode?{}:{intensity:clamp(item.intensity ?? .5,0,1)}),notes:String(item.notes || '').slice(0,1500)};
  });
}
function sourcesOf(s) { return s?.sources || s?.evidence?.sources || (s?.sourceUrl ? [{title:s.sourceTitle || '查看原作依据',url:s.sourceUrl}] : []); }
function scenarioTitle(s) { return s.title || s.name || '剧情情境'; }
function scenarioSummary(s) { return s.summary || s.description || s.background || ''; }
function factOf(s) { return s.verifiedClaims || s.canonFacts || s.facts || s.canon || s.originalEvidence || ''; }
function inferenceOf(s) { return s.damageEvidence || s.damageInference || s.inference || s.damageRationale || s.effectDirection || ''; }
function readable(value) { return Array.isArray(value) ? value.map(v=>typeof v==='object'?(v.text||v.description||JSON.stringify(v)):v).join('；') : typeof value === 'object' ? (value?.text || value?.description || '') : String(value || ''); }

function render() {
  $('#projectTitle').value = state.title;
  if(state.quickMode && typeof renderQuickLayout==='function'){renderQuickLayout();return;}
  document.body.classList.remove('quick-workflow','quick-first','quick-result');
  $('.panel-bottom').hidden=false;
  $('.canvas-toolbar').hidden=false;$('.canvas-ruler').hidden=false;$('#regionOverlay').style.pointerEvents='auto';
  for(const id of ['selectTool','drawTool','protectTool','undoButton','regionsButton','compareButton'])$('#'+id).hidden=false;
  for(const legend of $$('.canvas-legend>span'))legend.hidden=false;
  if(typeof ensureQuickSwitch==='function')ensureQuickSwitch();
  $('#studioTitle').textContent='你的战损方案，从这里开始。';
  $('#stepper').innerHTML = STEPS.map((s,i)=>`<li><button class="step-button" data-step="${i}" ${state.step===i?'aria-current="step"':''}><span class="step-number">${String(i+1).padStart(2,'0')}</span><span class="step-label">${s.short}<span class="step-subtitle">${s.subtitle}</span></span></button></li>`).join('');
  $('#stepEyebrow').textContent = `STEP ${String(state.step+1).padStart(2,'0')}`;
  $('#stepTitle').textContent = STEPS[state.step].title;
  $('#stepDescription').textContent = STEPS[state.step].description;
  $('#previousStep').disabled = state.step===0;
  $('#nextStep').innerHTML = state.step===4 ? `${icon('file')}导出制作方案` : `下一步${icon('right')}`;
  $('#stepContent').innerHTML = [renderGarment,renderStory,renderPlan,renderModels,renderCheck][state.step]();
  if(state.step===1 && typeof renderConcept==='function') $('#stepContent').insertAdjacentHTML('beforeend',renderConcept());
  bindPanel(); if(typeof bindWorkflowExtras==='function') bindWorkflowExtras(); renderCanvas(); renderEditor();
}
function renderGarment() {
  const options = catalog.garments.filter(g => (!state.characterId || !g.characterId || g.characterId===state.characterId) && (!state.merchantId || g.merchantId===state.merchantId));
  return `<button class="upload-box" id="uploadButton">${icon('upload')}<strong>上传我的服装照片</strong><span>PNG / JPG / WebP · 穿着正面照或平铺照</span></button><div class="divider"></div>
    <div class="field"><label for="characterSelect">角色</label><select id="characterSelect"><option value="" ${!state.characterId?'selected':''}>暂不选择角色</option>${catalog.characters.map(c=>`<option value="${escapeHtml(c.id)}" ${c.id===state.characterId?'selected':''}>${escapeHtml(c.name)} · ${escapeHtml(c.game || c.work || '')}</option>`).join('')}</select><small>角色用于查找背景与剧情情境，也可以稍后选择。</small></div>
    <div class="field"><label for="merchantSelect">服装来源</label><select id="merchantSelect"><option value="">全部来源</option>${catalog.merchants.map(m=>`<option value="${escapeHtml(m.id)}" ${m.id===state.merchantId?'selected':''}>${escapeHtml(m.name)}</option>`).join('')}</select></div>
    ${state.reference?.uploaded ? `<div class="notice accent-notice"><strong>正在使用我的服装照片</strong><br>区域会按这张底图记录。<div class="field" style="margin-top:12px;margin-bottom:0"><label for="uploadMerchant">商家或服装来源</label><input id="uploadMerchant" value="${escapeHtml(state.uploadMerchant)}" placeholder="例如：自制 / 实际商家名称"></div></div><div class="divider"></div>` : ''}
    <div class="field"><label for="uploadMaterial">面料与部件</label><input id="uploadMaterial" value="${escapeHtml(state.uploadMaterial)}" placeholder="未知，待确认；例如棉布外套"><small>没有实物时可先保留未知，制作前需确认。</small></div><div class="field"><label for="reversibleRequired">是否必须恢复原状</label><select id="reversibleRequired"><option value="unknown" ${state.reversibleRequired==='unknown'?'selected':''}>尚未确定</option><option value="true" ${state.reversibleRequired===true?'selected':''}>需要 · 优先可拆除工法</option><option value="false" ${state.reversibleRequired===false?'selected':''}>不需要 · 可以考虑永久处理</option></select><small>用于选择贴片、颜料与破口工法。</small></div><div class="divider"></div>
    <div class="section-label">平铺服装目录<span class="muted small">${options.length} 款</span></div>
    ${options.map(g=>`<button class="garment-option ${g.id===state.garmentId&&!state.reference?.uploaded?'selected':''}" data-garment="${escapeHtml(g.id)}"><img src="${escapeHtml(safeUrl(g.imageUrl))}" alt=""><span><strong>${escapeHtml(g.name)}</strong><small>${g.isDemo?'流程示例 · 非商家商品':escapeHtml(catalog.merchants.find(m=>m.id===g.merchantId)?.name || '服装目录')}</small></span>${g.id===state.garmentId&&!state.reference?.uploaded?`<span class="option-check">${icon('check')}</span>`:''}</button>`).join('')}
    <p class="field-hint">${escapeHtml(garment()?.note || '上传实物照后，可补充商家、面料和版型信息。')}</p>`;
}
function renderStory() {
  const filtered = state.characterId?scenarios.filter(s=> !s.characterId || s.characterId===state.characterId):[];
  const ch = character();
  return `<div class="notice accent-notice"><strong>${escapeHtml(ch?.name || '尚未选择角色')}</strong>${ch?.game ? ` · ${escapeHtml(ch.game)}`:''}<br>${escapeHtml(ch?(ch.summary || ch.background || '选择有来源的故事情境，再根据服装推演痕迹分布。'):'可在服装底图步骤补充角色，也可以直接按自己的外观设想继续。')}</div>${ch?`<details class="details"><summary>背景资料与剧情检索入口</summary><p class="field-hint">当前为人工核查后录入的资料卡。可打开资料继续查阅；尚未接入实时联网检索。</p>${(storyMeta.searchLinks || []).map(link=>`<a class="source-link" href="${escapeHtml(safeUrl(link.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.title)}${icon('link')}</a><br>`).join('')}</details>`:''}<div class="divider"></div>
    <div class="section-label">剧情情境<span class="muted small">${filtered.length} 个方向</span></div>
    ${filtered.length?filtered.map(s=>`<article class="scenario-card ${s.id===state.scenarioId?'selected':''}"><label class="scenario-choice"><input type="radio" name="scenario" value="${escapeHtml(s.id)}" ${s.id===state.scenarioId?'checked':''}><span>${escapeHtml(scenarioTitle(s))}</span></label><p class="small muted">${escapeHtml(s.evidenceLabel || '原作依据')}</p><details class="details"><summary>查看情境与依据${s.spoiler_note?'（含剧情内容）':''}</summary><p>${escapeHtml(scenarioSummary(s))}</p>${factOf(s)?`<div class="scenario-fact"><b>有依据的背景</b><span>${escapeHtml(readable(factOf(s)))}</span></div>`:''}${sourcesOf(s).map(source=>`<a class="source-link" href="${escapeHtml(safeUrl(source.url || source.href))}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title || source.name || '查看依据')}${icon('link')}</a>`).join('')}${s.unknowns?.length?`<div class="scenario-fact"><b>未确认的细节</b><span>${escapeHtml(readable(s.unknowns))}</span></div>`:''}</details>${inferenceOf(s)?`<div class="scenario-fact"><b>战损效果推演</b><span>${escapeHtml(readable(inferenceOf(s)))}</span></div>`:''}</article>`).join('') : '<p class="empty-state">当前角色的剧情依据尚未录入。可先上传服装和规划区域；需要录入可靠来源后再建立剧情建议。</p>'}
    <details class="details" ${state.customDamageEnabled||state.customDamageIdea?'open':''}><summary>在此剧情下补充战损设想</summary><label class="choice-row"><input id="customDamageEnabled" type="checkbox" ${state.customDamageEnabled?'checked':''}><span>允许我补充原作未明确描写的局部痕迹</span></label><div class="field"><label for="customDamageIdea">补充细节（可选）</label><textarea id="customDamageIdea" maxlength="1500" placeholder="例如：袖口增加少量擦痕，保留徽章和主要图案。">${escapeHtml(state.customDamageIdea)}</textarea><small>只补充此情境下的痕迹程度与分布，角色造型与背景仍以原作为准。焦痕需开启补充后使用。</small></div></details>`;
}
function regionList() {
  return [...state.damageItems,...state.protectedRects].map(item=>`<button class="region-list-item ${selected===item.id?'selected':''}" data-select-region="${escapeHtml(item.id)}"><span class="region-swatch ${isProtected(item.id)?'protected':item.type}"></span><span class="region-id">${displayCode(item)}</span><span class="region-detail"><strong>${itemName(item)}</strong><small>${isProtected(item.id)?escapeHtml(item.notes || '保留原图细节'):`力度 ${Math.round(item.intensity*100)}% · ${Math.round(rectOf(item).w*100)} × ${Math.round(rectOf(item).h*100)}%`}</small></span>${selected===item.id?icon('check'):''}</button>`).join('');
}
function renderPlan() {
  return `${scenario()?`<div class="notice"><strong>当前情境</strong><br>${escapeHtml(scenarioTitle(scenario()))}</div>`:'<div class="notice">还未选择剧情。可先手动标记服装区域，再回到剧情步骤。</div>'}
    <button id="suggestPlan" class="button outline-button full-width" style="margin-top:14px" ${!scenario()?'disabled':''}>${icon('plus')}根据剧情建立痕迹建议</button><p class="field-hint">建议来自剧情与痕迹规则，具体位置属于效果推演。</p><div class="divider"></div>
    <div class="section-label">添加痕迹</div><label class="choice-row"><input id="customDamageEnabled" type="checkbox" ${state.customDamageEnabled?'checked':''}><span>允许补充此剧情未明确描写的局部痕迹<span>　焦痕与未载明血迹属于个人战损设想。</span></span></label><div class="damage-types">${Object.entries(DAMAGE).map(([type,d])=>`<button class="damage-type ${currentDamage===type?'active':''}" data-damage-type="${type}" aria-pressed="${currentDamage===type}">${icon(d.icon)}${d.label}</button>`).join('')}</div>
    <div class="region-actions"><button id="addDamage" class="button outline-button">${icon('plus')}添加${DAMAGE[currentDamage].label}区域</button><button id="addProtection" class="button outline-button">${icon('lock')}添加保护区域</button></div><p class="field-hint">也可在右侧拖动画框。选中区域后，用数值修改位置与大小。</p>
    <div class="divider"></div><div class="section-label">区域列表<span class="muted small">${state.damageItems.length+state.protectedRects.length} 个</span></div><div class="region-list">${regionList() || '<p class="empty-state">暂无区域。可以先建立剧情建议，再按实际服装调整。</p>'}</div>
    ${state.planNotes.length?`<ul class="planning-notes">${state.planNotes.map(note=>`<li>${escapeHtml(readable(note))}</li>`).join('')}</ul>`:'<p class="field-hint" style="margin-top:16px">优先保护徽章、刺绣、扣件和承重接缝。刀痕、血迹、焦痕可以组合，但应保持同一情境的方向与程度。</p>'}`;
}
function renderLegacyModels() {
  const environment=models.environment || {}, baseAvailable=!!environment.base_model_available && !!environment.comfy_available;
  return `<div class="notice accent-notice"><strong>按区域分步组合</strong><br>刀痕 → 血迹 → 焦痕。每一步使用上一张结果，并保留保护区域。</div><div class="divider"></div>
    <div class="section-label">专用痕迹模型</div>${Object.entries(DAMAGE).map(([type,d])=>{
      const choices=(models.models || []).filter(m=>m.type===type || m.damageType===type || m.damage_type===type);
      const ready=choices.some(m=>m.available);
      return `<div class="model-card"><div class="model-heading"><span>${d.label} LoRA</span><span class="model-status">${ready?'可选择':'未训练'}</span></div><select class="input" data-model-type="${type}" aria-label="${d.label}模型" ${ready?'':'disabled'}><option value="">${ready?'选择模型':'预留专用模型位置'}</option>${choices.map(m=>`<option value="${escapeHtml(m.id)}" ${m.id===state.modelSelections[type]?'selected':''} ${m.available?'':'disabled'}>${escapeHtml(m.name || m.id)}${m.available?'':' · 未训练'}</option>`).join('')}</select><p>${ready?'与统一底模兼容后，按对应区域调用。':'训练完成后在此登记并选择，当前不参与预览。'}</p></div>`;
    }).join('')}
    <div class="divider"></div><div class="section-label">本机实验预览</div><label class="choice-row"><input type="radio" name="previewMode" value="base_experiment" ${state.mode==='base_experiment'?'checked':''}><span><strong>基础模型分区实验</strong><span>${baseAvailable?`${escapeHtml((models.models||[]).find(m=>m.kind==='base'&&m.available)?.name || '本机基础模型')}已连接，可测试区域编辑流程。`:'尚无可调用的本机基础模型。'}效果用于验证流程，不能代替专用痕迹模型。</span></span></label><label class="choice-row"><input type="radio" name="previewMode" value="registered_lora" ${state.mode==='registered_lora'?'checked':''} ${!(models.models||[]).some(m=>m.kind==='lora'&&m.available)?'disabled':''}><span><strong>专用痕迹模型</strong><span>按各区域所选 LoRA 顺序处理。尚未训练的模型暂不可调用。</span></span></label><p class="field-hint">痕迹程度影响模型编辑幅度，不对应实物损伤的测量值。</p>
    <button id="generatePreview" class="button primary-button full-width" ${!state.damageItems.length || !imageReference() || (state.mode==='base_experiment'?!baseAvailable:!hasReadyLoras()) || isJobRunning()?'disabled':''}>${icon('image')}${isJobRunning()?'正在分区处理':'生成分区实验预览'}</button>
    ${!baseAvailable?`<p class="field-hint">${escapeHtml(environment.reason || environment.message || '请先连接本机推理服务并登记兼容底模。当前可保存区域规划与制作清单。')}</p>`:''}
    ${state.job?renderProgress():''}
    <div class="notice" style="margin-top:17px"><strong>整体视觉核查</strong><br>视觉 AI 尚未接入。下一步提供实际像素保护核验与人工检查项。</div>`;
}
function isJobRunning() { return state.job && ['queued','running','pending','processing','submitted'].includes(state.job.status); }
function hasPendingEdits(){return state.pendingEdits || state.savedSignature!==contentSignature();}
function currentResultValid(){return !!state.job && !['concept','draft'].includes(state.job.artifactKind) && ['completed','complete','succeeded','success'].includes(state.job.status) && Number(state.job.projectRevision)===Number(state.revision) && !hasPendingEdits();}
function hasReadyLoras() { return state.damageItems.every(item=>(models.models||[]).some(m=>m.id===state.modelSelections[item.type]&&m.available)); }
function renderProgress() {
  const value=clamp(state.job.progress ?? 0,0,1), completed=['completed','complete','succeeded','success'].includes(state.job.status);
  return `<div class="progress-box" role="status" aria-live="polite"><div class="progress-title"><strong>${completed?'分区处理完成':state.job.status==='failed'?'预览未完成':'分区处理进度'}</strong><span>${Math.round(value*100)}%</span></div><div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(value*100)}"><div class="progress-bar" style="width:${value*100}%"></div></div><p>${escapeHtml(state.job.message || '等待本机推理服务')}</p></div>`;
}
function renderCheck() {
  const rawValidation=state.job?.validation || state.job?.result?.validation;
  const validation=currentResultValid() && typeof rawValidation?.passed==='boolean' ? rawValidation : null;
  const reviewAllowed=!!state.projectId && !hasPendingEdits() && (!state.job || currentResultValid());
  const checks=[['character','角色轮廓、配色和主要标识仍可辨认'],['story','痕迹类型与所选剧情情境相符'],['consistency','各类痕迹的方向、程度与先后关系一致'],['fabric','已确认实际面料并完成小样测试']];
  return `<div class="check-card"><h3>像素保护核验</h3><p>对比原图与实验结果，检查保护区域及区域外像素是否保留。</p>${validation?`<div class="check-result">${escapeHtml(validation.summary || validation.message || (validation.passed?'像素保护核验通过':'像素核验已完成，请查看保护区域。'))}${typeof validation.changedProtectedPixels==='number'?`<br>保护区域变化像素：${validation.changedProtectedPixels}`:''}</div>`:'<p>当前没有完成的模型结果，尚不能执行像素对比。区域规划可继续导出。</p>'}</div>
    <div class="section-label" style="margin-top:20px">人工视觉核查</div><p class="field-hint">整体视觉 AI 尚未接入，以下由你逐项确认。${!reviewAllowed?'请先保存当前区域版本；生成过程中暂不确认结果。':''}</p>${!reviewAllowed?`<button id="saveCurrentVersion" class="button outline-button full-width" style="margin-top:12px">${icon('save')}保存当前版本</button>`:''}${checks.map(([id,label])=>`<label class="choice-row"><input type="checkbox" data-check="${id}" ${state.qualityChecklist[id]?'checked':''} ${reviewAllowed?'':'disabled'}><span>${label}</span></label>`).join('')}${currentResultValid()?`<button id="recordReview" class="button outline-button full-width">${icon('check')}记录本次结果核查</button><p class="field-hint">核查记录绑定当前第 ${state.revision} 版实验结果。</p>`:''}
    <div class="divider"></div><div class="section-label">制作清单<span class="muted small">按位置编号</span></div><ol class="making-list">${state.damageItems.map(item=>`<li><strong>${displayCode(item)} · ${itemName(item)} · 力度 ${Math.round(item.intensity*100)}%</strong><br>左 ${Math.round(item.rect.x*100)}%，上 ${Math.round(item.rect.y*100)}%，宽 ${Math.round(item.rect.w*100)}%，高 ${Math.round(item.rect.h*100)}%。<br>${escapeHtml(recipe(item.type))}${item.notes?`<br>备注：${escapeHtml(item.notes)}`:''}</li>`).join('')+(typeof brushMakingSummary==='function'?brushMakingSummary():'') || '<li>尚未添加痕迹区域，请先完成痕迹规划。</li>'}</ol>${state.protectedRects.length?`<p class="field-hint">保护区域：${state.protectedRects.map(i=>displayCode(i)).join('、')}。制作时遮盖并保留对应原图细节。</p>`:''}
    <div class="notice" style="margin-top:18px">比例位置用于对照底图。实际尺寸、材料用量和最终工法需根据实物服装试样确认。</div>`;
}
function recipe(type) {
  if(state.reversibleRequired!==false)return {slash:'以可拆卸的磨毛布片或破损覆盖片模拟裂口，固定在标记区域；保持原衣完整。',blood:'将血迹色层制作在可拆卸布片上，先用同材质小样试色与遮盖效果，再固定到标记区域。',burn:'以可拆卸棕灰色布片和磨毛边缘模拟焦痕，先试样确认色层与固定方式。'}[type]+(state.reversibleRequired==='unknown'?' 恢复要求尚未确认，当前先提供可拆除方向。':'');
  return {slash:'先在废料上测试开线、磨毛或可拆卸破损贴片，再转移到标记区域；避开承重接缝。',blood:'先在同材质小样上测试布用颜料与稀释比例，分层建立浅晕染和深色集中点。',burn:'先在同材质小样上测试棕灰色颜料与磨毛效果，用色层表现焦痕；服装方案采用模拟工法。'}[type];
}

function bindPanel() {
  $('#uploadButton')?.addEventListener('click',()=>$('#imageUpload').click());
  $('#characterSelect')?.addEventListener('change',event=>{state.characterId=event.target.value;state.scenarioId='';dirty();render();});
  $('#merchantSelect')?.addEventListener('change',event=>{state.merchantId=event.target.value;dirty({invalidate:false});render();});
  $('#uploadMerchant')?.addEventListener('input',event=>{state.uploadMerchant=event.target.value;dirty({invalidate:false});});
  $('#uploadMaterial')?.addEventListener('input',event=>{state.uploadMaterial=event.target.value;dirty({invalidate:false});});
  $('#reversibleRequired')?.addEventListener('change',event=>{state.reversibleRequired=event.target.value==='unknown'?'unknown':event.target.value==='true';dirty({invalidate:false});});
  $$('[data-garment]').forEach(button=>button.addEventListener('click',()=>selectGarment(button.dataset.garment)));
  $$('[name=scenario]').forEach(input=>input.addEventListener('change',()=>{state.scenarioId=input.value;dirty();render();}));
  $('#customDamageIdea')?.addEventListener('input',event=>{state.customDamageIdea=event.target.value;dirty();});
  $('#customDamageEnabled')?.addEventListener('change',event=>{state.customDamageEnabled=event.target.checked;dirty();render();});
  $('#suggestPlan')?.addEventListener('click',suggestPlan);
  $$('[data-damage-type]').forEach(button=>button.addEventListener('click',()=>{currentDamage=button.dataset.damageType;render();setTool('draw');}));
  $('#addDamage')?.addEventListener('click',()=>addRegion(false));
  $('#addProtection')?.addEventListener('click',()=>addRegion(true));
  $$('[data-select-region]').forEach(button=>button.addEventListener('click',()=>{selected=button.dataset.selectRegion;setTool('select');render();}));
  $$('[data-model-type]').forEach(input=>input.addEventListener('change',()=>{state.modelSelections[input.dataset.modelType]=input.value;dirty();}));
  $$('[name=previewMode]').forEach(input=>input.addEventListener('change',()=>{state.mode=input.value;dirty();render();}));
  $('#generatePreview')?.addEventListener('click',generatePreview);
  $('#saveCurrentVersion')?.addEventListener('click',()=>saveProject().then(()=>render()).catch(error=>toast(error.message)));
  $('#recordReview')?.addEventListener('click',recordReview);
  $$('[data-check]').forEach(input=>input.addEventListener('change',()=>{state.qualityChecklist[input.dataset.check]=input.checked;dirty({invalidate:false});}));
}
function selectGarment(id) {
  const chosen=catalog.garments.find(g=>g.id===id); if(!chosen)return;
  state.garmentId=id;state.reference=null;state.characterId=chosen.characterId || state.characterId;state.previewUrl=null;state.job=null;
  if(state.quickMode){state.quickOriginalReference=null;state.quickParentJobId=null;state.quickStage='first';state.scenarioId='';state.customDamageIdea='';state.conceptReference=null;state.uploadMaterial='';state.reversibleRequired='unknown';}
  state.brushStrokes=[];state.brushMode=true;if(typeof resetBrushHistory==='function')resetBrushHistory();state.damageItems=[];state.protectedRects=(chosen.protectedRects || []).map(rect=>({id:uid('protect'),rect:normalizedRect(rect.rect || rect),notes:'保留示例图主要标识'}));selected=null;history=[];dirty();render();toast(chosen.isDemo?'已载入平铺示例。此图仅用于体验流程。':'已载入服装底图。');
}
function setTool(next) {
  tool=next;[['selectTool','select'],['drawTool','draw'],['protectTool','protect']].forEach(([id,value])=>{const active=next===value;$('#'+id).classList.toggle('active',active);$('#'+id).setAttribute('aria-pressed',String(active));});
  $('#regionOverlay').classList.toggle('draw-mode',next!=='select');$('#regionOverlay').classList.toggle('select-mode',next==='select');
}
function addRegion(protectedMode=false, rect={x:.35,y:.4,w:.2,h:.15}) {
  if(!imageReference()){toast('请先选择或上传一张服装底图。');return;}
  const defaults=scenario()?.defaultEffects || [];
  if(!protectedMode && scenario() && !defaults.includes(currentDamage) && !state.customDamageEnabled){toast('此痕迹没有当前剧情的明确依据。请先开启“补充此剧情的局部痕迹”。');return;}
  if(!protectedMode && currentDamage==='burn' && !state.customDamageEnabled){toast('请先开启局部战损补充，再添加焦痕。');return;}
  if((protectedMode?state.protectedRects:state.damageItems).length>=(protectedMode?30:20)){toast(protectedMode?'每个方案最多30个保护区域。':'每个方案最多20个战损区域。');return;}
  checkpoint();const item={id:uid(protectedMode?'protect':'damage'),rect:normalizedRect(rect),...(protectedMode?{notes:'保留此处原图细节'}:{type:currentDamage,intensity:state.quickMode?.65:.5,notes:state.quickMode&&typeof quickEffectNote==='function'?quickEffectNote(currentDamage):''})};
  (protectedMode?state.protectedRects:state.damageItems).push(item);selected=item.id;dirty();render();setTool('select');
}
async function suggestPlan() {
  const button=$('#suggestPlan');button.disabled=true;button.textContent='正在建立剧情建议';
  try {
    const data=await api('/api/plan',{method:'POST',body:JSON.stringify({scenarioId:state.scenarioId,garmentId:state.garmentId,customDamageIdea:state.customDamageIdea,customDamageEnabled:state.customDamageEnabled,protectedRects:state.protectedRects,reversibleRequired:state.reversibleRequired,material:state.uploadMaterial,image:imageReference()})});
    checkpoint();state.damageItems=validateItems(data.damageItems || []);state.protectedRects=validateItems(data.protectedRects || [],true);state.planNotes=data.notes || [];selected=state.damageItems[0]?.id || null;dirty();render();toast('已建立规则建议。请按实物服装调整位置与力度。');
  }catch(error){toast(error.message);render();}
}

function renderCanvas() {
  const image=imageReference(), chosen=garment();
  $('#garmentCanvas').hidden=!image;$('#emptyCanvas').hidden=!!image;
  $('#canvasTitle').textContent=state.reference?.uploaded?'我的服装 · 实拍底图':chosen?.name || '服装底图';
  $('#canvasViewTag').textContent=chosen?.view==='back'?'背面':chosen?.view==='part'?'部件':'正面';
  $('#canvasCaption').textContent=state.reference?.uploaded?`${state.uploadMerchant || '我的实物服装'} · 实际尺寸待确认`:chosen?.isDemo?'流程示例 · 绘制示意图，非商家商品':'服装目录底图';
  $('#regionCount').textContent=`${state.damageItems.length} 个战损区域 · ${state.protectedRects.length} 个保护区域`;
  $('#undoButton').disabled=!history.length;
  const preview=state.previewUrl && !compare && (currentResultValid() || (typeof currentDraftValid==='function'&&currentDraftValid()));
  $('#canvasModeNotice').textContent=preview?(state.job?.artifactKind==='draft'?'首版效果 · 待你确认':['manual_external_import','manual_brush_import'].includes(state.job?.mode)?'导回结果 · 局部合成':['cloud_image_edit','cloud_brush_refine'].includes(state.job?.mode)?'云端生成 · 局部合成':state.job?.mode==='registered_lora'?'专用模型分区结果':'基础模型实验结果'):compare?'原图对照 · 区域暂时隐藏':state.quickMode&&state.quickParentJobId?'已采用的修改底图':'区域标注预览';
  if(image){
    const url=preview?state.previewUrl:compare&&state.quickMode&&state.quickOriginalReference?state.quickOriginalReference.url:image.url;
    if($('#garmentImage').getAttribute('src')!==url)$('#garmentImage').src=url;
    $('#garmentImage').alt=state.reference?.uploaded?'我的服装平铺底图':chosen?.isDemo?'长款外套绘制平铺示意图，非角色官方服装或商家商品':chosen?.name || '服装平铺底图';
    const img=$('#garmentImage');sizeCanvas(img.complete&&img.naturalWidth?img.naturalWidth:image.width,img.complete&&img.naturalHeight?img.naturalHeight:image.height);
  }
  const overlay=$('#regionOverlay');
  overlay.style.visibility=showRegions && !compare?'visible':'hidden';
  overlay.innerHTML=[...state.damageItems,...state.protectedRects].map(item=>{
    const protectedMode=isProtected(item.id),r=rectOf(item),color=protectedMode?'#686e65':DAMAGE[item.type]?.color || '#45583f';
    return `<g data-region-id="${escapeHtml(item.id)}"><rect class="region-box ${selected===item.id?'selected':''} ${protectedMode?'protected-box':''}" x="${r.x*1000}" y="${r.y*1000}" width="${r.w*1000}" height="${r.h*1000}" fill="${color}" fill-opacity="${protectedMode?.04:.1}" stroke="${color}"/><rect class="region-label-bg" x="${r.x*1000}" y="${Math.max(0,r.y*1000-33)}" width="67" height="32" fill="${color}"/><text class="region-label-text" x="${r.x*1000+8}" y="${Math.max(0,r.y*1000-33)+24}">${displayCode(item)}</text></g>`;
  }).join('');
  setTool(tool);
  if(state.quickMode&&typeof applyQuickCanvas==='function')applyQuickCanvas();
  if(typeof renderBrushCanvas==='function')renderBrushCanvas();
}
function sizeCanvas(width,height) {
  const stage=$('#canvasStage'),canvas=$('#garmentCanvas');
  const style=getComputedStyle(stage),availableWidth=stage.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),availableHeight=stage.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom),ratio=(width||900)/(height||1100);
  const h=Math.min(availableHeight,availableWidth/ratio),w=h*ratio;
  canvas.style.width=`${w}px`;canvas.style.height=`${h}px`;canvas.style.maxWidth='100%';
  if(typeof scheduleBrushRender==='function')scheduleBrushRender();
}
function renderEditor() {
  const item=selectedItem(),editor=$('#selectionEditor');editor.hidden=!item;if(!item)return;
  const protectedMode=isProtected(item.id);
  editor.innerHTML=`<div class="selection-header"><h3>${displayCode(item)} · ${itemName(item)}<span class="muted small">　位置与大小</span></h3><button id="deleteRegion" class="button text-button">${icon('trash')}删除区域</button></div><div class="coordinates">${[['x','左边距'],['y','上边距'],['w','宽度'],['h','高度']].map(([key,label])=>`<div><label for="coordinate-${key}">${label} %</label><input id="coordinate-${key}" type="number" min="${key==='w'||key==='h'?1:0}" max="100" step=".1" value="${+(rectOf(item)[key]*100).toFixed(1)}" data-coordinate="${key}"></div>`).join('')}</div><div class="editor-details">${!protectedMode?`<div class="field"><label for="intensity">痕迹力度</label><div class="range-row"><input id="intensity" type="range" min="0" max="100" value="${Math.round(item.intensity*100)}"><output id="intensityValue">${Math.round(item.intensity*100)}%</output></div><small>力度用于分区处理参数；最终效果仍取决于模型与面料。</small></div>`:'<div class="notice">保护区域在生成时从原图恢复。区域外也按局部编辑范围保留。</div>'}<div class="field"><label for="regionNotes">${protectedMode?'要保留的细节':'区域制作备注'}</label><input id="regionNotes" value="${escapeHtml(item.notes || '')}" maxlength="500" placeholder="${protectedMode?'例如：徽章 / 主要图案':'例如：少量横向擦痕'}"></div></div>`;
  $$('[data-coordinate]',editor).forEach(input=>input.addEventListener('change',()=>{checkpoint();const key=input.dataset.coordinate,updated={...item.rect,[key]:Number(input.value)/100};if(key==='x')updated.x=clamp(updated.x,0,1-updated.w);if(key==='y')updated.y=clamp(updated.y,0,1-updated.h);item.rect=normalizedRect(updated);dirty();renderCanvas();renderEditor();$(`#coordinate-${key}`)?.focus();if(state.step===2)refreshRegionList();}));
  $('#intensity')?.addEventListener('input',event=>{$('#intensityValue').textContent=`${event.target.value}%`;});
  $('#intensity')?.addEventListener('change',event=>{checkpoint();item.intensity=Number(event.target.value)/100;dirty();if(state.step===2)refreshRegionList();});
  $('#regionNotes').addEventListener('input',event=>{item.notes=event.target.value;dirty();});
  $('#deleteRegion').addEventListener('click',deleteSelected);
}
function refreshRegionList(){const list=$('.region-list');if(!list)return;list.innerHTML=regionList();$$('[data-select-region]',list).forEach(button=>button.addEventListener('click',()=>{selected=button.dataset.selectRegion;render();}));}
function deleteSelected() {if(!selectedItem())return;checkpoint();state.damageItems=state.damageItems.filter(i=>i.id!==selected);state.protectedRects=state.protectedRects.filter(i=>i.id!==selected);selected=null;dirty();render();}
function pointerPosition(event) {const bounds=$('#regionOverlay').getBoundingClientRect();return {x:clamp((event.clientX-bounds.left)/bounds.width,0,1),y:clamp((event.clientY-bounds.top)/bounds.height,0,1)};}
$('#regionOverlay').addEventListener('pointerdown',event=>{
  if(event.button!==0 || !imageReference() || compare)return;
  const origin=pointerPosition(event),target=event.target.closest('[data-region-id]');
  if(tool==='select'){
    if(!target){selected=null;renderEditor();renderCanvas();return;}
    selected=target.dataset.regionId;const item=selectedItem();checkpoint();pointer={kind:'move',origin,id:item.id,rect:deepCopy(item.rect)};renderEditor();renderCanvas();
  }else pointer={kind:'draw',origin,current:origin,protectedMode:tool==='protect'};
  $('#regionOverlay').setPointerCapture(event.pointerId);event.preventDefault();
});
$('#regionOverlay').addEventListener('pointermove',event=>{
  if(!pointer)return;const current=pointerPosition(event);
  if(pointer.kind==='move'){
    const item=itemById(pointer.id);item.rect.x=clamp(pointer.rect.x+current.x-pointer.origin.x,0,1-item.rect.w);item.rect.y=clamp(pointer.rect.y+current.y-pointer.origin.y,0,1-item.rect.h);renderCanvas();
  }else {
    pointer.current=current;$('#draftRect')?.remove();const r=drawnRect(pointer.origin,current);$('#regionOverlay').insertAdjacentHTML('beforeend',`<rect id="draftRect" class="draft-box" x="${r.x*1000}" y="${r.y*1000}" width="${r.w*1000}" height="${r.h*1000}"/>`);
  }
});
function drawnRect(a,b){return {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.abs(a.x-b.x),h:Math.abs(a.y-b.y)};}
function endPointer(event){if(!pointer)return;const p=pointer;pointer=null;if(p.kind==='draw'){const r=drawnRect(p.origin,pointerPosition(event));if(r.w>.012&&r.h>.012)addRegion(p.protectedMode,r);else{renderCanvas();toast('区域太小，请拖出更大的范围，或使用添加区域按钮。');}}else{dirty();render();}}
$('#regionOverlay').addEventListener('pointerup',endPointer);
$('#regionOverlay').addEventListener('pointercancel',()=>{if(pointer?.kind==='move'){const item=itemById(pointer.id);if(item)item.rect=pointer.rect;}pointer=null;renderCanvas();});
$('#regionOverlay').addEventListener('keydown',event=>{
  const item=selectedItem();if(!item)return;
  if(['Delete','Backspace'].includes(event.key)){event.preventDefault();deleteSelected();}
  if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();checkpoint();const delta=event.shiftKey?.02:.005;if(event.key==='ArrowLeft')item.rect.x-=delta;if(event.key==='ArrowRight')item.rect.x+=delta;if(event.key==='ArrowUp')item.rect.y-=delta;if(event.key==='ArrowDown')item.rect.y+=delta;item.rect.x=clamp(item.rect.x,0,1-item.rect.w);item.rect.y=clamp(item.rect.y,0,1-item.rect.h);dirty();renderCanvas();renderEditor();}
});

async function uploadImage(file) {
  if(!file)return;if(!['image/png','image/jpeg','image/webp'].includes(file.type)){toast('请上传 PNG、JPG 或 WebP 图片。');return;}
  if(file.size>20*1024*1024){toast('图片超过20MB，请缩小后再上传。');return;}
  toast('正在载入服装照片…');
  try{const form=new FormData();form.append('file',file);const data=await api('/api/uploads',{method:'POST',body:form});state.reference={...data,url:data.url || data.imageUrl,uploaded:true,name:file.name};state.damageItems=[];state.protectedRects=[];state.brushStrokes=[];if(typeof resetBrushHistory==='function')resetBrushHistory();state.previewUrl=null;state.job=null;selected=null;history=[];if(state.quickMode){state.quickOriginalReference=deepCopy(state.reference);state.quickParentJobId=null;state.quickStage='first';state.garmentId='';state.characterId='';state.scenarioId='';state.merchantId='';state.uploadMerchant='';state.uploadMaterial='';state.reversibleRequired='unknown';state.conceptReference=null;state.conceptJob=null;state.customDamageIdea='';state.customDamageEnabled=true;state.planNotes=[];if(typeof clearQuickMessage==='function')clearQuickMessage();}dirty();render();toast(state.quickMode?'照片已载入。可以直接画痕迹，也可以先生成一版。':'服装底图已载入，可以沿剧情建立战损方案。');}catch(error){toast(error.message);}
}
function projectPayload(){
  return {title:state.title,garmentId:state.garmentId,characterId:state.characterId,scenarioId:state.scenarioId,merchantId:state.merchantId,reference:imageReference(),conceptReference:state.conceptReference,uploadMerchant:state.uploadMerchant,uploadMaterial:state.uploadMaterial,material:state.uploadMaterial || garment()?.material,reversibleRequired:state.reversibleRequired,customDamageIdea:state.customDamageIdea,customDamageEnabled:state.customDamageEnabled,damageItems:state.damageItems,protectedRects:state.protectedRects,brushStrokes:state.brushStrokes,modelSelections:state.modelSelections,mode:state.mode,qualityChecklist:state.qualityChecklist,planNotes:state.planNotes,quickOriginalReference:state.quickOriginalReference,quickParentJobId:state.quickParentJobId,revision:state.revision};
}
function contentSignature(payload=projectPayload()){const {revision,qualityChecklist,...content}=payload;if(content.surfaceOptions){const {backgroundVisible,...surface}=content.surfaceOptions;content.surfaceOptions=surface;}return JSON.stringify(content);}
async function saveProject(notify=true){
  if(!imageReference())throw new Error('请先建立服装底图。');
  const payload=projectPayload(),signature=contentSignature(payload);
  if(state.projectId && !state.pendingEdits && state.savedSignature===signature){if(notify)toast('当前版本已保存。');return {id:state.projectId,revision:state.revision};}
  const button=$('#saveButton');button.disabled=true;$('#saveStatus').textContent='正在保存方案';
  try{const data=await api(state.projectId?`/api/projects/${encodeURIComponent(state.projectId)}`:'/api/projects',{method:state.projectId?'PUT':'POST',body:JSON.stringify(payload)});state.projectId=data.id || data.project?.id || data.projectId || state.projectId;state.revision=data.revision || data.project?.revision || state.revision;state.savedSignature=signature;state.pendingEdits=signature!==contentSignature();if(state.job && Number(state.job.projectRevision)!==Number(state.revision)){state.job=null;state.previewUrl=null;state.qualityChecklist={};}dirty({invalidate:false});$('#saveStatus').textContent=state.pendingEdits?'另有未保存修改':'方案已保存';if(notify)toast('方案已保存到课程文件夹。');return data;}catch(error){$('#saveStatus').textContent='保存未完成';throw error;}finally{button.disabled=false;}
}
async function generatePreview(){
  if(state.brushStrokes?.length&&typeof refineBrush==='function'){await refineBrush();return;}
  if(state.mode==='manual_chatgpt'){ await exportHandoff('costume'); return; }
  if(!state.damageItems.length){toast('请先添加战损区域。');return;}
  try{await saveProject(false);if(hasPendingEdits())throw new Error('生成前出现了新修改，请先保存当前版本。');const context={signature:contentSignature(),revision:state.revision,projectId:state.projectId};const result=await api(`/api/projects/${encodeURIComponent(state.projectId)}/jobs`,{method:'POST',body:JSON.stringify({mode:state.mode,projectRevision:state.revision,modelSelections:state.modelSelections,seed:Math.floor(Math.random()*2147483647),steps:20,cfg:7})});if(context.signature!==contentSignature() || state.projectId!==context.projectId){toast('区域已修改，本次任务按先前版本运行。');return;}state.job=result;state.previewUrl=null;render();pollJob(result.id || result.jobId,context);}catch(error){toast(error.message);render();}
}
async function pollJob(id,context){
  clearTimeout(jobPoll);
  try{const data=await api(`/api/jobs/${encodeURIComponent(id)}`);if(context.signature!==contentSignature() || context.revision!==state.revision || context.projectId!==state.projectId || hasPendingEdits()){return;}state.job=data;const completed=['completed','complete','succeeded','success'].includes(data.status);if(completed && Number(data.projectRevision)===Number(state.revision)){state.previewUrl=data.previewUrl || data.outputUrl || data.result?.previewUrl || data.result?.outputUrl || null;dirty({invalidate:false});toast(data.artifactKind==='draft'?'首版效果已返回。看看整体效果，再决定修改哪里。':'局部预览已返回。检查效果后，可以继续调整这一版。');}if(state.quickMode||state.step===3 || state.step===4)render();else renderCanvas();if(isJobRunning())jobPoll=setTimeout(()=>pollJob(id,context),1800);else if(data.status==='failed')toast(data.message || '预览未完成。');}catch(error){toast(`无法读取预览进度：${error.message}`);}
}
async function recordReview(){
  if(!currentResultValid()){toast('只能记录当前已保存版本的完成结果。');return;}
  try{const data=await api(`/api/projects/${encodeURIComponent(state.projectId)}/review`,{method:'POST',body:JSON.stringify({jobId:state.job.id,projectRevision:state.revision,qualityChecklist:state.qualityChecklist})});if(data.job)state.job=data.job;dirty({invalidate:false});toast('本次人工核查已记录，并绑定当前结果版本。');}catch(error){toast(error.message);}
}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function exportDocument(kind){
  try{await saveProject(false);const response=await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/exports/${kind}`);if(!response.ok)throw new Error('制作文件暂未生成。');downloadBlob(await response.blob(),`${state.title || '战损方案'}.${kind==='json'?'json':'html'}`);toast('制作方案已导出。');}catch(error){toast(error.message);}
}
async function exportAnnotatedPng(){
  if(state.brushStrokes?.length){try{await saveProject(false);const response=await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/exports/preview`);if(!response.ok)throw new Error('绘制位置预览未完成。');downloadBlob(await response.blob(),`${state.title}-绘制与位置规划-非AI结果.png`);toast('绘制位置预览已导出。');}catch(error){toast(error.message);}return;}
  const ref=imageReference();if(!ref){toast('请先建立服装底图。');return;}
  try{const image=new Image();image.crossOrigin='anonymous';image.src=ref.url;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const context=canvas.getContext('2d');context.drawImage(image,0,0);const scale=canvas.width/1000;context.font=`600 ${Math.max(18,22*scale)}px Microsoft YaHei,sans-serif`;
    [...state.damageItems,...state.protectedRects].forEach(item=>{const protect=isProtected(item.id),color=protect?'#686e65':DAMAGE[item.type].color,r=item.rect,x=r.x*canvas.width,y=r.y*canvas.height,w=r.w*canvas.width,h=r.h*canvas.height;context.strokeStyle=color;context.lineWidth=Math.max(2,2*scale);context.setLineDash(protect?[8*scale,5*scale]:[]);context.strokeRect(x,y,w,h);context.setLineDash([]);context.fillStyle=color;context.fillRect(x,Math.max(0,y-34*scale),68*scale,34*scale);context.fillStyle='#ffffff';context.fillText(displayCode(item),x+8*scale,Math.max(0,y-34*scale)+25*scale);});
    canvas.toBlob(blob=>{if(blob)downloadBlob(blob,`${state.title || '战损方案'}-区域标注.png`);},'image/png');toast('区域标注预览已导出。');
  }catch(error){toast(`标注导出未完成：${error.message}`);}
}
async function importProject(file){
  if(!file)return;try{const data=JSON.parse(await file.text()),project=data.project || data;if(!project || typeof project!=='object' || Array.isArray(project))throw new Error('方案格式不正确。');const candidate={...state,...project,title:String(project.title || '导入的战损方案').slice(0,80),damageItems:validateItems(project.damageItems || []),protectedRects:validateItems(project.protectedRects || [],true),modelSelections:{slash:'',blood:'',burn:'',...(project.modelSelections || {})},qualityChecklist:{},planNotes:Array.isArray(project.planNotes)?project.planNotes:[],projectId:null,revision:null,job:null,previewUrl:null,step:2};if(candidate.reference && (typeof candidate.reference.url!=='string' || !safeUrl(candidate.reference.url)))throw new Error('底图地址无法识别。');if(!catalog.characters.some(c=>c.id===candidate.characterId))candidate.characterId=catalog.characters[0]?.id || '';if(!scenarios.some(s=>s.id===candidate.scenarioId))candidate.scenarioId='';state=candidate;state.brushStrokes=typeof validateBrushDraft==='function'?validateBrushDraft(project.brushStrokes || []):[];state.brushMode=true;history=[];selected=null;if(typeof resetBrushHistory==='function')resetBrushHistory();dirty();render();toast('方案已导入为新草稿。请确认底图和剧情依据。');}catch(error){toast(`导入未完成：${error.message}`);}
}
function goStep(next){
  if(next>state.step && state.step===0 && !imageReference()){toast('请先选择示例服装或上传服装照片。');return;}
  state.step=clamp(next,0,4);dirty({invalidate:false});render();
  if(matchMedia('(max-width:680px)').matches)$('#controlPanel').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth',block:'start'});
}
$('#stepper').addEventListener('click',event=>{const button=event.target.closest('[data-step]');if(button)goStep(Number(button.dataset.step));});
$('#nextStep').addEventListener('click',()=>{if(state.step===4){$('#exportResult').hidden=!(currentResultValid()&&(state.job.outputUrl||state.job.previewUrl));$('#exportDialog').showModal();}else goStep(state.step+1);});
$('#previousStep').addEventListener('click',()=>goStep(state.step-1));
$('#projectTitle').addEventListener('input',event=>{state.title=event.target.value;dirty({invalidate:false});});
$('#saveButton').addEventListener('click',()=>saveProject().catch(error=>toast(error.message)));
$('#selectTool').addEventListener('click',()=>setTool('select'));
$('#drawTool').addEventListener('click',()=>{setTool('draw');toast(`在服装上拖出${DAMAGE[currentDamage].label}区域，或在痕迹规划中使用添加按钮。`);});
$('#protectTool').addEventListener('click',()=>{setTool('protect');toast('拖出要保留的区域，例如徽章、图案或扣件。');});
$('#undoButton').addEventListener('click',()=>{if(!history.length)return;const old=history.pop();state.damageItems=old.damageItems;state.protectedRects=old.protectedRects;selected=null;dirty();render();});
$('#compareButton').addEventListener('click',()=>{compare=!compare;$('#compareButton').setAttribute('aria-pressed',String(compare));renderCanvas();});
$('#regionsButton').addEventListener('click',()=>{showRegions=!showRegions;$('#regionsButton').setAttribute('aria-pressed',String(showRegions));renderCanvas();});
$('#imageUpload').addEventListener('change',event=>{uploadImage(event.target.files[0]);event.target.value='';});
$('#emptyUploadButton').addEventListener('click',()=>$('#imageUpload').click());
$('#importButton').addEventListener('click',()=>$('#projectImport').click());
$('#projectImport').addEventListener('change',event=>{importProject(event.target.files[0]);event.target.value='';});
$('#closeExportDialog').addEventListener('click',()=>$('#exportDialog').close());
$('#exportDialog').addEventListener('click',event=>{if(event.target===$('#exportDialog')){const r=$('#exportDialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('#exportDialog').close();}});
$('#exportJson').addEventListener('click',()=>exportDocument('json'));
$('#exportHtml').addEventListener('click',()=>exportDocument('html'));
$('#exportPng').addEventListener('click',exportAnnotatedPng);
$('#exportResult').addEventListener('click',async()=>{if(!currentResultValid()){toast('当前区域已修改，请生成新的结果。');return;}try{const response=await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/exports/result`);if(!response.ok)throw new Error('当前版本尚无可导出的实际生成图。');downloadBlob(await response.blob(),`${state.title || '战损方案'}-实际生成结果.png`);toast('实际生成结果已导出。');}catch(error){toast(error.message);}});
$('#garmentImage').addEventListener('load',()=>{const ref=imageReference(),img=$('#garmentImage');if(ref){if(img.getAttribute('src')===ref.url){ref.width=img.naturalWidth;ref.height=img.naturalHeight;}sizeCanvas(img.naturalWidth,img.naturalHeight);}});
window.addEventListener('resize',()=>{const ref=imageReference();if(ref)sizeCanvas(ref.width,ref.height);});

async function initialize(){
  const results=await Promise.allSettled([api('/api/catalog'),api('/api/scenarios'),api('/api/models')]);
  if(results[0].status==='fulfilled'){catalog=results[0].value;online=true;}else console.error('catalog:',results[0].reason);
  if(results[1].status==='fulfilled'){const data=results[1].value;scenarios=Array.isArray(data)?data:(data.scenarios || data.items || []);storyMeta=Array.isArray(data)?{}:data;}
  if(results[2].status==='fulfilled')models=results[2].value;
  if(!online){$('#connectionStatus').classList.add('offline');$('#connectionStatus').innerHTML='<span class="status-dot"></span>服务未连接';toast('本机服务暂未连接，目录与保存功能尚不可用。');}
  else $('#connectionStatus').innerHTML='<span class="status-dot"></span>本机工作台';
  let loadedDraft=false;
  try{const saved=JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');if(saved){state={...state,...saved,step:clamp(saved.step,0,4),damageItems:validateItems(saved.damageItems || []),protectedRects:validateItems(saved.protectedRects || [],true),job:null,previewUrl:null};loadedDraft=true;}}catch(error){console.warn('draft:',error.message);}
  if(!['manual_chatgpt','cloud_image_edit','base_experiment','registered_lora'].includes(state.mode))state.mode='manual_chatgpt';
  if(!state.workflowVersion){try{localStorage.setItem(STORAGE_KEY+'-before-cloud',JSON.stringify(state));}catch{}state.mode='manual_chatgpt';state.workflowVersion='cloud-2026-10-12';}
  if(!state.characterId || !catalog.characters.some(c=>c.id===state.characterId))state.characterId=state.reference?.uploaded?'':catalog.characters[0]?.id || '';
  if(!state.garmentId || !catalog.garments.some(g=>g.id===state.garmentId))state.garmentId=state.reference?.uploaded?'':catalog.garments[0]?.id || '';
  if(state.scenarioId && !scenarios.some(s=>s.id===state.scenarioId))state.scenarioId='';
  if(!loadedDraft && !state.reference)state.protectedRects=(garment()?.protectedRects || []).map(rect=>({id:uid('protect'),rect:normalizedRect(rect.rect || rect),notes:'保留示例图主要标识'}));
  if(!state.quickWorkflowVersion){state.quickMode=true;state.quickStage=state.damageItems.length?'refine':'first';state.quickWorkflowVersion='first-draft-2026-10-13';}
  // Adding optional lineage fields must not invalidate an otherwise unchanged older draft.
  if(!state.pendingEdits&&state.savedSignature){try{const old=JSON.parse(state.savedSignature);if(!Object.hasOwn(old,'quickOriginalReference')&&!Object.hasOwn(old,'quickParentJobId')){const {revision,qualityChecklist,quickOriginalReference,quickParentJobId,...legacy}=projectPayload();if(JSON.stringify(legacy)===state.savedSignature)state.savedSignature=contentSignature();}}catch{}}
  if(typeof validateBrushDraft==='function'){try{state.brushStrokes=validateBrushDraft(state.brushStrokes || []);}catch(error){state.brushStrokes=[];toast(error.message);}}
  if(!state.pendingEdits&&state.savedSignature){try{const old=JSON.parse(state.savedSignature),current=projectPayload();delete current.revision;delete current.qualityChecklist;if(!Object.hasOwn(old,'brushStrokes')&&!state.brushStrokes.length)delete current.brushStrokes;if(!Object.hasOwn(old,'quickOriginalReference')&&!state.quickOriginalReference)delete current.quickOriginalReference;if(!Object.hasOwn(old,'quickParentJobId')&&!state.quickParentJobId)delete current.quickParentJobId;if(JSON.stringify(current)===state.savedSignature)state.savedSignature=contentSignature();}catch{}}
  draftReady=true;render();
  if(state.projectId&&!hasPendingEdits()){
    try{const saved=await api(`/api/projects/${encodeURIComponent(state.projectId)}`);if(Number(saved.revision)===Number(state.revision)){const result=await api(`/api/projects/${encodeURIComponent(state.projectId)}/jobs`);const match=(result.jobs||[]).find(j=>j.artifactKind!=='concept'&&Number(j.projectRevision)===Number(state.revision)&&j.status==='succeeded');if(match){state.job=match;state.previewUrl=match.outputUrl||match.previewUrl;render();}}}catch{}
  }
}
document.addEventListener('DOMContentLoaded',initialize,{once:true});
window.addEventListener('studio:entered',()=>{renderCanvas();});
window.addEventListener('pagehide',persistDraft);
