import { createWorkspace, el, field, actions, notice, inputFor, assetURL } from './shared.js';

const providers = [{ value: 'openai_compatible', label: '支持看图的兼容 API' }, { value: 'local_openai', label: '本机视觉模型' }, { value: 'deepseek', label: 'DeepSeek · 需确认所选模型支持图片' }];
const providerLabel = provider => ({ openai_compatible: '兼容视觉接口', local_openai: '本机视觉模型', deepseek: 'DeepSeek' })[provider] || '视觉服务';
const confidenceLabel = value => ({ high: '较有把握', medium: '需要你确认', low: '线索较少' })[value] || '等待确认';
const evidenceLabel = value => ({ source_excerpt: '已读取来源摘录', cached_verified: '已核对的本地资料', search_lead: '检索线索 · 尚待核对' })[value] || '依据待确认';
function publicURL(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; } }
function text(value) { return Array.isArray(value) ? value.map(text).join('；') : typeof value === 'object' && value ? Object.values(value).map(text).join('；') : String(value || ''); }

export async function characterResearch(container, context) {
  const ws = createWorkspace(container, context, { title: '先认出角色，再找到这场战斗', description: 'AI 看服装给出候选，你确认角色后才检索资料；选好一个场景，再让它服务后续创作。', kicker: 'CHARACTER & STORY RESEARCH' });
  let settings = {}, assistant = {}, requestBusy = false, stale = false;
  const getWorkflow = () => context.getWorkflow?.() || context.workflow;
  const sourceURL = () => assetURL(inputFor(context));
  async function draftPatch(patch) {
    if (!context.updateResearchDraft) throw new Error('当前宿主还未接入识别草稿保存，请重新打开新版创作台。');
    Object.assign(ws.params, patch); return context.updateResearchDraft(patch);
  }
  const serviceHost = el('section', { class: 'ns-research-service' });
  const stepHost = el('div', { class: 'ns-research-steps' });
  const candidateHost = el('section', { class: 'ns-research-stage', 'aria-label': '角色候选' });
  const sceneHost = el('section', { class: 'ns-research-stage', 'aria-label': '战斗场景' });
  const staleNotice = notice(''); staleNotice.hidden = true;
  ws.body.append(ws.preview(inputFor(context), '用于识别角色的当前服装图片'), staleNotice, serviceHost, stepHost, candidateHost, sceneHost);
  const needsConsent = () => !(settings.localOnly || settings.provider === 'local_openai');
  const consentMatches = () => { const consent = getWorkflow().context?.researchConsent; return !needsConsent() || consent?.sendThumbnail === true && consent.provider === settings.provider && consent.baseUrl === settings.baseUrl; };
  const signature = () => [sourceURL(), settings.provider, settings.baseUrl, settings.model].join('|');
  function steps() {
    staleNotice.hidden = !stale;
    const selected = ws.params.draftCharacter, scene = ws.params.selectedScene && ws.params.selectedCharacter?.name === selected?.name && ws.params.adoptedImageFingerprint === ws.params.imageFingerprint;
    stepHost.replaceChildren(...[['01', '识别服装中的角色', Boolean(ws.params.identification?.candidates?.length && !stale)], ['02', '确认角色并检索', Boolean(selected && !stale)], ['03', '选一场战斗来创作', Boolean(scene && !stale)]].map(([number, label, done]) => el('div', { class: `ns-research-step ${done ? 'is-complete' : ''}` }, el('span', { text: number }), el('strong', { text: label }), el('small', { text: done ? '已完成' : '待选择' }))));
  }
  async function savedSnapshot() { const saved = await context.saveWorkflow(); return saved?.workflow || saved || getWorkflow(); }
  function sourceStillCurrent(captured) { return !ws.signal.aborted && sourceURL() === captured; }
  function sourcesFor(scene) { return (ws.params.researchSources || []).filter(source => !scene.sourceIds?.length || scene.sourceIds.includes(source.id)); }
  function sourceLinks(sources) {
    const list = el('div', { class: 'ns-research-sources' });
    for (const source of sources) {
      const url = publicURL(source.url); if (!url) continue;
      const item = el('div', { class: 'ns-research-source' }, el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: source.title || new URL(url).hostname }));
      if (source.excerpt || source.snippet) item.append(el('p', { text: String(source.excerpt || source.snippet).slice(0, 600) }));
      if (source.readStatus) item.append(el('small', { text: ({ read: '已读取正文', read_success: '已读取正文', excerpt: '已读取摘录', search_only: '仅搜索摘要', search_lead: '仅检索线索', cached: '本地资料', cached_verified: '已核对的本地资料', read_unrelated: '正文与当前场景未确认相关', unread: '尚未读取正文' })[source.readStatus] || '来源状态待确认' }));
      list.append(item);
    }
    return list;
  }
  async function identify({ force = false } = {}) {
    if (requestBusy) return;
    if (!settings.visionReady) throw new Error(settings.reason || '先设置支持图片输入的视觉模型。');
    if (!consentMatches()) throw new Error('请先允许本项目向当前视觉服务发送服装缩略图。');
    const captured = sourceURL(); if (!captured) throw new Error('先连接真实服装照片。');
    const attemptKey = signature();
    if (!force && ws.params.autoIdentifyAttemptedFor === attemptKey) return;
    requestBusy = true;
    renderService(); ws.say('正在识别服装中的角色，完成后请你确认。');
    try {
      await draftPatch({ autoIdentifyAttemptedFor: attemptKey, identificationError: '' });
      const saved = await savedSnapshot();
      const result = await context.api('POST', '/api/node-research/identify', { workflowId: saved.id, nodeId: context.node.id, expectedRevision: saved.revision, confirmedExternal: needsConsent() });
      if (!sourceStillCurrent(captured)) throw new Error('识别期间底图已改变，这次结果没有沿用到新图片。');
      if (Number.isFinite(result.workflowRevision) && Number(getWorkflow().revision) !== Number(result.workflowRevision)) throw new Error('识别期间方案已有更新，请重新确认；本次结果没有自动采用。');
      const identification = { candidates: (result.candidates || []).slice(0, 8), imageFingerprint: result.imageFingerprint || result.sourceImageHash, sourceImageUrl: captured, provider: result.provider, model: result.model, mode: result.mode, identifiedAt: new Date().toISOString() };
      await draftPatch({ identification, imageFingerprint: identification.imageFingerprint, sourceImageHash: identification.imageFingerprint,
        draftCharacter: null, sceneCandidates: [], researchSources: [], researchResult: null, identificationError: '' });
      stale = false; await savedSnapshot();
      ws.say(identification.candidates.length ? '先确认哪个角色是对的，再查相关场景。' : '这次没有得到可确认的角色，请换一张特征更清楚的服装图片后重试。');
    } catch (error) {
      if (!ws.signal.aborted) { await draftPatch({ identificationError: error.message }).catch(() => {}); await savedSnapshot().catch(() => {}); ws.say(error.message, true); }
    } finally { requestBusy = false; if (!ws.signal.aborted) { renderService(); renderCandidates(); renderScenes(); steps(); } }
  }
  async function chooseCharacter(candidate) {
    if (requestBusy || stale) return;
    const draftCharacter = { id: candidate.id, name: candidate.name, ip: candidate.ip || '' };
    await draftPatch({ draftCharacter, sceneCandidates: [], researchSources: [], researchResult: null, researchError: '' }); await savedSnapshot();
    renderCandidates(); steps(); await searchScenes();
  }
  async function searchScenes() {
    if (requestBusy || !ws.params.draftCharacter || stale) return;
    requestBusy = true; renderService(); renderCandidates(); ws.say('正在检索公开资料。只搜索你确认的角色与作品，不发送服装图片。');
    const captured = sourceURL(), chosen = { ...ws.params.draftCharacter };
    try {
      const saved = await savedSnapshot();
      const result = await context.api('POST', '/api/node-research/scenes', { workflowId: saved.id, nodeId: context.node.id, expectedRevision: saved.revision, imageFingerprint: ws.params.imageFingerprint, character: chosen, confirmedSearch: true });
      if (!sourceStillCurrent(captured)) throw new Error('检索期间底图已改变，未把场景套用到新服装。');
      if (Number.isFinite(result.workflowRevision) && Number(getWorkflow().revision) !== Number(result.workflowRevision)) throw new Error('检索期间方案已经更新，这次场景没有自动套用。');
      await draftPatch({ sceneCandidates: (result.scenes || []).slice(0, 8), researchSources: (result.sources || []).slice(0, 20), researchResult: { mode: result.mode, notes: result.notes || [], character: chosen }, researchError: '' }); await savedSnapshot();
      ws.say(result.mode === 'cached_verified' ? '当前展示已核对的本地资料，未标为实时搜索。选择一个方向后再采用。' : '场景资料已返回。可以打开来源核对，再选择这次创作的方向。');
    } catch (error) { if (!ws.signal.aborted) { await draftPatch({ researchError: error.message }).catch(() => {}); await savedSnapshot().catch(() => {}); ws.say(error.message, true); } }
    finally { requestBusy = false; if (!ws.signal.aborted) { renderService(); renderCandidates(); renderScenes(); steps(); } }
  }
  async function adoptScene(scene) {
    if (stale || !ws.params.draftCharacter) throw new Error('先确认当前照片里的角色。');
    const selectedScene = Object.fromEntries(['id', 'title', 'summary', 'designDirection', 'sourceIds', 'evidenceStatus'].filter(key => scene[key] != null).map(key => [key, scene[key]]));
    const selectedCharacter = ws.params.draftCharacter, adoptedSources = sourcesFor(selectedScene);
    ws.patch({ selectedCharacter, selectedScene, adoptedSources, adoptedImageFingerprint: ws.params.imageFingerprint, adoptedSourceImageUrl: sourceURL() });
    ws.output.hidden = false;
    await ws.commit({ ...inputFor(context), kind: 'context', selectedCharacter, selectedScene, researchSources: ws.params.researchSources || [],
      context: { character: selectedCharacter.name, ip: selectedCharacter.ip, scene: selectedScene.title, sceneSummary: selectedScene.summary, designDirection: selectedScene.designDirection, sources: adoptedSources, evidenceStatus: selectedScene.evidenceStatus },
      imageFingerprint: ws.params.imageFingerprint, sourceImageUrl: sourceURL(), message: '已采用场景。后续创作使用这个方向；设计推演与来源中的事实分别保留。' });
    renderScenes(); steps();
  }
  function renderCandidates() {
    candidateHost.replaceChildren(); const candidates = ws.params.identification?.candidates || [];
    if (!candidates.length) return;
    candidateHost.append(el('h3', { text: stale ? '上一张底图的候选 · 已过期' : '先确认，这是不是你要出的角色' }), el('p', { class: 'ns-ws-description', text: '确认后将检索公开资料。服装识别是候选判断，你的确认才决定后续方向。' }));
    const grid = el('div', { class: 'ns-research-candidates' });
    for (const candidate of candidates) {
      const chosen = ws.params.draftCharacter?.name === candidate.name && !stale;
      const card = el('article', { class: `ns-research-character ${chosen ? 'is-selected' : ''}` }, el('span', { class: 'ns-research-badge', text: candidate.confidenceLabel || confidenceLabel(candidate.confidence) }), el('h4', { text: candidate.name || '待确认角色' }), el('p', { text: candidate.ip || '作品未确认' }));
      const evidence = candidate.visibleEvidence || candidate.evidence || [];
      if (evidence.length) card.append(el('ul', {}, (Array.isArray(evidence) ? evidence : [evidence]).map(item => el('li', { text: text(item) }))));
      if (candidate.uncertainties?.length) card.append(el('small', { text: '仍待确认：' + text(candidate.uncertainties) }));
      card.append(ws.button(chosen ? '已确认这个角色' : '就是这个角色', () => chooseCharacter(candidate), { primary: !chosen, disabled: stale || requestBusy })); grid.append(card);
    }
    candidateHost.append(grid);
    if (ws.params.draftCharacter && !(ws.params.sceneCandidates || []).length) candidateHost.append(actions(ws.button('重新检索这个角色的场景', () => searchScenes(), { disabled: requestBusy || stale })));
  }
  function renderScenes() {
    sceneHost.replaceChildren(); const scenes = ws.params.sceneCandidates || []; if (!scenes.length) return;
    sceneHost.append(el('h3', { text: '这一次，你想经历哪一场战斗？' }), notice('剧情依据和战损设计是两层信息：资料证明场景存在，具体血迹、磨损与破损分布仍是你选择的设计推演。'));
    if (ws.params.researchResult?.mode === 'cached_verified') sceneHost.append(el('p', { class: 'ns-ws-description', text: '当前为已核对的本地资料，并非实时检索结果。' }));
    const grid = el('div', { class: 'ns-research-scenes' });
    for (const scene of scenes) {
      const chosen = ws.params.selectedScene?.id === scene.id && ws.params.selectedCharacter?.name === ws.params.draftCharacter?.name && ws.params.adoptedImageFingerprint === ws.params.imageFingerprint && !stale;
      const card = el('article', { class: `ns-research-scene ${chosen ? 'is-selected' : ''}` }, el('span', { class: 'ns-research-badge', text: evidenceLabel(scene.evidenceStatus) }), el('h4', { text: scene.title }), el('p', { text: scene.summary || '' }));
      if (scene.designDirection) card.append(el('div', { class: 'ns-research-direction' }, el('strong', { text: '可以怎么设计' }), el('p', { text: text(scene.designDirection) })));
      card.append(sourceLinks(sourcesFor(scene)), ws.button(chosen ? '已采用这个场景' : '采用这个场景', () => adoptScene(scene), { primary: !chosen, disabled: stale || requestBusy || chosen })); grid.append(card);
    }
    sceneHost.append(grid);
  }
  function settingsForm() {
    const details = el('details', { class: 'ns-ws-details' }, el('summary', { text: '设置视觉助手' })); details.open = !settings.visionReady;
    const provider = field(ws, '_researchProvider', '视觉助手服务', { options: providers, value: assistant.provider || 'openai_compatible', persist: false });
    const base = field(ws, '_researchBase', '视觉接口地址', { type: 'url', value: assistant.baseUrl || '', placeholder: 'https://服务地址/v1', persist: false });
    const model = field(ws, '_researchModel', '支持图片输入的模型', { value: assistant.model || '', placeholder: '填写服务实际支持看图的模型 ID', persist: false });
    const vision = field(ws, '_researchVision', '我已确认这个模型支持图片输入', { type: 'checkbox', value: assistant.vision === true, persist: false });
    const secret = el('input', { class: 'ns-input', type: 'password', autocomplete: 'off', spellcheck: 'false', id: 'ns-research-secret', placeholder: assistant.hasKey ? '留空沿用当前服务已配置的密钥' : '输入所选视觉服务的密钥' });
    ws.on(provider.control, 'change', () => { const local = provider.control.value === 'local_openai'; base.control.value = local ? 'http://127.0.0.1:11434/v1' : provider.control.value === 'deepseek' ? 'https://api.deepseek.com/v1' : ''; model.control.value = ''; vision.control.checked = false; secret.value = ''; });
    details.append(el('div', { class: 'ns-research-settings-grid' }, provider.group, base.group, model.group, el('div', { class: 'ns-ws-field' }, el('label', { for: 'ns-research-secret', text: '视觉助手 API 密钥' }), secret)), vision.group,
      notice('这里配置的是“看懂图片并返回文字”的视觉助手，和图像生成节点的生图模型分别设置。密钥不写入项目。'),
      actions(ws.button('保存视觉助手设置', async () => {
        const payload = { provider: provider.control.value, baseUrl: base.control.value.trim(), model: model.control.value.trim(), vision: vision.control.checked }; if (secret.value.trim()) payload.apiKey = secret.value.trim();
        try { assistant = await context.api('POST', '/api/assistant/settings', payload); secret.value = ''; settings = await context.api('GET', '/api/node-research/settings'); renderService(); ws.say('视觉助手设置已保存。请确认当前服务和图片发送方式，再开始识别。'); }
        finally { secret.value = ''; delete payload.apiKey; }
      })));
    details.querySelectorAll('input,select,button').forEach(control => { control.disabled = requestBusy; });
    ws.cleanup(() => { secret.value = ''; }); return details;
  }
  function renderService() {
    const wasOpen = serviceHost.querySelector('details')?.open;
    serviceHost.replaceChildren(el('div', { class: 'ns-research-service-heading' }, el('strong', { text: `${providerLabel(settings.provider)}${settings.model ? ' · ' + settings.model : ''}` }), el('span', { class: 'ns-research-badge', text: settings.visionReady ? '可开始识别' : '视觉接口待配置' })));
    if (settings.baseUrl) serviceHost.append(el('p', { class: 'ns-ws-description', text: settings.baseUrl }));
    if (!settings.visionReady) serviceHost.append(notice(settings.reason || '还没有可用的视觉接口。配置支持看图的模型后，才会发送识别请求。'));
    const form = settingsForm(); if (typeof wasOpen === 'boolean') form.open = wasOpen; serviceHost.append(form);
    if (needsConsent() && !consentMatches() && settings.visionReady) {
      const consent = el('input', { type: 'checkbox', id: 'ns-research-consent' });
      serviceHost.append(el('label', { class: 'ns-ws-consent', for: 'ns-research-consent' }, consent, el('span', { text: '允许本项目把服装缩略图发送到上方视觉服务进行识别。按该 API 服务计费，返回候选后仍由我确认角色。' })),
        actions(ws.button('允许并识别角色', async () => {
          if (!consent.checked) throw new Error('先勾选本项目的缩略图发送授权。');
          if (!context.setResearchConsent) throw new Error('当前宿主尚未接入项目授权保存，请重新打开新版创作台。');
          await context.setResearchConsent({ sendThumbnail: true, provider: settings.provider, baseUrl: settings.baseUrl, grantedAt: new Date().toISOString() }); await identify();
        }, { primary: true, disabled: requestBusy })));
    } else if (settings.visionReady) {
      const attempted = ws.params.autoIdentifyAttemptedFor === signature();
      serviceHost.append(notice(needsConsent() ? '本项目已允许向这个视觉服务发送缩略图。再次打开不会自动重复识别；主动重试会再次调用接口。' : '使用已启动的本机视觉服务，服装图片不会发送到云端。'),
        actions(ws.button(attempted ? '重新识别这张图片' : '识别这张服装图片', () => identify({ force: true }), { primary: !ws.params.identification?.candidates?.length, disabled: requestBusy })));
    }
  }
  async function initialize() { try {
    [settings, assistant] = await Promise.all([context.api('GET', '/api/node-research/settings'), context.api('GET', '/api/assistant/settings')]);
    if (ws.signal.aborted) return ws;
    stale = Boolean(ws.params.identification?.sourceImageUrl && ws.params.identification.sourceImageUrl !== sourceURL());
    const adoptedMatches = !ws.params.adoptedImageFingerprint || ws.params.adoptedImageFingerprint === ws.params.imageFingerprint && ws.params.adoptedSourceImageUrl === sourceURL();
    ws.output.hidden = stale || !adoptedMatches;
    if (stale) {
      staleNotice.hidden = false; staleNotice.textContent = '底图已经换了。上一版的角色和场景只保留作记录，不会自动套用到当前照片。';
    }
    renderService(); renderCandidates(); renderScenes(); steps();
    const mayAutoIdentify = settings.visionReady && consentMatches() && sourceURL() && ws.params.autoIdentifyAttemptedFor !== signature() && (!ws.params.identification?.candidates?.length || stale);
    if (mayAutoIdentify) Promise.resolve().then(() => identify()).catch(error => { if (!ws.signal.aborted) ws.say(error.message, true); });
    else if (!stale && (ws.params.identificationError || ws.params.researchError)) ws.say(ws.params.identificationError || ws.params.researchError, true);
  } catch (error) { if (!ws.signal.aborted) { renderService(); steps(); ws.say(error.message, true); } } }
  Promise.resolve().then(initialize);
  return ws;
}
