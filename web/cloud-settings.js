'use strict';
let conceptPollTimer=null, workflowBusy=false, importKind='costume';
const extrasInput=document.createElement('input');
extrasInput.type='file';extrasInput.accept='image/png,image/jpeg,image/webp';extrasInput.hidden=true;document.body.append(extrasInput);
let extrasAction='concept-reference';
extrasInput.addEventListener('change',async()=>{const file=extrasInput.files[0];extrasInput.value='';if(!file)return;if(extrasAction==='concept-reference')await uploadConcept(file);else await importGenerated(file,importKind);});

function cloudInfo(){return models.cloud || {};}
function providerName(provider=cloudInfo().provider){return {openai:'GPT Image',qwen:'千问',openai_compatible:'OpenAI 兼容中转',local_openai:'本机图像模型'}[provider]||'图像服务';}
function cloudSource(){
  const cloud=cloudInfo();
  if(['openai_compatible','local_openai'].includes(cloud.provider))return cloud.baseUrl||'尚未填写接口地址';
  return cloud.provider==='qwen'?'阿里云百炼接口':'OpenAI 官方接口';
}
function renderModels(){
  if(['base_experiment','registered_lora'].includes(state.mode))return `<button id="returnManualMode" class="button outline-button full-width">返回 ChatGPT / 云端图像方式</button>`+renderLegacyModels();
  const cloud=cloudInfo(),manual=state.mode==='manual_chatgpt',busy=isJobRunning()||workflowBusy;
  return `<div class="notice accent-notice"><strong>先看效果，再动手。</strong><br>用同一套底图与区域规划，比较生成结果。保护区域和选区外会恢复为原图。</div><div class="divider"></div>
  <div class="section-label">选择生成方式</div>
  <label class="choice-row"><input name="previewMode" type="radio" value="manual_chatgpt" ${manual?'checked':''}><span><strong>在 ChatGPT 中生成</strong><span>使用你已有的会员：下载图片和提示词，在 ChatGPT 生图后导回这里。</span></span></label>
  <label class="choice-row"><input name="previewMode" type="radio" value="cloud_image_edit" ${state.mode==='cloud_image_edit'?'checked':''}><span><strong>图像接口自动生成</strong><span>选择云端或本机图像编辑。云端按服务计费，本机使用电脑资源。</span></span></label>
  ${manual?`<div class="notice"><strong>01 下载 → 02 生图 → 03 导回</strong><p class="small">解压生成包，将原图、区域示意和可选二维参考上传到 ChatGPT，再复制包里的提示词。保存生成图片后导回。</p></div>
  <button id="generatePreview" class="button primary-button full-width" ${!state.damageItems.length||busy?'disabled':''}>${icon('folder')}${workflowBusy?'正在整理生成包':'下载 ChatGPT 生成包'}</button>
  <a class="button text-button full-width" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">打开 ChatGPT${icon('link')}</a>
  <button id="importCostumeResult" class="button outline-button full-width" ${busy||!state.damageItems.length?'disabled':''}>${icon('upload')}导回生成的服装效果图</button>`:
  `<div class="model-card"><div class="model-heading"><strong>${escapeHtml(providerName())}</strong><span class="model-status">${cloud.ready?'仅已配置':'待配置'}</span></div><p>${escapeHtml(cloud.model || 'gpt-image-2')}</p><p style="overflow-wrap:anywhere">服务来源：${escapeHtml(cloudSource())}</p><p>配置与模型列表检查不代表图像编辑已验证。</p><button id="configureCloud" class="button outline-button full-width">设置图像服务</button></div>
  <p class="field-hint">${state.conceptReference?'已加入二维参考，服装实拍仍为主要底图。':'可以直接编辑服装照，也可回到故事参考加入二维参考。'}每次点击提交一张图，不自动重试。</p>
  <button id="generatePreview" class="button primary-button full-width" ${!cloud.ready||!state.damageItems.length||busy?'disabled':''}>${icon('image')}${busy?'正在生成预览':`使用${providerName()}生成预览`}</button>
  ${!cloud.ready?`<p class="field-hint">${cloud.provider==='local_openai'?'先启动本机图像编辑服务，在“图像服务”填写本机地址和实际模型名称。不需要云端密钥。':'先在“图像服务”填写所选服务的 API 密钥及设置。兼容中转需填写地址和图像模型；千问需配置对应地域的工作空间 ID。'}</p>`:''}`}
  ${state.job?renderProgress():''}
  <p class="field-hint">当前是照片上的视觉预览。生成结果需要检查接缝、图案与痕迹自然程度，材料渗色和清洗效果仍需实物试样。</p>
  <details class="details"><summary>已有本机实验方式</summary><p class="field-hint">此前的本机模型仍保留，默认流程无需启动 ComfyUI。</p><label class="choice-row"><input name="previewMode" type="radio" value="base_experiment" ${state.mode==='base_experiment'?'checked':''}><span>使用原有基础模型实验</span></label><label class="choice-row"><input name="previewMode" type="radio" value="registered_lora" ${state.mode==='registered_lora'?'checked':''}><span>使用原有 LoRA 实验</span></label></details>
  `;
}
function renderConcept(){
  const ref=state.conceptReference,job=state.conceptJob,completed=job?.status==='succeeded',valid=completed&&Number(job.projectRevision)===Number(state.revision)&&!hasPendingEdits();
  return `<div class="divider"></div><div class="section-label">二维角色参考<span class="muted small">可选</span></div><p class="field-hint">先调整角色立绘的战损方向，再把满意的外观作为服装预览参考。也可以跳过此步。</p>
  ${ref?`<div class="concept-reference"><img src="${escapeHtml(safeUrl(ref.url))}" alt="当前二维角色参考"><div><strong>${ref.generated?'已采用的二维效果':'已上传角色参考'}</strong><span class="small muted">仅用于表达外观，不改变服装底图。</span><button id="removeConcept" class="button text-button">移除参考</button></div></div>`:''}
  <button id="uploadConcept" class="button outline-button full-width">${icon('upload')}${ref?'更换角色立绘':'上传角色立绘 / 二维参考'}</button>
  ${ref?`<div class="region-actions"><button id="exportConceptHandoff" class="button outline-button">${icon('folder')}下载二维生成包</button><button id="importConceptResult" class="button outline-button">${icon('upload')}导回二维效果</button></div><button id="generateConcept" class="button outline-button full-width" ${!cloudInfo().ready||workflowBusy||isJobRunning()||['queued','running'].includes(job?.status)?'disabled':''}>${icon('image')}用${providerName()}接口生成二维效果</button>${!cloudInfo().ready?'<p class="field-hint">未配置接口时，可下载二维生成包，在 ChatGPT 中生成。</p>':''}`:''}
  ${job?`<div class="notice"><strong>${job.status==='succeeded'?'二维效果已返回':job.status==='failed'?'二维效果未完成':'正在生成二维效果'}</strong><p class="small">${escapeHtml(job.message || '')}</p>${valid?`<img class="concept-result" src="${escapeHtml(safeUrl(job.outputUrl || job.result?.outputUrl))}" alt="尚未采用的二维生成结果"><button id="adoptConcept" class="button primary-button full-width">采用这张二维参考</button>`:completed?'<p class="small">方案已有修改，请重新生成对应版本后采用。</p>':''}</div>`:''}`;
}
function bindWorkflowExtras(){
  $('#returnManualMode')?.addEventListener('click',()=>{state.mode='manual_chatgpt';dirty();render();});
  $('#configureCloud')?.addEventListener('click',openAiSettings);
  $('#uploadConcept')?.addEventListener('click',()=>chooseExtra('concept-reference'));
  $('#removeConcept')?.addEventListener('click',()=>{state.conceptReference=null;state.conceptJob=null;dirty();render();});
  $('#exportConceptHandoff')?.addEventListener('click',()=>exportHandoff('concept'));
  $('#importConceptResult')?.addEventListener('click',()=>chooseExtra('import','concept'));
  $('#importCostumeResult')?.addEventListener('click',()=>chooseExtra('import','costume'));
  $('#generateConcept')?.addEventListener('click',generateConcept);
  $('#adoptConcept')?.addEventListener('click',()=>{const job=state.conceptJob;if(!job||job.status!=='succeeded'||Number(job.projectRevision)!==Number(state.revision)||hasPendingEdits()){toast('二维结果版本已过期，请重新生成。');return;}state.conceptReference=job.resultingReference||{url:job.outputUrl,width:job.result?.width,height:job.result?.height,generated:true,jobId:job.id};state.conceptJob=null;dirty();render();toast('已采用二维参考。接下来规划实拍服装的痕迹区域。');});
}
function chooseExtra(action,kind='costume'){extrasAction=action;importKind=kind;extrasInput.click();}
async function uploadConcept(file){
  if(file.size>20*1024*1024){toast('图片超过20MB，请缩小后上传。');return;}
  try{const form=new FormData();form.append('file',file);const data=await api('/api/uploads',{method:'POST',body:form});state.conceptReference={...data,name:file.name,uploaded:true};state.conceptJob=null;dirty();render();toast('二维参考已载入。');}catch(error){toast(error.message);}
}
async function exportHandoff(kind){
  if(workflowBusy)return;workflowBusy=true;render();
  try{await saveProject(false);if(hasPendingEdits())throw new Error('请先保存当前版本。');const context={projectId:state.projectId,revision:state.revision,signature:contentSignature()};const res=await api(`/api/projects/${encodeURIComponent(state.projectId)}/handoff?kind=${kind}`);downloadBlob(await res.blob(),`${state.title}-${kind==='concept'?'二维参考':'服装预览'}-ChatGPT生成包.zip`);state.handoffContexts={...(state.handoffContexts||{}),[kind]:context};toast('生成包已下载。解压后将图片和提示词交给 ChatGPT，保存结果再导回。');}catch(error){toast(error.message);}finally{workflowBusy=false;render();}
}
async function importGenerated(file,kind){
  if(file.size>20*1024*1024){toast('图片超过20MB。');return;}
  const handoff=state.handoffContexts?.[kind];
  if(handoff&&(handoff.projectId!==state.projectId||handoff.signature!==contentSignature())){toast('下载生成包后方案已有修改。请恢复对应方案，或重新下载生成包后生图。');return;}
  if(workflowBusy)return;workflowBusy=true;render();
  try{await saveProject(false);const context={projectId:state.projectId,revision:state.revision,signature:contentSignature()};const form=new FormData();form.append('file',file);form.append('projectRevision',String(state.revision));form.append('kind',kind);const data=await api(`/api/projects/${encodeURIComponent(state.projectId)}/import-result`,{method:'POST',body:form});if(context.signature!==contentSignature())throw new Error('方案已修改，导回结果保存在对应版本中。');const job=data.job||data;if(kind==='concept')state.conceptJob=job;else{state.job=job;state.previewUrl=job.outputUrl||job.result?.outputUrl;state.qualityChecklist={};}dirty({invalidate:false});toast(kind==='concept'?'二维效果已导回，请检查后采用。':'效果已导回，仅选区参与合成；请检查边缘与角色细节。');}catch(error){toast(error.message);}finally{workflowBusy=false;render();}
}
async function generateConcept(){
  if(workflowBusy)return;workflowBusy=true;render();
  try{await saveProject(false);const context={projectId:state.projectId,revision:state.revision,signature:contentSignature()};const job=await api(`/api/projects/${encodeURIComponent(state.projectId)}/jobs`,{method:'POST',body:JSON.stringify({mode:'cloud_concept_edit',projectRevision:state.revision})});state.conceptJob=job;pollConcept(job.id,context);}catch(error){toast(error.message);}finally{workflowBusy=false;render();}
}
async function pollConcept(id,context){
  clearTimeout(conceptPollTimer);try{const job=await api(`/api/jobs/${encodeURIComponent(id)}`);if(context.projectId!==state.projectId||context.revision!==state.revision||context.signature!==contentSignature())return;state.conceptJob=job;if(state.step===1)render();if(['queued','running'].includes(job.status))conceptPollTimer=setTimeout(()=>pollConcept(id,context),1800);else if(job.status==='failed')toast(job.message||'二维效果未完成。');else toast('二维效果已返回，检查后可采用为参考。');}catch(error){toast(error.message);}
}

const settingsDialog=document.createElement('dialog');
settingsDialog.id='aiSettingsDialog';
settingsDialog.className='cloud-settings-dialog';
settingsDialog.innerHTML=`
  <div class="dialog-heading"><div><span class="eyebrow">IMAGE SERVICE</span><h2>图像服务</h2></div><button id="closeAiSettings" class="tool-button icon-only" aria-label="关闭图像服务设置">${icon('close')}</button></div>
  <p>选择自动生图的服务。也可以不配置接口，在 ChatGPT 中生图后导回。</p>
  <form id="aiSettingsForm">
    <div class="field"><label for="aiProvider">服务</label><select id="aiProvider"><option value="openai">GPT Image · OpenAI</option><option value="qwen">千问图像 · 阿里云百炼</option><option value="openai_compatible">OpenAI 兼容中转</option><option value="local_openai">本机图像编辑服务</option></select></div>
    <div class="field" id="aiModelField"><label for="aiModel">图像模型</label><select id="aiModel"></select></div>
    <div id="relaySettings" hidden>
      <div class="field"><label id="aiBaseUrlLabel" for="aiBaseUrl">中转接口地址</label><input id="aiBaseUrl" type="url" inputmode="url" placeholder="例如 https://api.fenno.ai/v1" autocomplete="off" autocapitalize="off" spellcheck="false"><small id="aiAddressHint">填写你选择的服务地址。更换地址后，原地址的密钥不能沿用，需要重新填写。</small></div>
      <div class="field"><label for="aiRelayModel">图像模型名称</label><input id="aiRelayModel" list="aiRelayModelCandidates" placeholder="例如 gpt-image-2" autocomplete="off" autocapitalize="off" spellcheck="false"><datalist id="aiRelayModelCandidates"></datalist><small>填写该服务支持的图像编辑模型。模型列表中的对话或代码模型不等于图像模型。</small></div>
      <p id="aiEndpointHint" class="field-hint">兼容中转是独立的服务配置，不会修改 OpenAI 官方账户或官方接口设置。地址示例不代表该服务已支持图像编辑。</p>
    </div>
    <div id="qwenSettings" hidden><div class="field"><label for="aiRegion">百炼地域</label><select id="aiRegion"><option value="cn-beijing">中国 · 北京</option><option value="ap-southeast-1">新加坡</option></select></div><div class="field"><label for="aiWorkspace">工作空间 ID</label><input id="aiWorkspace" placeholder="从百炼控制台复制工作空间 ID" autocomplete="off"><small>API 密钥、地域和工作空间须对应。</small></div></div>
    <div class="field" id="qualityField"><label for="aiQuality">生成质量</label><select id="aiQuality"><option value="low">低 · 快速试稿</option><option value="medium">中 · 常规预览</option><option value="high">高 · 精细预览</option><option value="auto">自动</option></select></div>
    <div class="field"><label for="aiApiKey">API 密钥</label><input id="aiApiKey" type="password" autocomplete="off" placeholder="粘贴所选服务的 API 密钥"><small id="aiKeyHint">密钥仅在本机服务运行期间保留。留空会沿用该服务已配置的密钥。</small></div>
    <p id="aiSettingsStatus" class="notice" role="status" aria-live="polite"></p>
    <div class="region-actions"><button type="submit" class="button primary-button" id="saveAiSettings">保存设置</button><button type="button" class="button outline-button" id="checkAiConnection">检查连接</button><button type="button" class="button text-button" id="clearAiKey">清除密钥</button></div>
  </form>
  <p class="field-hint">检查连接只读取模型列表，不调用生图，也不保存当前表单。模型可列出不代表图像编辑可用；填写后还需保存设置。</p>
  <p id="aiBillingHint" class="field-hint">云端接口单独计费；ChatGPT Pro 会员与千问网页会员不自动包含 API 额度。仅保存设置不会发起生图。</p>`;
document.body.append(settingsDialog);

let settingsSnapshot={},connectionCheckSequence=0;
function providerSettings(provider=$('#aiProvider').value){
  return settingsSnapshot.providers?.[provider]||(settingsSnapshot.provider===provider?settingsSnapshot:{});
}
function setSettingsBusy(busy){
  settingsDialog.querySelectorAll('form input,form select,#saveAiSettings,#checkAiConnection,#clearAiKey').forEach(element=>{element.disabled=busy;});
}
function fillProviderSettings(){
  connectionCheckSequence++;
  const provider=$('#aiProvider').value,info=providerSettings(provider),local=provider==='local_openai',relay=provider==='openai_compatible'||local;
  const defaults=provider==='qwen'?['qwen-image-3.0-pro','qwen-image-3.0','qwen-image-2.1-pro']:['gpt-image-2','gpt-image-1.5'];
  $('#aiModel').innerHTML=(info.models?.length?info.models:defaults).map(model=>`<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('');
  $('#aiModel').value=info.model||defaults[0];
  $('#aiBaseUrl').value=relay?(info.baseUrl||(local?'http://127.0.0.1:1234/v1':'')):'';
  $('#aiRelayModel').value=relay?(info.model||(local?'':'gpt-image-2')):'';
  $('#aiBaseUrlLabel').textContent=local?'本机图像接口地址':'中转接口地址';
  $('#aiBaseUrl').placeholder=local?'http://127.0.0.1:1234/v1':'例如 https://api.fenno.ai/v1';
  $('#aiRelayModel').placeholder=local?'填写本机服务实际加载的图像模型 ID':'例如 gpt-image-2';
  $('#aiAddressHint').textContent=local?'只接收本机 loopback 地址。须先安装并启动支持图像编辑的服务。':'填写你选择的服务地址。更换地址后，原地址的密钥不能沿用，需要重新填写。';
  $('#aiEndpointHint').textContent=local?'服务必须支持 /v1/images/edits 和 Base64 图像输出。Ollama、LM Studio 的对话接口不能直接代替图像编辑服务。模型目录中的文件不等于已加载可用。':'兼容中转是独立的服务配置，不会修改 OpenAI 官方账户或官方接口设置。地址示例不代表该服务已支持图像编辑。';
  $('#aiBillingHint').textContent=local?'本机推理使用你电脑的资源，不调用云端生图。此安装包未附带图像模型；保存设置不会启动、下载或生成。':'云端接口单独计费；ChatGPT Pro 会员与千问网页会员不自动包含 API 额度。仅保存设置不会发起生图。';
  $('#aiRelayModelCandidates').replaceChildren();
  $('#aiQuality').value=local?'auto':(info.quality||'medium');
  $('#aiRegion').value=info.region||'cn-beijing';
  $('#aiWorkspace').value=info.workspaceId||'';
  $('#aiApiKey').value='';
  $('#aiModelField').hidden=relay;
  $('#relaySettings').hidden=!relay;
  $('#aiBaseUrl').required=relay;
  $('#aiRelayModel').required=relay;
  $('#aiModel').required=!relay;
  $('#qwenSettings').hidden=provider!=='qwen';
  $('#qualityField').hidden=provider==='qwen'||local;
  $('#aiApiKey').placeholder=local?'可留空；仅在本机服务要求时填写':'粘贴所选服务的 API 密钥';
  $('#aiSettingsStatus').textContent=local?(info.ready?'本机地址与模型已配置，连接和图像编辑尚未验证。':'先启动本机图像服务，再填写地址和实际图像模型名称。'):info.hasKey?'该服务已有本机密钥。配置不代表连接或图像编辑已验证。':'该服务尚未配置密钥。';
  updateRelayKeyHint();
}
function updateRelayKeyHint(){
  const local=$('#aiProvider').value==='local_openai',relay=$('#aiProvider').value==='openai_compatible'||local;
  const cleanUrl=value=>String(value||'').trim().replace(/\/+$/,'');
  const changed=relay&&cleanUrl($('#aiBaseUrl').value)!==cleanUrl(providerSettings().baseUrl);
  $('#aiKeyHint').textContent=local?(changed?'本机地址已变更，旧地址的密钥不能沿用。新服务不要求密钥时可以留空。':'本机服务可不设密钥；不会使用云端服务密钥。仅在服务要求时填写，当前运行中保留。'):changed?'地址已变更，请重新填写此地址对应的密钥。原地址的密钥不能沿用。':'密钥仅在本机服务运行期间保留。留空会沿用该服务已配置的密钥。';
}
function settingsPayload(){
  const provider=$('#aiProvider').value;
  const custom=['openai_compatible','local_openai'].includes(provider);
  const payload={provider,model:(custom?$('#aiRelayModel').value:$('#aiModel').value).trim(),quality:provider==='local_openai'?'auto':$('#aiQuality').value};
  const key=$('#aiApiKey').value.trim();
  if(key)payload.apiKey=key;
  if(custom)payload.baseUrl=$('#aiBaseUrl').value.trim();
  if(provider==='qwen'){
    payload.region=$('#aiRegion').value;
    payload.workspaceId=$('#aiWorkspace').value.trim();
  }
  return payload;
}
function showConnectionResult(result){
  const candidates=Array.isArray(result.imageCandidates)?result.imageCandidates:[];
  const options=[...new Set(candidates.filter(model=>typeof model==='string'&&model.trim()))].map(model=>{
    const option=document.createElement('option');option.value=model;return option;
  });
  $('#aiRelayModelCandidates').replaceChildren(...options);
  const messages=[result.message||(result.ok?'模型列表已读取。':'连接检查未通过。')];
  if(result.authenticated===true)messages.push('模型列表认证成功。');
  if(Array.isArray(result.modelIds))messages.push(`读取到 ${result.modelIds.length} 个模型，${options.length} 个图像模型候选。`);
  if(result.modelListed===false)messages.push('当前填写的模型未在返回列表中。');
  messages.push('尚未验证图像编辑能力；本次未调用生图，也未保存表单。');
  $('#aiSettingsStatus').textContent=messages.join(' ');
}
function invalidateConnectionResult(message,clearCandidates=true){
  connectionCheckSequence++;
  if(clearCandidates)$('#aiRelayModelCandidates').replaceChildren();
  $('#aiSettingsStatus').textContent=message;
}
async function openAiSettings(providerOverride){
  try{
    settingsSnapshot=await api('/api/settings/ai');
    $('#aiProvider').value=['openai','qwen','openai_compatible','local_openai'].includes(providerOverride)?providerOverride:(settingsSnapshot.provider||'openai');
    fillProviderSettings();
    settingsDialog.showModal();
  }catch(error){toast(error.message);}
}
$('#aiProvider').addEventListener('change',fillProviderSettings);
$('#aiBaseUrl').addEventListener('input',()=>{invalidateConnectionResult('地址已修改，请重新检查该地址的模型列表。图像编辑能力尚未验证。');updateRelayKeyHint();});
$('#aiRelayModel').addEventListener('input',()=>invalidateConnectionResult('模型名称已修改，可检查连接核对该名称是否在模型列表中。',false));
$('#aiApiKey').addEventListener('input',()=>invalidateConnectionResult('密钥已修改，可检查连接后再保存。图像编辑能力尚未验证。'));
$('#aiModel').addEventListener('change',()=>invalidateConnectionResult('已选择其他图像模型，可检查连接核对模型列表。'));
$('#aiRegion').addEventListener('change',()=>invalidateConnectionResult('百炼地域已修改，可重新检查连接。'));
$('#aiWorkspace').addEventListener('input',()=>invalidateConnectionResult('工作空间已修改，可重新检查连接。'));
$('#closeAiSettings').addEventListener('click',()=>settingsDialog.close());
settingsDialog.addEventListener('close',()=>{connectionCheckSequence++;$('#aiApiKey').value='';});

$('#checkAiConnection').addEventListener('click',async()=>{
  if(!$('#aiSettingsForm').reportValidity())return;
  const payload=settingsPayload(),sequence=++connectionCheckSequence;
  setSettingsBusy(true);
  $('#aiSettingsStatus').textContent='正在读取所选服务的模型列表，不会调用生图。';
  try{
    const result=await api('/api/settings/ai/check',{method:'POST',body:JSON.stringify(payload)});
    if(sequence===connectionCheckSequence)showConnectionResult(result);
  }catch(error){
    if(sequence===connectionCheckSequence)$('#aiSettingsStatus').textContent=`${error.message} 本次未调用生图，也未保存表单；图像编辑能力尚未验证。`;
  }finally{setSettingsBusy(false);}
});
$('#aiSettingsForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const payload=settingsPayload();
  setSettingsBusy(true);
  try{
    settingsSnapshot=await api('/api/settings/ai',{method:'POST',body:JSON.stringify(payload)});
    $('#aiApiKey').value='';
    models=await api('/api/models');
    settingsDialog.close();
    render();
    toast('图像服务设置已保存，图像编辑能力仍需实际生成验证。');
    window.dispatchEvent(new Event('models:settings-changed'));
  }catch(error){$('#aiSettingsStatus').textContent=error.message;}
  finally{setSettingsBusy(false);}
});
$('#clearAiKey').addEventListener('click',async()=>{
  setSettingsBusy(true);
  try{
    settingsSnapshot=await api(`/api/settings/ai?provider=${encodeURIComponent($('#aiProvider').value)}`,{method:'DELETE'});
    models=await api('/api/models');
    fillProviderSettings();
    render();
    window.dispatchEvent(new Event('models:settings-changed'));
  }catch(error){$('#aiSettingsStatus').textContent=error.message;}
  finally{setSettingsBusy(false);}
});
document.addEventListener('click',event=>{if(event.target.closest('#aiSettingsButton'))openAiSettings();});
