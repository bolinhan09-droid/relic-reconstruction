/* Local files and runtime settings; does not install, start or generate models. */
(function (global) {
  'use strict';
  const esc=value=>escapeHtml(String(value??''));
  const byId=id=>document.getElementById(id);
  let snapshot=null,serial=0,reading=false;
  const dialog=document.createElement('dialog');
  dialog.id='desktopModelsDialog';dialog.className='desktop-models-dialog';
  dialog.setAttribute('aria-labelledby','desktopModelsTitle');
  dialog.innerHTML=`<header class="desktop-dialog-heading"><div><span class="eyebrow">LOCAL MODELS</span><h2 id="desktopModelsTitle">本机模型</h2><p>图片编辑与设计对话各自接入，模型文件由你选择。</p></div><button id="closeDesktopModels" class="tool-button icon-only" aria-label="关闭本机模型">×</button></header>
    <div class="desktop-service-grid"><section class="desktop-service-card"><span class="desktop-card-number">01 / IMAGE</span><h3>本机图像编辑</h3><p id="desktopImageState" class="desktop-state">正在读取配置…</p><p id="desktopImageDetail" class="field-hint"></p><button id="desktopImageSettings" class="button outline-button">设置本机图像接口</button></section><section class="desktop-service-card"><span class="desktop-card-number">02 / CONVERSATION</span><h3>本机设计对话</h3><p id="desktopChatState" class="desktop-state">正在读取配置…</p><p id="desktopChatDetail" class="field-hint"></p><button id="desktopChatSettings" class="button outline-button">设置本机对话接口</button></section></div>
    <form id="desktopModelDirectoryForm" class="desktop-directory"><div class="section-label">模型文件夹</div><label for="desktopModelDirectory">模型包目录</label><div class="desktop-directory-row"><input id="desktopModelDirectory" autocomplete="off" spellcheck="false" placeholder="例如 E:\\AI模型\\遗迹重构"><button id="desktopChooseDirectory" type="button" class="button outline-button" hidden>选择文件夹</button></div><p class="field-hint">可选择包含模型清单的文件夹，或扫描已有 safetensors。找到文件不代表服务已加载，也不证明兼容。</p><details class="desktop-advanced"><summary>原有 ComfyUI 服务 <span>可选</span></summary><label for="desktopComfyUrl">本机服务地址</label><input id="desktopComfyUrl" type="url" value="http://127.0.0.1:8189" required><p class="field-hint">保留原有 SD1.5 实验方式。使用本机兼容图像接口时，无需配置此项。</p></details><div class="desktop-directory-actions"><button id="desktopSaveDirectory" class="button primary-button">保存目录并扫描</button><button id="desktopRefreshModels" type="button" class="button outline-button">刷新文件与服务状态</button><button id="desktopOpenWorkspace" type="button" class="button text-button" hidden>打开工作目录</button></div></form>
    <section class="desktop-scan-section" aria-labelledby="desktopScanTitle"><div class="desktop-scan-heading"><h3 id="desktopScanTitle">本机文件与服务</h3><span id="desktopFileCount" class="desktop-count">未读取</span></div><p id="desktopComfyState" class="field-hint"></p><div id="desktopModelList" class="desktop-model-list"></div><div id="desktopModelWarnings" class="desktop-model-warnings"></div></section>
    <p id="desktopModelsFeedback" class="desktop-feedback" role="status" aria-live="polite"></p><footer class="desktop-dialog-footer">此应用未附带图片或对话模型。扫描与连接检查不会下载模型、启动服务或生成图片。</footer>`;
  document.body.append(dialog);
  function nativeApi(){return global.pywebview?.api||{};}
  function updateNativeButtons(){byId('desktopChooseDirectory').hidden=typeof nativeApi().choose_model_directory!=='function';byId('desktopOpenWorkspace').hidden=typeof nativeApi().open_workspace!=='function';}
  function setBusy(value){reading=value;dialog.querySelectorAll('form input,form button').forEach(element=>element.disabled=value);}
  function showService(info,type){
    const image=type==='Image',local=info?.provider==='local_openai';
    byId('desktop'+type+'State').textContent=local&&info.ready?'本机接口已配置 · 能力尚未验证':local?'本机接口待配置':'尚未选择本机服务';
    byId('desktop'+type+'Detail').textContent=local?[info.model?`模型：${info.model}`:'尚未填写模型名称',info.baseUrl||'尚未填写本机地址',image?'须支持图像编辑接口；不以对话模型代替。':'可接 Ollama 或 LM Studio。图片输入需模型明确支持。'].join(' · '):(image?'先安装并启动图像编辑服务，再填写它提供的本机地址与模型。':'先安装并启动对话服务，再选择已经加载的对话模型。');
  }
  function paintSnapshot(data,fillForm){
    snapshot=data;
    const settings=data.scan?.settings||{};
    if(fillForm){byId('desktopModelDirectory').value=settings.modelDir||'';byId('desktopComfyUrl').value=settings.comfyUrl||'http://127.0.0.1:8189';}
    showService(data.image,'Image');showService(data.chat,'Chat');
    const files=Array.isArray(data.scan?.models)?data.scan.models:[],found=files.filter(item=>item.exists===true);
    byId('desktopFileCount').textContent=`找到 ${found.length} 个文件`;
    byId('desktopModelList').innerHTML=files.length?files.map(item=>`<article class="desktop-model-file"><div><strong>${esc(item.id||item.checkpointName||'未命名模型')}</strong><span class="desktop-file-status">${item.exists===true?'文件已找到':'未找到文件'}</span></div><p>${esc(item.architecture||'架构未确认')} · ${esc(({base:'基础模型',checkpoint:'基础模型',lora:'LoRA',discovered:'待确认文件'})[item.kind]||item.kind||'类型未确认')}</p><small>${esc(item.file||item.checkpointName||'未提供文件路径')}</small>${item.source==='discovered_safetensors'?'<small>扫描得到的文件，尚未确认用途与兼容性。</small>':''}</article>`).join(''):'<p class="desktop-empty">当前未找到模型文件。可以选择已有模型包目录；应用不会自动下载。</p>';
    const service=data.scan?.service?.comfy;
    byId('desktopComfyState').textContent=service?`原有 ComfyUI：${service.available===true?'服务已响应，仍需核对模型兼容性':service.reason||'未连接'}${service.url?' · '+service.url:''}`:'尚未检查原有 ComfyUI 服务。';
    const warnings=[...(Array.isArray(data.scan?.warnings)?data.scan.warnings:[]),...data.errors];
    byId('desktopModelWarnings').replaceChildren(...warnings.map(value=>{const p=document.createElement('p');p.textContent=typeof value==='string'?value:JSON.stringify(value);return p;}));
  }
  async function readSettings({probe=false,fillForm=false}={}){
    const request=++serial;setBusy(true);byId('desktopModelsFeedback').textContent=probe?'正在扫描本机文件并检查原有服务，不会启动或生成。':'正在读取本机配置…';
    const paths=['/api/local-models'+(probe?'?probe=true':''),'/api/settings/ai','/api/assistant/settings'];
    const results=await Promise.allSettled(paths.map(path=>api(path)));
    if(request!==serial)return;
    const data={errors:[],scan:null,image:null,chat:null};
    ['scan','image','chat'].forEach((key,index)=>{const result=results[index];if(result.status==='fulfilled')data[key]=result.value;else data.errors.push(({scan:'模型目录',image:'图像设置',chat:'对话设置'})[key]+'读取失败：'+result.reason.message);});
    paintSnapshot(data,fillForm);setBusy(false);
    byId('desktopModelsFeedback').textContent=data.errors.length?'部分状态未能读取，可刷新重试。':'文件扫描与设置已读取；未执行模型推理。';
    updateNativeButtons();
  }
  async function openDesktopModels(){if(dialog.open)return;dialog.showModal();updateNativeButtons();byId('closeDesktopModels').focus();await readSettings({fillForm:true});}
  byId('closeDesktopModels').onclick=()=>dialog.close();
  byId('desktopRefreshModels').onclick=()=>readSettings({probe:true});
  byId('desktopModelDirectoryForm').onsubmit=async event=>{
    event.preventDefault();if(reading)return;setBusy(true);byId('desktopModelsFeedback').textContent='正在保存非密钥目录设置…';
    try{await api('/api/settings/local-models',{method:'POST',body:JSON.stringify({modelDir:byId('desktopModelDirectory').value.trim(),comfyUrl:byId('desktopComfyUrl').value.trim()})});await readSettings({probe:true,fillForm:true});}
    catch(error){setBusy(false);byId('desktopModelsFeedback').textContent='没有保存成功：'+error.message;}
  };
  byId('desktopChooseDirectory').onclick=async()=>{
    const choose=nativeApi().choose_model_directory;if(typeof choose!=='function')return;
    try{const path=await choose();if(typeof path==='string'&&path.trim()){byId('desktopModelDirectory').value=path;byId('desktopModelsFeedback').textContent='文件夹已选择，点击“保存目录并扫描”后读取。';}}
    catch(error){byId('desktopModelsFeedback').textContent='未能选择文件夹：'+error.message;}
  };
  byId('desktopOpenWorkspace').onclick=async()=>{try{await nativeApi().open_workspace();}catch(error){byId('desktopModelsFeedback').textContent='工作目录未打开：'+error.message;}};
  byId('desktopImageSettings').onclick=()=>{dialog.close();if(typeof openAiSettings==='function')openAiSettings('local_openai');};
  byId('desktopChatSettings').onclick=()=>{dialog.close();if(typeof global.openCoAssistantSettings==='function')global.openCoAssistantSettings('local_openai');};
  global.addEventListener('pywebviewready',updateNativeButtons);
  global.addEventListener('models:settings-changed',()=>{if(dialog.open)readSettings();});
  const actions=document.querySelector('.header-actions');
  if(actions&&!byId('desktopModelsButton')){const button=document.createElement('button');button.id='desktopModelsButton';button.className='button text-button';button.textContent='本机模型';button.onclick=openDesktopModels;actions.prepend(button);}
  global.openDesktopModels=openDesktopModels;
})(window);
