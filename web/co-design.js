/* Preparation, a user-confirmed design companion, and real sample records. */
(function (global) {
  'use strict';
  const TYPES = {blood:'血迹', slash:'割裂', wear:'磨损', burn:'焦痕'};
  const OUTCOMES = {unreviewed:'还没有比较', satisfactory:'接近想要的效果', bright:'太亮或太艳', spread:'渗开的范围过大', stiff:'干燥后变硬', other:'其他，写在备注里'};
  const FALLBACK = {
    blood:{title:'先试血迹的颜色与边缘', tools:'同材质废布或可拆布片、海绵或旧刷、与载体相容的颜料', steps:['先在独立载体上试一小块颜色，等干燥后再和预览比较。','用点拍或少量擦染形成主次，逐次补充，先别覆盖大面积。','核对边缘是否渗开、干后是否太亮、颜色是否影响角色主要配色。'], cautions:['布用颜料和戏剧假血不一定能洗掉。需要恢复时，先做在可拆载体上。']},
    slash:{title:'先确认破口是否真的要剪', tools:'废布、剪刀、针线、可拆补丁或内衬', steps:['在废布或可拆补丁上模拟一个小破口，比较开口方向与服装褶皱。','少量处理边缘，再检查毛边、底层露出与穿着后的形状。','确认满意后，再决定保持补丁方案，还是处理原衣。'], cautions:['接缝、扣眼、受力部位先保留。无法恢复的剪裁要单独确认。']},
    wear:{title:'用层次表现磨损', tools:'废布、海绵、旧刷、适合载体的浅深色颜料', steps:['先在独立载体上少量擦染，试出褪色、擦痕或毛边的视觉层次。','一次只增加一点，退远查看，避免均匀铺满整个区域。','比较远距离场照和近距离细节，两种距离都合适再继续。'], cautions:['皮革或涂层面料先核对相容性，不直接照搬织物的抽丝做法。']},
    burn:{title:'用颜色模拟焦痕', tools:'废布或可拆补丁、海绵、深棕与灰黑色颜料', steps:['用颜色与仿焦边材质制作小样，先建立由浅到深的边缘。','逐次调整中心与边缘的深浅，避免只剩一块均匀黑色。','比较角色纹样、服装轮廓与焦痕的关系，保留辨识细节。'], cautions:['这里制作视觉模拟，不需要对衣物点火或热处理。']}
  };
  const runtime = {connection:null,connectionLoading:false,connectionError:'',chatBusy:false,chatError:'',draft:'',requestSerial:0,configOpen:false,library:null,libraryLoading:false,libraryError:'',sampleBusy:false,sampleError:'',makingRegion:'all',researchBusy:false,researchError:''};
  const q = (selector, parent=document) => parent.querySelector(selector);
  const qq = (selector, parent=document) => [...parent.querySelectorAll(selector)];
  const esc = value => escapeHtml(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const urlOf = value => typeof value==='string'&&value.trim()?safeUrl(value):'';
  const list = value => Array.isArray(value) ? value : value ? [value] : [];
  const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(text).filter(Boolean).join('；') : value && typeof value === 'object' ? String(value.text || value.description || value.excerpt || value.evidence || value.name || value.value || '') : '';
  const locked = () => typeof quickLocked === 'function' && quickLocked();
  const change = (invalidate=true) => { dirty({invalidate}); };
  const rerender = () => { if(typeof render==='function')render(); };
  const notice = value => { if(typeof toast==='function')toast(value); };
  function ensureCoState() {
    if(!state.preparation||typeof state.preparation!=='object')state.preparation={};
    for(const [key,value] of Object.entries({productUrl:'',merchant:'',materialKind:'unknown',materialEvidence:[],lookupStatus:'idle',productText:''})){
      if(state.preparation[key]===undefined)state.preparation[key]=clone(value);
    }
    if(!['unknown','cloth','leatherlike'].includes(state.preparation.materialKind))state.preparation.materialKind='unknown';
    if(!state.coAssistant||typeof state.coAssistant!=='object')state.coAssistant={};
    if(!Array.isArray(state.coAssistant.searchResults))state.coAssistant.searchResults=[];
    if(typeof state.coAssistant.includeImage!=='boolean')state.coAssistant.includeImage=false;
    state.coAssistant.messages = list(state.coAssistant.messages).slice(-40);
    state.coAssistant.candidates = list(state.coAssistant.candidates).slice(-8);
    state.makingSamples = list(state.makingSamples).slice(-30);
    return state;
  }
  function identity() {
    const ref=typeof imageReference==='function'?imageReference():state.reference;
    return JSON.stringify({projectId:state.projectId,revision:state.revision,reference:ref?.url||ref?.id||'',characterId:state.characterId,scenarioId:state.scenarioId,
      preparation:state.preparation,reversibleRequired:state.reversibleRequired,customDamageIdea:state.customDamageIdea,
      brushSettings:state.brushSettings,brushStrokes:state.brushStrokes,damageItems:state.damageItems,protectedRects:state.protectedRects});
  }
  function sourceLinks(value, limit=4) {
    const entries=list(value).filter(entry=>entry&&typeof entry==='object').map(entry=>({...entry,url:urlOf(entry.url||entry.sourceUrl)})).filter(entry=>entry.url).slice(0,limit);
    return entries.length?`<ul class="co-sources">${entries.map(entry=>`<li><a href="${esc(entry.url)}" target="_blank" rel="noopener noreferrer">${esc(entry.title||'查看来源')}</a>${entry.evidence?`<small>${esc(text(entry.evidence))}</small>`:''}${entry.kind==='search_excerpt'?'<small>搜索摘要，未核对全文</small>':''}</li>`).join('')}</ul>`:'';
  }
  function materialNote() {
    const p=state.preparation;
    if(p.lookupStatus==='loading')return '<p class="co-note" role="status">正在读取商品说明…</p>';
    if(p.lookupStatus==='error')return `<p class="co-error" role="status">${esc(p.lookupError||'商品说明没有读取成功。')}可粘贴商家写出的成分，或暂时按未知继续。</p>`;
    if(!p.materialEvidence?.length)return '<p class="co-note">不知道面料也可以继续。后面先做独立小样，再核对实物。</p>';
    return `<div class="co-evidence"><strong>商品说明中的声明</strong>${p.materialEvidence.slice(0,5).map(item=>`<p>${esc(text(item))}</p>`).join('')}${list(p.componentEvidence).slice(0,4).map(item=>`<p>${esc(text(item))}</p>`).join('')}${sourceLinks(p.materialEvidence)}<small>这些是网页或你提供的文字，不是实物检测。</small></div>`;
  }
  function renderCoPrepare() {
    ensureCoState();const p=state.preparation,ref=imageReference(),busy=locked(),characters=list(catalog.characters);
    const sceneList=list(scenarios).filter(item=>!item.characterId||item.characterId===state.characterId);
    const ready=!!ref&&!!state.characterId&&!!state.scenarioId;
    return `<div class="co-prepare"><section class="co-section"><h3>从你的这件衣服开始</h3><p class="co-note">先留住原貌，再决定哪一部分值得改。</p><button id="uploadButton" class="co-upload" ${busy?'disabled':''}>${ref?.url?`<img src="${esc(safeUrl(ref.url))}" alt="当前服装底图">`:''}<span><strong>${ref?'更换服装照片':'上传服装照片'}</strong><small>穿着照或平铺照 · PNG / JPG / WebP</small></span></button>
      <div class="co-field"><span class="co-label">这件服装对应哪个角色？</span><div class="co-character-options">${characters.map(item=>`<button class="co-choice ${state.characterId===item.id?'is-selected':''}" data-co-character="${esc(item.id)}" aria-pressed="${state.characterId===item.id}" ${busy?'disabled':''}><strong>${esc(item.name)}</strong><small>${esc(item.game||'')}</small></button>`).join('')||'<p class="co-note">当前没有可核对剧情的角色资料。</p>'}</div></div></section>
      <section class="co-section"><details class="co-details co-product" ${p.productUrl||p.productText||p.merchant?'open':''}><summary>商家与材料，可稍后补充</summary><div class="co-field"><label for="coMerchant">商家或服装来源</label><input id="coMerchant" maxlength="160" value="${esc(p.merchant)}" placeholder="例如：商家名，或自己制作" ${busy?'disabled':''}></div><div class="co-field"><label for="coProductUrl">商品链接</label><input id="coProductUrl" type="url" maxlength="2000" value="${esc(p.productUrl)}" placeholder="粘贴商品详情页链接" ${busy?'disabled':''}></div><button id="coLookupMaterial" class="button outline-button full-width" ${busy||p.lookupStatus==='loading'?'disabled':''}>${p.lookupStatus==='loading'?'正在查找说明':'查找商品中的面料说明'}</button><details class="co-details"><summary>链接读不到？粘贴商品说明</summary><label for="coProductText" class="co-label">商家写出的成分或材质</label><textarea id="coProductText" maxlength="6000" rows="3" placeholder="粘贴原文，不需要自己判断材料术语。">${esc(p.productText)}</textarea></details>${materialNote()}</details>
      <fieldset class="co-fieldset"><legend>看起来属于哪一类？</legend>${[['unknown','暂时不知道'],['cloth','普通布料'],['leatherlike','皮革或有涂层的表面']].map(([value,label])=>`<label class="co-radio"><input name="coMaterialKind" type="radio" value="${value}" ${p.materialKind===value?'checked':''} ${busy?'disabled':''}><span>${label}</span></label>`).join('')}</fieldset><p class="co-note">材料暂时不知道也能开始，制作之前再核对。</p></section>
      <section class="co-section"><h3>选择故事中的一个方向</h3><p class="co-note">剧情资料帮助守住角色；痕迹的位置与程度由你来决定。</p>${!state.characterId?'<p class="co-empty">先选角色，再查看可核对的情境。</p>':sceneList.map(item=>`<article class="co-scene ${state.scenarioId===item.id?'is-selected':''}"><button data-co-scene="${esc(item.id)}" aria-pressed="${state.scenarioId===item.id}" ${busy?'disabled':''}><span class="co-scene-check" aria-hidden="true"></span><strong>${esc(item.title||item.name||'剧情情境')}</strong><p>${esc(item.summary||item.description||'')}</p></button><details class="co-details"><summary>查看依据与设计空间</summary><p><strong>资料记载</strong>${esc(text(factOf(item))||'尚无可核对的具体事件记录。')}</p><p><strong>设计推演</strong>${esc(text(item.damageEvidence||item.inference)||'服装痕迹的部位、面积和程度仍须你选择。')}</p>${sourceLinks(sourcesOf(item))}</details></article>`).join('')||'<p class="co-empty">当前角色还没有剧情资料，不会自动编造情境。</p>'}
      <details class="co-details"><summary>补充我想表现的感觉</summary><label for="coStoryIdea" class="co-label">只改衣服上的痕迹与程度</label><textarea id="coStoryIdea" rows="3" maxlength="1500" placeholder="例如：像刚结束战斗，领口徽章保留，袖口有少量磨损。">${esc(state.customDamageIdea)}</textarea></details></section>
      <section class="co-section"><fieldset class="co-fieldset"><legend>这件衣服以后还想恢复原状吗？</legend>${[[true,'希望能恢复原状'],[false,'可以保留这次改动'],['unknown','看完方案再决定']].map(([value,label])=>`<label class="co-radio"><input type="radio" name="coRecovery" value="${String(value)}" ${state.reversibleRequired===value?'checked':''} ${busy?'disabled':''}><span>${label}</span></label>`).join('')}</fieldset></section><button id="coStartDesign" class="button primary-button full-width" ${!ready||busy?'disabled':''}>一起设计这件服装</button><p class="co-note">${ready?'先画出你想要的痕迹，助手的建议由你决定是否采用。':'上传照片并选择角色、剧情方向后开始。'}</p></div>`;
  }
  function bindCoPrepare() {
    ensureCoState();const pane=q('.co-prepare');if(!pane)return;
    for(const [id,key] of [['coMerchant','merchant'],['coProductUrl','productUrl'],['coProductText','productText']])q('#'+id,pane)?.addEventListener('input',event=>{state.preparation[key]=event.target.value;if(key==='merchant')state.uploadMerchant=event.target.value;state.preparation.lookupStatus='idle';state.preparation.materialEvidence=[];change();});
    qq('[data-co-character]',pane).forEach(button=>button.onclick=()=>{if(locked())return;state.characterId=button.dataset.coCharacter;state.scenarioId='';change();rerender();});
    qq('[data-co-scene]',pane).forEach(button=>button.onclick=()=>{if(locked())return;state.scenarioId=button.dataset.coScene;change();rerender();});
    qq('[name=coMaterialKind]',pane).forEach(input=>input.onchange=()=>{state.preparation.materialKind=input.value;change();});
    qq('[name=coRecovery]',pane).forEach(input=>input.onchange=()=>{state.reversibleRequired=input.value==='true'?true:input.value==='false'?false:'unknown';change();});
    q('#coStoryIdea',pane)?.addEventListener('input',event=>{state.customDamageIdea=event.target.value;state.customDamageEnabled=true;change();});
    q('#coLookupMaterial',pane).onclick=lookupMaterials;
  }
  async function lookupMaterials() {
    const p=state.preparation;if(locked()||p.lookupStatus==='loading')return;
    if(!p.productUrl.trim()&&!p.productText.trim()){notice('粘贴商品链接，或展开并粘贴商品说明。');return;}
    const captured=JSON.stringify([p.productUrl,p.productText,p.merchant]);p.lookupStatus='loading';rerender();
    try {const data=await api('/api/materials/lookup',{method:'POST',body:JSON.stringify({url:p.productUrl.trim()||undefined,text:p.productText.trim()||undefined,merchant:p.merchant})});
      if(JSON.stringify([state.preparation.productUrl,state.preparation.productText,state.preparation.merchant])!==captured)return;
      const evidence=list(data.evidence).map(item=>typeof item==='string'?{text:item,...(data.source?.url?{url:data.source.url,title:'商品说明来源'}:{})}:item).concat(list(data.materials).map(item=>typeof item==='string'?{text:item}:item));
      state.preparation.materialEvidence=evidence.slice(0,10);state.preparation.componentEvidence=list(data.components).slice(0,10);state.preparation.lookupStatus=data.status==='declared'?'declared':'unknown';state.preparation.lookupNotes=text(data.notes);state.preparation.lookupError='';change();
    } catch(error){if(JSON.stringify([state.preparation.productUrl,state.preparation.productText,state.preparation.merchant])===captured){state.preparation.lookupStatus='error';state.preparation.lookupError=error.message;}}
    finally{rerender();}
  }
  function brushContext() {
    const s=state.brushSettings||{};return `${TYPES[s.type]||'尚未选择'}画笔 · ${Math.round(Number(s.opacity??.88)*100)}% 程度 · ${list(state.brushStrokes).filter(item=>item.type!=='erase').length} 笔痕迹`;
  }
  function candidateHtml(candidate,index) {
    const stale=candidate.context!==identity(),action=candidate.action;
    return `<article class="co-candidate"><strong>${esc(action.label||`${action.type==='set_brush'?'选用':'调整'}${TYPES[action.brushType]||'痕迹'}`)}</strong><p>${esc(action.reason||'先比较这个方向，再决定是否采用。')}</p><button class="button outline-button" data-co-apply="${index}" ${stale||locked()?'disabled':''}>${stale?'方案已变化，重新提问':'采用这条建议'}</button>${stale?'<small>这条建议属于提问时的旧版本。</small>':''}</article>`;
  }
  function renderCoAssistant() {
    ensureCoState();const data=state.coAssistant,connection=runtime.connection,scene=typeof scenario==='function'?scenario():null;
    const connected=connection?.ready===true;
    return `<section class="co-assistant"><header class="co-assistant-head"><div><h2>一起把想法落到衣服上</h2><p>${connected?(connection.provider==='local_openai'?'本机 AI 对话 · 接口已配置':'共创 AI · 接口已配置'):'资料建议 · 尚未接入 AI 对话'}</p></div><button id="coOpenConnection" class="co-icon-button" aria-label="设置共创助手">${typeof icon==='function'?icon('settings'):'设置'}</button></header><div class="co-context"><strong>${esc(scene?.title||'先在左侧选一个剧情方向')}</strong><span>${esc(brushContext())}</span></div>${!connected?'<p class="co-note co-local-note">现在可以查看本地资料建议。接入对话服务后，再让 AI 结合你的方案讨论。</p>':''}${runtime.connectionError?`<p class="co-error">${esc(runtime.connectionError)}</p>`:''}
      <div class="co-conversation" aria-live="polite" aria-busy="${runtime.chatBusy}">${data.messages.length?data.messages.slice(-20).map(message=>`<article class="co-message ${message.role==='user'?'co-message-user':''}"><span>${message.role==='user'?'我':message.mode==='cloud'?'共创 AI':message.mode==='local_model'?'本机 AI':'资料建议'}</span><p>${esc(message.content)}</p>${sourceLinks(message.sources,3)}${message.imageSent?'<small>本次已发送服装照片</small>':''}</article>`).join(''):'<div class="co-chat-intro"><p>哪里值得保留，哪里可以改？</p><p class="co-note">说出你不满意的地方，也可以先问一个具体问题。</p></div>'}${runtime.chatBusy?'<p class="co-pending" role="status">正在整理建议…</p>':''}</div>
      ${data.candidates.length?`<div class="co-candidates"><h3>建议先放在这里</h3>${data.candidates.map(candidateHtml).join('')}</div>`:''}${runtime.chatError?`<p class="co-error" role="status">${esc(runtime.chatError)}</p>`:''}
      <div class="co-quick-questions">${['推荐先改哪一处？','血迹颜色怎么更自然？','这个效果要怎样做出来？'].map(value=>`<button data-co-question="${esc(value)}" ${runtime.chatBusy||locked()?'disabled':''}>${esc(value)}</button>`).join('')}</div><form id="coChatForm" class="co-chat-form"><label for="coChatMessage" class="sr-only">向共创助手提问</label><textarea id="coChatMessage" rows="3" maxlength="2500" placeholder="例如：我怕破口太多会不像角色，哪里应该收住？" ${runtime.chatBusy?'disabled':''}>${esc(runtime.draft)}</textarea><div class="co-chat-footer"><label class="co-image-opt"><input id="coIncludeImage" type="checkbox" ${data.includeImage?'checked':''} ${!connected||!connection.vision||runtime.chatBusy?'disabled':''}>发送服装照片</label><button type="submit" class="button co-send" ${runtime.chatBusy||locked()?'disabled':''}>${runtime.chatBusy?'正在回复':'发送'}</button></div>${!connection?.vision?'<small>当前助手仅接收文字和方案信息，不会假装看过照片。</small>':''}</form>
      <details class="co-details co-research"><summary>再找一些公开参考</summary><form id="coResearchForm"><label for="coResearchQuery" class="sr-only">公开资料关键词</label><div class="co-search-row"><input id="coResearchQuery" maxlength="180" placeholder="角色剧情、血迹小样、服装做旧"><button class="button outline-button" ${runtime.researchBusy?'disabled':''}>${runtime.researchBusy?'查找中':'查找'}</button></div></form>${runtime.researchError?`<p class="co-error">${esc(runtime.researchError)}</p>`:''}${data.searchResults.length?`<p class="co-note">以下为搜索摘要，打开原文核对后再采用。</p>${sourceLinks(data.searchResults,6)}`:''}</details></section>`;
  }
  function refreshAssistant() {
    const pane=q('#coAssistantPane');if(pane){const scrolled=q('.co-conversation',pane);const old= scrolled?.scrollTop||0;pane.innerHTML=renderCoAssistant();bindCoAssistant();const next=q('.co-conversation',pane);if(next)next.scrollTop=old||next.scrollHeight;}
    else rerender();
  }
  function bindCoAssistant() {
    const pane=q('.co-assistant');if(!pane)return;
    q('#coOpenConnection',pane).onclick=openConnection;
    q('#coChatMessage',pane).oninput=event=>{runtime.draft=event.target.value;};
    q('#coIncludeImage',pane).onchange=event=>{state.coAssistant.includeImage=event.target.checked;change(false);};
    q('#coChatForm',pane).onsubmit=event=>{event.preventDefault();sendMessage(runtime.draft);};
    qq('[data-co-question]',pane).forEach(button=>button.onclick=()=>sendMessage(button.dataset.coQuestion));
    qq('[data-co-apply]',pane).forEach(button=>button.onclick=()=>applyCandidate(Number(button.dataset.coApply)));
    q('#coResearchForm',pane).onsubmit=event=>{event.preventDefault();findReferences(q('#coResearchQuery',pane).value);};
    if(!runtime.connection&&!runtime.connectionLoading&&!runtime.connectionError)loadConnection();
  }
  async function loadConnection() {
    runtime.connectionLoading=true;
    try{runtime.connection=await api('/api/assistant/settings');runtime.connectionError='';}
    catch(error){runtime.connectionError='助手设置暂时无法读取：'+error.message;}
    finally{runtime.connectionLoading=false;refreshAssistant();}
  }
  function safeAction(value) {
    if(!value||!['set_brush','adjust_effect'].includes(value.type)||!TYPES[value.brushType])return null;
    const action={type:value.type,brushType:value.brushType,label:String(value.label||'').slice(0,120),reason:String(value.reason||'').slice(0,900)};
    if(typeof value.color==='string'&&/^#[0-9a-f]{6}$/i.test(value.color))action.color=value.color;
    if(Number.isFinite(Number(value.opacity))&&value.opacity!==null)action.opacity=Math.min(1,Math.max(.05,Number(value.opacity)));
    if(Number.isFinite(Number(value.size))&&value.size!==null)action.size=Math.min(.2,Math.max(.015,Number(value.size)));
    if(Number.isFinite(Number(value.opacityScale))&&value.opacityScale!==null)action.opacityScale=Math.min(2,Math.max(.1,Number(value.opacityScale)));
    return action;
  }
  async function sendMessage(value) {
    ensureCoState();const message=String(value||'').trim();if(!message||runtime.chatBusy||locked())return;
    const context=identity(),serial=++runtime.requestSerial,conversation=state.coAssistant;
    const history=conversation.messages.slice(-12).map(item=>({role:item.role,content:item.content}));
    conversation.messages.push({role:'user',content:message,createdAt:new Date().toISOString()});conversation.candidates=[];
    runtime.draft='';runtime.chatError='';runtime.chatBusy=true;change(false);refreshAssistant();
    try{const response=await api('/api/assistant/chat',{method:'POST',body:JSON.stringify({message,project:typeof projectPayload==='function'?projectPayload():{},history,includeImage:!!conversation.includeImage&&runtime.connection?.ready===true&&runtime.connection?.vision===true})});
      if(serial!==runtime.requestSerial)return;
      if(context!==identity()||state.coAssistant!==conversation){runtime.chatError='提问后方案已经变化，本次建议未应用。请针对当前版本重新提问。';return;}
      conversation.messages.push({role:'assistant',content:String(response.message||'没有返回可用建议。'),mode:['cloud','local_model'].includes(response.mode)?response.mode:'local',imageSent:response.imageSent===true,sources:list(response.sources).slice(0,6),createdAt:new Date().toISOString()});
      conversation.candidates=list(response.actions).map(safeAction).filter(Boolean).slice(0,6).map(action=>({action,context}));
      conversation.messages=conversation.messages.slice(-40);change(false);
    }catch(error){runtime.chatError='这次没有收到建议：'+error.message;}
    finally{runtime.chatBusy=false;refreshAssistant();}
  }
  function applyCandidate(index) {
    const candidate=state.coAssistant.candidates[index];if(!candidate||locked())return;
    if(candidate.context!==identity()){notice('方案已变化，请重新提问，避免应用旧建议。');refreshAssistant();return;}
    if(typeof global.applyCoAction==='function'){try{global.applyCoAction(clone(candidate.action));}catch(error){notice(error.message);return;}}
    else if(candidate.action.type==='set_brush'){
      const a=candidate.action;state.brushSettings={...(state.brushSettings||{}),type:a.brushType,...(a.color?{color:a.color}:{}),...(a.size!==undefined?{size:a.size}:{}),...(a.opacity!==undefined?{opacity:a.opacity}:{})};
      change(false);if(typeof selectBrush==='function')selectBrush(a.brushType);else rerender();
    }else{notice('这条建议尚不能直接修改已有痕迹，可先用画笔手动比较。');return;}
    state.coAssistant.candidates=[];change(false);refreshAssistant();notice('已采用这条建议。还可以继续调整。');
  }
  async function findReferences(value) {
    const query=String(value||'').trim();if(!query||runtime.researchBusy)return;
    runtime.researchBusy=true;runtime.researchError='';const context=identity();refreshAssistant();
    try{const response=await api('/api/research/search',{method:'POST',body:JSON.stringify({query})});if(context===identity()){state.coAssistant.searchResults=list(response.results).map(item=>({...item,kind:'search_excerpt'})).slice(0,6);change(false);}}
    catch(error){runtime.researchError='公开参考没有查到：'+error.message;}
    finally{runtime.researchBusy=false;refreshAssistant();}
  }
  function openConnection(providerOverride) {
    let dialog=q('#coConnectionDialog');
    if(!dialog){dialog=document.createElement('dialog');dialog.id='coConnectionDialog';dialog.className='co-dialog';document.body.append(dialog);}
    const current=runtime.connection||{};
    const c=providerOverride&&providerOverride!==current.provider?{provider:providerOverride}:current;
    const local=c.provider==='local_openai';
    dialog.innerHTML=`<form id="coConnectionForm"><header><div><h2>共创助手</h2><p class="co-note">本机对话、云端对话与图像编辑分别设置。</p></div><button type="button" id="coConnectionClose" class="co-icon-button" aria-label="关闭助手设置">×</button></header>
      <div class="co-field"><label for="coAssistantProvider">对话服务</label><select id="coAssistantProvider"><option value="deepseek" ${c.provider==='deepseek'?'selected':''}>DeepSeek · 云端对话</option><option value="openai_compatible" ${c.provider==='openai_compatible'?'selected':''}>兼容接口 · 云端对话</option><option value="local_openai" ${local?'selected':''}>本机对话 · Ollama / LM Studio</option></select></div>
      <div class="co-field"><label for="coAssistantBase">接口地址</label><input id="coAssistantBase" type="url" maxlength="2000" value="${esc(c.baseUrl||(local?'http://127.0.0.1:11434/v1':'https://api.deepseek.com/v1'))}" required placeholder="${local?'http://127.0.0.1:11434/v1':'https://服务地址/v1'}"><small id="coAssistantBaseHint">${local?'只接收本机 loopback 地址。Ollama 通常使用 11434，LM Studio 通常使用 1234。':'只填写你确认可信的 HTTPS 服务地址。'}</small></div>
      <div class="co-field"><label for="coAssistantModel">对话模型名称</label><input id="coAssistantModel" maxlength="160" value="${esc(c.model||(local?'':'deepseek-flash'))}" placeholder="${local?'填写本机服务实际已加载的对话模型 ID':''}" required><small>对话模型提供建议，不直接生成服装图片。</small></div>
      <div class="co-field"><label for="coAssistantKey">API Key <span id="coAssistantKeyOptional">${local?'· 可选':''}</span></label><input id="coAssistantKey" type="password" autocomplete="off" spellcheck="false" maxlength="1024" placeholder="${local?'本机服务不要求时留空':c.hasKey?'已在本次运行中配置，留空保留':'粘贴对话服务提供的密钥'}"><small id="coAssistantKeyHint">${local?'不会沿用任何云端密钥。本机推理使用电脑资源，当前安装包不附带对话模型。':'仅用于当前运行，不保存到草稿。云端 API 服务可能单独计费。'}</small></div>
      <details class="co-details"><summary>图片输入设置</summary><label class="co-radio"><input id="coAssistantVision" type="checkbox" ${c.vision?'checked':''}><span>此对话模型支持接收图片</span></label><p class="co-note">须先核对模型与服务的图片输入能力。开启后，聊天时仍由你选择是否发送服装照片；未开启时只发送文字和方案。</p></details>
      <p id="coConnectionFeedback" class="co-note" role="status">${c.ready?'地址与模型已配置；尚未验证实际对话。':'保存设置不会安装、下载、启动模型或发起对话。'}</p><footer><button id="coClearConnection" type="button" class="button text-button">清除本次密钥</button><button id="coSaveConnection" class="button primary-button">保存助手设置</button></footer></form>`;
    const field=id=>q('#'+id,dialog);
    field('coConnectionClose').onclick=()=>dialog.close();
    dialog.onclose=()=>{field('coAssistantKey').value='';};
    field('coAssistantProvider').onchange=event=>{
      const provider=event.target.value,isLocal=provider==='local_openai';
      field('coAssistantBase').value=provider==='deepseek'?'https://api.deepseek.com/v1':isLocal?'http://127.0.0.1:11434/v1':'';
      field('coAssistantBase').placeholder=isLocal?'http://127.0.0.1:11434/v1':'https://服务地址/v1';
      field('coAssistantModel').value=provider==='deepseek'?'deepseek-flash':'';
      field('coAssistantModel').placeholder=isLocal?'填写本机服务实际已加载的对话模型 ID':'';
      field('coAssistantKey').value='';field('coAssistantKey').placeholder=isLocal?'本机服务不要求时留空':'粘贴所选对话服务提供的密钥';
      field('coAssistantKeyOptional').textContent=isLocal?'· 可选':'';
      field('coAssistantBaseHint').textContent=isLocal?'只接收本机 loopback 地址。Ollama 通常使用 11434，LM Studio 通常使用 1234。':'只填写你确认可信的 HTTPS 服务地址。';
      field('coAssistantKeyHint').textContent=isLocal?'不会沿用任何云端密钥。本机推理使用电脑资源，当前安装包不附带对话模型。':'仅用于当前运行，不保存到草稿。云端 API 服务可能单独计费。';
      field('coAssistantVision').checked=false;
      field('coConnectionFeedback').textContent='保存设置不会安装、下载、启动模型或发起对话。';
    };
    field('coConnectionForm').onsubmit=async event=>{
      event.preventDefault();const button=field('coSaveConnection'),feedback=field('coConnectionFeedback'),keyField=field('coAssistantKey');button.disabled=true;feedback.textContent='正在保存助手设置…';
      const payload={provider:field('coAssistantProvider').value,baseUrl:field('coAssistantBase').value.trim(),model:field('coAssistantModel').value.trim(),vision:field('coAssistantVision').checked};if(keyField.value.trim())payload.apiKey=keyField.value.trim();
      try{runtime.connection=await api('/api/assistant/settings',{method:'POST',body:JSON.stringify(payload)});runtime.connectionError='';dialog.close();refreshAssistant();notice('共创助手设置已保存，尚未验证实际对话。');}
      catch(error){feedback.textContent=error.message;}
      finally{keyField.value='';delete payload.apiKey;button.disabled=false;global.dispatchEvent(new Event('models:settings-changed'));}
    };
    field('coClearConnection').onclick=async()=>{
      field('coAssistantKey').value='';
      try{runtime.connection=await api('/api/assistant/settings?provider='+encodeURIComponent(field('coAssistantProvider').value),{method:'DELETE'});field('coConnectionFeedback').textContent='本次运行中该服务的密钥已清除。';refreshAssistant();}
      catch(error){field('coConnectionFeedback').textContent=error.message;}
    };
    dialog.showModal();field('coAssistantProvider').focus();
  }
  function craftGroups() {
    const previous=list(state.makingDesignHistory),currentStrokes=state.brushStrokes,currentItems=state.damageItems;
    // Adopted AI images become the next base; retain their making regions in the manual.
    const strokes=[...previous.flatMap(p=>list(p.brushStrokes)),...list(currentStrokes)],items=[...previous.flatMap(p=>list(p.damageItems)),...list(currentItems)];
    const groups={};for(const item of items){if(TYPES[item.type]){(groups[item.type]||(groups[item.type]=[])).push({kind:'region',id:item.id,rect:item.rect,label:`编号区域 ${String(items.indexOf(item)+1).padStart(2,'0')}`});}}
    strokes.forEach((stroke,index)=>{if(TYPES[stroke.type]){const points=list(stroke.points).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));const xs=points.map(p=>p.x),ys=points.map(p=>p.y);const r=points.length?{x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)}:null;(groups[stroke.type]||(groups[stroke.type]=[])).push({kind:'stroke',id:stroke.id||'stroke-'+index,rect:r,label:`第 ${index+1} 笔`});}});
    return groups;
  }
  function position(value) {const r=value?.rect;return r?`横向 ${Math.round(r.x*100)}–${Math.round((r.x+r.w)*100)}%，纵向 ${Math.round(r.y*100)}–${Math.round((r.y+r.h)*100)}%`:'位置见画布中的痕迹';}
  function craftItems() {return Object.entries(craftGroups()).map(([type,regions])=>({type,regions,...FALLBACK[type],...(list(runtime.library?.items).find(item=>item.type===type)||{})}));}
  function renderCoMaking() {
    ensureCoState();const items=craftItems(),samples=state.makingSamples,p=state.preparation,unknown=p.materialKind==='unknown';
    return `<div class="co-making"><section class="co-section"><h3>把预览变成一个小样</h3><p class="co-note">先比较真实材料上的颜色、边缘和手感，再决定要不要动原衣。</p><div class="co-making-constraint"><strong>${state.reversibleRequired===true?'保留恢复原状的选择':state.reversibleRequired===false?'允许保留改动，仍先试样':'恢复要求还没确定'}</strong><p>${state.reversibleRequired===false?'不可恢复的裁切与染色，最后再确认。':'先用可拆布片、补丁或其他独立载体；不把“可以洗掉”当成恢复保证。'}</p>${unknown?'<p>面料尚未知：先核对商家说明，当前建议只作为试样方向。</p>':`<p>${p.materialKind==='leatherlike'?'皮革或涂层表面：先检查颜料和胶的相容性，避免直接抽丝或磨穿。':'普通布料：先比较透染、毛边与干燥后的手感。'}</p>`}</div></section>
      ${items.length?`<div class="co-field"><label for="coMakingRegion">本次先做哪一处？</label><select id="coMakingRegion"><option value="all">查看整套方案</option>${items.flatMap(item=>item.regions.map(region=>`<option value="${esc(region.id)}" ${runtime.makingRegion===region.id?'selected':''}>${TYPES[item.type]} · ${esc(region.label)}</option>`)).join('')}</select></div>${items.map(item=>`<article class="co-craft-card" ${runtime.makingRegion!=='all'&&!item.regions.some(region=>region.id===runtime.makingRegion)?'hidden':''}><header><span class="co-effect-mark ${item.type}" aria-hidden="true"></span><div><h3>${esc(item.title||TYPES[item.type])}</h3><p>${esc(item.summary||'先做少量、可比较的小样。')}</p></div></header><p class="co-region-note">${item.regions.filter(region=>runtime.makingRegion==='all'||region.id===runtime.makingRegion).map(region=>`${esc(region.label)}：${esc(position(region))}`).join('<br>')}</p><p><strong>准备工具</strong>${esc(text(item.tools)||FALLBACK[item.type].tools)}</p><ol>${list(item.steps).slice(0,7).map(step=>`<li>${esc(text(step))}</li>`).join('')}</ol><div class="co-craft-check"><strong>做完再检查</strong><p>比预览更亮吗？边缘渗开了吗？干后变硬了吗？远看还认得出角色吗？</p>${list(item.cautions).slice(0,5).map(value=>`<p>${esc(text(value))}</p>`).join('')}</div>${sourceLinks(item.sources)}<small class="co-note">${list(item.photos).length?'资料照片仅作参考。':'还没有本项目的真实试样照片，下面可以记录你做出的结果。'}</small></article>`).join('')}`:'<p class="co-empty">画出至少一种痕迹后，这里会对应整理制作方向。</p>'}
      ${runtime.libraryError?`<p class="co-error">${esc(runtime.libraryError)}<button id="coRetryLibrary" class="button text-button">重新读取资料</button></p>`:''}<section class="co-section co-sample-records"><h3>记录真实试样</h3><p class="co-note">上传自己做的小样，写下与预览不同的地方。</p><form id="coSampleForm"><div class="co-field"><label for="coSampleType">这张小样对应什么？</label><select id="coSampleType">${Object.entries(TYPES).map(([type,label])=>`<option value="${type}">${label}</option>`).join('')}</select></div><div class="co-field"><label for="coSampleFile">小样照片</label><input id="coSampleFile" type="file" accept="image/png,image/jpeg,image/webp" required ${runtime.sampleBusy?'disabled':''}></div><div class="co-field"><label for="coSampleOutcome">试样以后发现了什么？</label><select id="coSampleOutcome">${Object.entries(OUTCOMES).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></div><div class="co-field"><label for="coSampleNotes">补充观察<span class="co-optional">可选</span></label><textarea id="coSampleNotes" maxlength="1500" rows="2" placeholder="例如：干后颜色更暗，边缘比图片渗得开。"></textarea></div><button class="button outline-button full-width" ${runtime.sampleBusy?'disabled':''}>${runtime.sampleBusy?'正在保存小样':'保存这次试样记录'}</button><p id="coSampleFeedback" class="${runtime.sampleError?'co-error':'co-note'}" role="status">${esc(runtime.sampleError)}</p></form>${samples.length?`<div class="co-samples">${samples.map((sample,index)=>`<article><img src="${esc(safeUrl(sample.reference?.url))}" alt="${esc(TYPES[sample.type]||'服装')}真实小样" loading="lazy"><div><strong>${esc(TYPES[sample.type]||'试样')} · ${esc(OUTCOMES[sample.outcome]||'待比较')}</strong><p>${esc(sample.notes||'未补充观察')}</p><button data-co-remove-sample="${index}" class="button text-button">移除这条记录</button></div></article>`).join('')}</div>`:'<p class="co-empty">还没有真实试样记录。</p>'}</section><button id="coPrintMaking" class="button primary-button full-width">下载可打印的制作清单</button><p class="co-note">清单包含区域、资料来源和试样记录。图像预览不预测材料的实际反应。</p></div>`;
  }
  function bindCoMaking() {
    const pane=q('.co-making');if(!pane)return;
    q('#coMakingRegion',pane)?.addEventListener('change',event=>{runtime.makingRegion=event.target.value;rerender();});
    q('#coSampleForm',pane).onsubmit=saveSample;
    qq('[data-co-remove-sample]',pane).forEach(button=>button.onclick=()=>{state.makingSamples.splice(Number(button.dataset.coRemoveSample),1);change(false);rerender();});
    q('#coPrintMaking',pane).onclick=printMaking;
    q('#coRetryLibrary',pane)?.addEventListener('click',()=>{runtime.library=null;runtime.libraryError='';loadLibrary();});
    if(!runtime.library&&!runtime.libraryLoading&&!runtime.libraryError)loadLibrary();
  }
  async function loadLibrary() {
    runtime.libraryLoading=true;try{runtime.library=await api('/api/craft/library');}catch(error){runtime.libraryError='资料库暂时无法读取，当前显示基础试样方向：'+error.message;}finally{runtime.libraryLoading=false;rerender();}
  }
  async function saveSample(event) {
    event.preventDefault();if(runtime.sampleBusy)return;const form=event.currentTarget,file=q('#coSampleFile',form).files[0];if(!file)return;
    if(file.size>20*1024*1024){q('#coSampleFeedback',form).textContent='照片超过 20 MB，请先缩小。';return;}
    const context=identity(),record={type:q('#coSampleType',form).value,notes:q('#coSampleNotes',form).value,outcome:q('#coSampleOutcome',form).value,materialKind:state.preparation.materialKind,createdAt:new Date().toISOString()};
    runtime.sampleBusy=true;runtime.sampleError='';q('#coSampleFeedback',form).textContent='正在保存小样照片…';q('button[type=submit],button',form).disabled=true;
    try{const body=new FormData();body.append('file',file);const reference=await api('/api/uploads',{method:'POST',body});if(identity()!==context)throw Error('上传时方案已经改变，未把照片关联到当前方案。');state.makingSamples.push({...record,reference});change(false);notice('真实试样已记录。');}
    catch(error){runtime.sampleError=error.message;}
    finally{runtime.sampleBusy=false;rerender();}
  }
  async function printMaking() {
    const items=craftItems(),reference=imageReference(),photos=new Map();let image='';
    async function embed(url,guide=false){
      const resolved=new URL(url,location.origin);if(resolved.origin!==location.origin)throw Error('制作清单只打包平台内的照片。');
      const photo=new Image();photo.src=resolved.href;await photo.decode();
      const source=guide&&window.BattleBrushEngine?BattleBrushEngine.renderGuide(photo,state.brushStrokes||[],state.protectedRects||[]):photo;
      const w=source.naturalWidth||source.width,h=source.naturalHeight||source.height,scale=Math.min(1,1200/Math.max(w,h));
      const c=document.createElement('canvas');c.width=Math.round(w*scale);c.height=Math.round(h*scale);c.getContext('2d').drawImage(source,0,0,c.width,c.height);return c.toDataURL('image/jpeg',.88);
    }
    try{const valid=typeof currentVisualValid==='function'&&currentVisualValid();if(reference?.url)image=await embed(valid&&state.previewUrl?state.previewUrl:reference.url,!valid);for(const sample of state.makingSamples){if(sample.reference?.url)photos.set(sample.reference.url,await embed(sample.reference.url));}}catch(error){notice('制作清单未完成：'+error.message);return;}
    const content=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(state.title||'遗迹重构')} · 制作清单</title><style>body{font:15px/1.8 sans-serif;color:#19363e;max-width:850px;padding:28px;margin:auto}h1{font-size:28px}h2{margin-top:32px}p{margin:8px 0}img{max-width:100%;max-height:400px;object-fit:contain}li{margin:8px 0}.photos{display:flex;flex-wrap:wrap;gap:20px}.photos img{max-height:200px;width:200px}a{color:#1e5e70}.print{padding:12px 20px;font:inherit;background:#183b45;color:white;border:0}@media print{.print{display:none}article{break-inside:avoid}body{padding:0}}</style><button class="print" onclick="window.print()">打印或另存为 PDF</button><h1>${esc(state.title||'我的战损方案')} · 制作清单</h1><p>角色：${esc(character()?.name||'未选')}　情境：${esc(scenario()?.title||'未选')}</p><p>${state.reversibleRequired===false?'允许保留改动；不可恢复的剪裁最后确认。':'恢复要求待保留：先用可拆载体试样，不保证颜料能洗掉。'}</p>${image?`<img src="${esc(image)}" alt="服装底图">`:''}<p>这是一份视觉方案与试样参考，不是材料物理预测。</p>${items.map(item=>`<article><h2>${esc(TYPES[item.type])}</h2><p>${item.regions.map(region=>`${esc(region.label)}：${esc(position(region))}`).join('<br>')}</p><p>工具：${esc(text(item.tools)||FALLBACK[item.type].tools)}</p><ol>${list(item.steps).map(step=>`<li>${esc(text(step))}</li>`).join('')}</ol>${list(item.cautions).map(value=>`<p>${esc(text(value))}</p>`).join('')}${sourceLinks(item.sources)}</article>`).join('')}<h2>真实试样记录</h2><div class="photos">${state.makingSamples.map(sample=>`<article><img src="${esc(photos.get(sample.reference?.url)||String())}" alt="真实试样"><p>${esc(TYPES[sample.type])}：${esc(OUTCOMES[sample.outcome]||'待比较')}</p><p>${esc(sample.notes||'')}</p></article>`).join('')||'<p>还没有真实试样。先做小样再确认原衣操作。</p>'}</div></html>`;
    const url=URL.createObjectURL(new Blob([content],{type:'text/html;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download=(state.title||'我的方案')+'-制作清单.html';document.body.append(link);link.click();link.remove();notice('制作清单已下载，打开后可打印或另存为 PDF。');
    setTimeout(()=>URL.revokeObjectURL(url),120000);
  }
  Object.assign(global,{openCoAssistantSettings:openConnection,ensureCoState,renderCoPrepare,bindCoPrepare,renderCoAssistant,bindCoAssistant,renderCoMaking,bindCoMaking});
})(window);
