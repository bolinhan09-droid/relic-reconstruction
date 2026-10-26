/* Image versions are node outputs, not a second hidden history store. */
const copy = value => structuredClone(value);
export function settledImageOutput(value) {
  const output = copy(value?.generationPreviousOutput || value || {});
  for (const key of ['candidateImageUrl', 'candidateReference', 'candidateBasedOnOlderInput', 'requiresExplicitAdoption',
    'jobId', 'jobUrl', 'jobStatus', 'progress', 'status', 'jobMessage', 'generationSource', 'generationPreviousOutput']) delete output[key];
  if (output.kind === 'generation_job') output.kind = 'garment';
  return output;
}

/** A generated raster already contains the source marks; replaying them doubles them. */
export function adoptImageResult(value, imageUrl, reference = {}) {
  const prior = copy(value || {}), source = prior.generationSource || prior;
  const output = settledImageOutput({...prior, generationPreviousOutput: null});
  const asset = {...copy(reference), url: imageUrl};
  return {...output, kind: 'garment', imageUrl, reference: asset, asset,
    sourceImageUrl: source.imageUrl || source.sourceImageUrl,
    sourceNodeId: source.sourceNodeId || prior.sourceNodeId,
    sourceBrushStrokes: copy(source.brushStrokes?.length ? source.brushStrokes : source.sourceBrushStrokes || []),
    originalProjectSnapshot: copy(source.projectSnapshot || source.originalProjectSnapshot || null),
    projectSnapshot: null, brushStrokes: [], damageItems: [], protectedRects: [], surfaceOptions: null,
    imageSemantics: 'raster_base', rasterized: true, editableStrokes: false,
    generatedJobId: reference.jobId || prior.generatedJobId,
    message: '已显示新结果，之前的方案可从版本入口切换'};
}


/** Failed attempts keep every prior image/provenance field, only adding task diagnostics. */
export function failedImageResult(value, status, message) {
  const prior = settledImageOutput(value);
  return {...prior, jobStatus: status, message: message || '本次未完成，之前的结果已保留',
    failedGeneration: {jobId: value.jobId, projectId: value.projectId, status}};
}

/** Newest first, with duplicate preview URLs collapsed and a stable original fallback. */
export function imageVersions(node, fallback = {}) {
  const rows = [], seen = new Set();
  function add(id, value, savedAt, label) {
    if (!value?.imageUrl || seen.has(value.imageUrl)) return;
    seen.add(value.imageUrl); rows.push({id, output: settledImageOutput(value), savedAt, label});
  }
  add('current', node?.output, null, '当前版本');
  for (const version of [...(node?.versions || [])].reverse()) add(version.id, version.output, version.savedAt);
  add('input', fallback, null, '输入原图');
  for (let index = 1; index < rows.length; index++) rows[index].label ||= `之前版本 ${rows.length-index}`;
  return rows;
}
