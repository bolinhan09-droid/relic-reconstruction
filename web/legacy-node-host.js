/* Isolated host for node workspaces. Ordinary /legacy sessions remain unchanged. */
(() => {
  'use strict';
  const query = new URLSearchParams(location.search);
  if (query.get('nodeEmbed') !== '1' || window.parent === window) return;
  const workflowId = query.get('workflowId'), nodeId = query.get('nodeId'), channel = query.get('channel');
  const mode = query.get('mode') === 'mapping' ? 'mapping' : 'brush';
  if (!workflowId || !nodeId || !channel) return;
  let initialized = false, saving = false, latestMapping = null, sourceContext = {};
  let detailLens = null, automaticLensActive = false;
  const send = (type, detail = {}) => window.parent.postMessage({ type, workflowId, nodeId, channel, ...detail }, location.origin);
  const localImage = value => { try { const u = new URL(value, location.origin); return u.origin === location.origin && /^\/(data|resources|api)\//.test(u.pathname) ? u.pathname + u.search : ''; } catch { return ''; } };
  const style = document.createElement('style');
  style.textContent = `
    body.node-embed{margin:0!important;min-width:0!important;background:#102b33!important}
    .node-embed #landingScreen,.node-embed .app-header,.node-embed .project-heading,.node-embed .workflow,.node-embed .app-footer,.node-embed #coAssistantPane,.node-embed #coMobileNav,.node-embed .panel-top,.node-embed .panel-bottom,.node-embed .canvas-heading,.node-embed .canvas-footer,.node-embed .canvas-legend{display:none!important}
    .node-embed #studioShell{display:block!important;min-height:100vh!important}
    .node-embed .app-main{max-width:none!important;padding:12px!important;margin:0!important}
    .node-embed .workbench{display:grid!important;grid-template-columns:250px minmax(0,1fr)!important;gap:12px!important;align-items:start!important}
    .node-embed .canvas-panel{position:sticky!important;top:12px!important;min-width:0!important}
    .node-embed .canvas-stage{height:calc(100vh - 170px)!important;min-height:360px!important;margin:0!important;padding:14px!important}
    .node-embed .control-panel{max-height:calc(100vh - 24px)!important;overflow:auto!important}
    .node-embed .step-content{padding:14px!important;max-height:none!important}
    .node-embed #brushRefine,.node-embed #brushImportResult,.node-embed #brushSaveSketch,.node-embed #brushAdvanced,.node-embed #quickBack,.node-embed .quick-service,.node-embed #configureCloud,.node-embed .brush-boundary,.node-embed #garmentMappingButton,.node-embed .co-refine-block,.node-embed #coGoMaking{display:none!important}
    .node-embed #garmentMappingDialog{width:calc(100vw - 12px)!important;max-height:calc(100vh - 12px)!important;margin:6px!important;border-radius:8px!important}
    .node-embed #gmClose{display:none!important}
    @media(max-width:720px){.node-embed .workbench{grid-template-columns:190px minmax(0,1fr)!important}.node-embed .step-content{padding:9px!important}}
  `;
  document.head.append(style); document.body.classList.add('node-embed');

  async function installDetailLens() {
    if (mode !== 'brush' || detailLens) return;
    const target = document.getElementById('brushCanvas');
    const controlsHost = document.querySelector('.canvas-toolbar');
    if (!target || !controlsHost) return;
    const { attachMagnifier } = await import('/node-studio/workspaces/magnifier.js');
    const composite = document.createElement('canvas'), painting = composite.getContext('2d');
    function readSource() {
      const photo = document.getElementById('garmentImage'), foreground = document.getElementById('surfaceForeground');
      if (!target.width || !target.height || !photo?.naturalWidth) return null;
      if (composite.width !== target.width || composite.height !== target.height) { composite.width = target.width; composite.height = target.height; }
      painting.clearRect(0, 0, composite.width, composite.height);
      const subjectOnly = foreground && !foreground.hidden && document.getElementById('garmentCanvas')?.classList.contains('surface-background-hidden');
      if (subjectOnly) painting.drawImage(foreground, 0, 0, composite.width, composite.height);
      else painting.drawImage(photo, 0, 0, composite.width, composite.height);
      // This is the displayed, already warped brush canvas, including the live stroke.
      // The separate lens never calls the brush engine and never paints into target.
      if (!target.hidden) painting.drawImage(target, 0, 0, composite.width, composite.height);
      return composite;
    }
    detailLens = attachMagnifier({ target, readSource, controlsHost,
      onState: value => send('relic-node-magnifier-state', { state: value }) });
    detailLens.setAutomaticActive(automaticLensActive);
    window.RelicNodeMagnifier = detailLens;
  }

  // Observe only the local mapping result. Never inspect cloud settings or keys.
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function(resource, options) {
    const response = await originalFetch(resource, options);
    let url; try { url = new URL(typeof resource === 'string' ? resource : resource.url, location.origin); } catch { return response; }
    const method = options?.method || (typeof resource !== 'string' && resource.method) || 'GET';
    if (url.origin === location.origin && /\/api\/projects\/[^/]+\/mappings$/.test(url.pathname) && method.toUpperCase() === 'POST' && response.ok) {
      try { latestMapping = await response.clone().json(); } catch { /* The legacy UI reports invalid results. */ }
    }
    return response;
  };

  async function install(payload) {
    if (initialized) return;
    initialized = true;
    // Embedded drafts are node-scoped and must never overwrite the ordinary studio draft.
    persistDraft = function() {};
    const input = payload.input || {};
    const snapshot = input.projectSnapshot || input.project || {};
    let existing = {};
    if (input.projectId) existing = await api('/api/projects/' + encodeURIComponent(input.projectId));
    const data = { ...existing, ...snapshot };
    const currentUrl = localImage(input.imageUrl || input.url);
    const oldReference = input.reference || data.reference || {};
    const referenceUrl = localImage(oldReference.url);
    // Only an editable preview replays recorded geometry. Raster artifacts already contain it.
    const baked = input.imageSemantics === 'raster_base' || input.editableStrokes === false
      || input.rasterized === true || input.rasterizedEffects === true
      || ['user_import', 'local_interaction_draft'].includes(input.generatedBy)
      || input.artifactKind === 'observed_mapping';
    const replay = !baked && (input.imageSemantics === 'editable_preview' && input.editableStrokes !== false
      || input.artifactKind === 'local_brush_preview' && !!input.projectSnapshot
      || !currentUrl && !!referenceUrl);
    const url = replay ? referenceUrl || currentUrl : currentUrl || referenceUrl;
    if (!url) throw Error('当前节点没有可读取的真实服装底图。');
    const matchingAsset = localImage(input.asset?.url || input.asset?.imageUrl) === url ? input.asset : {};
    let reference = { ...(replay || referenceUrl === url ? oldReference : matchingAsset), url,
      width: replay ? oldReference.width || input.width : matchingAsset.width || (referenceUrl === url ? oldReference.width : input.width),
      height: replay ? oldReference.height || input.height : matchingAsset.height || (referenceUrl === url ? oldReference.height : input.height),
      uploaded: url.startsWith('/data/uploads/') };
    // The legacy image resolver intentionally accepts uploads and bundled samples only.
    // Materialize a node-produced local image as a new upload instead of loosening that guard.
    if (!url.startsWith('/resources/') && !url.startsWith('/data/uploads/')) {
      const image = await fetch(url); if (!image.ok) throw Error('上游节点图片暂时无法读取。');
      const form = new FormData(); form.append('file', await image.blob(), 'node-input.png');
      const upload = await api('/api/uploads', { method: 'POST', body: form });
      reference = { ...upload, url: upload.url, uploaded: true, sourceNodeImageUrl: url };
    } else if (url.startsWith('/resources/')) { delete reference.id; reference.uploaded = false; }
    sourceContext = {
      coordinateSpace: input.coordinateSpace || 'source_photo',
      ...(input.mapping ? { mapping: input.mapping } : {}),
      ...(input.mappingSourceProject ? { mappingSourceProject: input.mappingSourceProject } : {}),
      ...(input.parts ? { parts: input.parts, selectedPartId: input.selectedPartId || null } : {}),
      inputProvenance: { sourceImageUrl: currentUrl || referenceUrl, sourceReferenceUrl: referenceUrl,
        sourceProjectId: input.projectId || null, sourceArtifactKind: input.artifactKind || null,
        sourceGeneratedBy: input.generatedBy || null, sourceImageSemantics: input.imageSemantics || (replay ? 'editable_preview' : 'raster_base'),
        rasterBaseAdopted: !replay, recordedStrokeCount: (input.brushStrokes || data.brushStrokes || []).length,
        ...(replay ? {} : { sourceProjectSnapshot: snapshot }),
      },
    };
    // Each node owns a fresh project revision line; upstream versions stay immutable.
    state = { ...data, title: String(payload.title || data.title || '节点服装方案').slice(0, 80),
      projectId: null, revision: null, uploadId: null, reference, garmentId: '', characterId: data.characterId || '', scenarioId: data.scenarioId || '',
      merchantId: data.merchantId || '', uploadMerchant: data.uploadMerchant || '', uploadMaterial: data.uploadMaterial || '',
      damageItems: validateItems(replay ? input.damageItems || data.damageItems || [] : []),
      protectedRects: validateItems(replay ? input.protectedRects || data.protectedRects || [] : [], true),
      brushStrokes: validateBrushDraft(replay ? input.brushStrokes || data.brushStrokes || [] : []),
      surfaceOptions: replay ? input.surfaceOptions || data.surfaceOptions : null,
      modelSelections: { slash: '', blood: '', burn: '', ...(data.modelSelections || {}) },
      mode: 'manual_chatgpt', reversibleRequired: data.reversibleRequired ?? 'unknown',
      planNotes: data.planNotes || [], customDamageIdea: data.customDamageIdea || '', customDamageEnabled: true,
      qualityChecklist: {}, quickMode: true, quickStage: 'refine', step: 2, brushMode: true,
      brushSettings: { type: 'blood', mode: 'free', size: .055, opacity: .8, color: '#782c2b', spread: .55, direction: -.6, ...(data.brushSettings || {}) },
      preparation: data.preparation || {}, coAssistant: { messages: [], busy: false },
      job: null, previewUrl: null, conceptJob: null, pendingEdits: true, savedSignature: null,
      quickOriginalReference: replay ? data.quickOriginalReference || reference : reference, quickParentJobId: replay ? data.quickParentJobId || null : null,
    };
    history = []; selected = null; compare = false;
    if (typeof resetBrushHistory === 'function') resetBrushHistory();
    if (typeof coPendingArea !== 'undefined') { coPendingArea = null; coRegionDraft = null; coRegionPointer = null; coSelectedStroke = null; coRawView = false; }
    if (typeof ensureV2State === 'function') ensureV2State();
    const landing = document.getElementById('landingScreen'), studio = document.getElementById('studioShell');
    if (landing) landing.hidden = true; if (studio) studio.hidden = false;
    document.body.classList.remove('landing-active'); document.body.classList.add('studio-active');
    render(); await saveProject(false);
    await installDetailLens();
    if (mode === 'mapping') {
      if (!window.RelicGarmentMapping?.open) throw Error('衣片映射模块尚未载入。');
      await window.RelicGarmentMapping.open();
    }
    window.dispatchEvent(new CustomEvent('studio:entered'));
    send('relic-node-loaded');
  }

  async function commit() {
    if (saving || !initialized) return;
    if (typeof coPendingArea !== 'undefined' && coPendingArea) throw Error('请先采用或取消当前区域预览，再保存节点。');
    if (typeof quickLocked === 'function' && quickLocked()) throw Error('当前操作尚未结束，请稍后保存。');
    if (mode === 'mapping' && (!latestMapping?.resultUrl || document.getElementById('gmResult')?.hidden || latestMapping.projectId !== state.projectId || latestMapping.projectRevision !== state.revision)) throw Error('请先上传目标平铺图、核对对应点并生成映射。若更改了位置或尺度，需要重新生成，未修改节点。');
    saving = true;
    try {
      await saveProject(false);
      const source = await api('/api/projects/' + encodeURIComponent(state.projectId) + '/mapping-source?sourceMode=brush');
      const snapshot = { ...projectPayload(), brushSettings: state.brushSettings, bloodSettings: state.bloodSettings, effectSettings: state.effectSettings };
      const imageUrl = mode === 'mapping' ? localImage(latestMapping.resultUrl) : localImage(source.sourceGuideUrl);
      if (!imageUrl) throw Error('本次操作没有可保存的真实输出图片。');
      const width = mode === 'mapping' ? latestMapping.targetSize?.[0] : source.width;
      const height = mode === 'mapping' ? latestMapping.targetSize?.[1] : source.height;
      // A change of coordinate space must never replay source-photo strokes on a flatlay.
      // Preserve their provenance in mappingSourceProject; the raster effect layer remains separate.
      const mappedReference = mode === 'mapping' ? { url: imageUrl, width, height, uploaded: true, generated: false, mappingId: latestMapping.id } : imageReference();
      const mappedSnapshot = mode === 'mapping' ? { ...snapshot, reference: mappedReference, brushStrokes: [], damageItems: [], protectedRects: [], surfaceOptions: null } : snapshot;
      send('relic-node-output', { output: { ...sourceContext, kind: 'garment', imageUrl, projectId: state.projectId, revision: state.revision,
        width, height, reference: mappedReference, projectSnapshot: mappedSnapshot,
        brushStrokes: mode === 'mapping' ? [] : state.brushStrokes || [],
        damageItems: mode === 'mapping' ? [] : state.damageItems || [], protectedRects: mode === 'mapping' ? [] : state.protectedRects || [], surfaceOptions: mode === 'mapping' ? null : state.surfaceOptions || null,
        sourceImageUrl: source.sourceOriginalUrl, effectLayerUrl: mode === 'mapping' ? latestMapping.effectLayerUrl : source.effectLayerUrl,
        coordinateSpace: mode === 'mapping' ? 'flatlay' : sourceContext.coordinateSpace || 'source_photo',
        ...(mode === 'mapping' ? { mapping: latestMapping, mappingSourceProject: snapshot, warnings: [...(latestMapping.warnings || []), '映射后的旧痕迹保留为独立栅格层和对应记录；新笔触在平铺坐标中绘制。'] } : { warnings: source.warnings || [] }),
        artifactKind: mode === 'mapping' ? 'observed_mapping' : 'local_brush_preview', aiGenerated: false,
        imageSemantics: mode === 'mapping' ? 'raster_base' : 'editable_preview', editableStrokes: mode !== 'mapping',
      } });
    } finally { saving = false; }
  }
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== location.origin) return;
    const payload = event.data;
    if (!payload || payload.workflowId !== workflowId || payload.nodeId !== nodeId || payload.channel !== channel) return;
    if (payload.type === 'relic-node-init') install(payload).catch(error => send('relic-node-error', { message: error.message }));
    if (payload.type === 'relic-node-save') commit().catch(error => send('relic-node-error', { message: error.message }));
    if (payload.type === 'relic-node-magnifier-auto') { automaticLensActive = payload.active === true; detailLens?.setAutomaticActive(automaticLensActive); }
    if (payload.type === 'relic-node-magnifier-enable') detailLens?.setEnabled(payload.enabled === true);
    if (payload.type === 'relic-node-magnifier-zoom') detailLens?.setZoom(payload.zoom);
  });
  window.addEventListener('beforeunload', () => { detailLens?.destroy(); detailLens = null; }, { once: true });
  // initialize() loads the local catalogue asynchronously; this wait is strictly bounded.
  async function ready() {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      if (typeof draftReady !== 'undefined' && draftReady && typeof saveProject === 'function') { send('relic-node-ready'); return; }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    send('relic-node-error', { message: '旧工作区初始化超时。请返回后重试，原节点结果保持不变。' });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true }); else ready();
})();
