/* Observe explicit generation jobs. This module never submits, retries or adopts
 * an image request. A returned image remains a candidate until the user adopts it.
 */
const ACTIVE = new Set(['queued', 'running', 'pending', 'processing']);
const SUCCEEDED = new Set(['succeeded', 'success', 'completed', 'complete']);
const FAILED = new Set(['failed', 'error', 'interrupted', 'cancelled', 'canceled']);
const INTERVAL = 1500;
const copy = value => structuredClone(value);

function localImage(value) {
  if (typeof value !== 'string' || !value.startsWith('/data/') || value.includes('\\')) return null;
  if (!/^\/data\/[A-Za-z0-9_./-]+\.(png|jpe?g|webp)$/i.test(value)) return null;
  if (value.split('/').some(part => part === '..' || part === '.')) return null;
  return value;
}

function progress(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000 : undefined;
}

export class GenerationTracker {
  constructor({api, getWorkflow, updateWorkflow, onUpdate = () => {}, notify = () => {}}) {
    this.api = api; this.getWorkflow = getWorkflow; this.updateWorkflow = updateWorkflow;
    this.onUpdate = onUpdate; this.notify = notify;
    this.active = false; this.epoch = 0; this.timer = null; this.busy = false;
    this.errors = new Map(); this.cursor = 0;
  }

  start() {
    if (this.active) return;
    this.active = true; this.epoch++; this.errors.clear(); this._schedule(0);
  }

  stop() {
    this.active = false; this.epoch++; clearTimeout(this.timer); this.timer = null;
  }

  _schedule(delay = INTERVAL) {
    clearTimeout(this.timer);
    if (this.active) this.timer = setTimeout(() => this._tick(), delay);
  }

  async _tick() {
    if (!this.active) return;
    if (this.busy) { this._schedule(); return; }
    this.busy = true;
    const epoch = this.epoch;
    try {
      const initial = this.getWorkflow();
      if (!initial?.id) return;
      const workflowId = initial.id;
      const jobs = [...new Set((initial.nodes || [])
        .filter(node => node.output?.kind === 'generation_job' && node.output.jobId
          && ACTIVE.has(node.output.jobStatus || node.output.status || node.status))
        .map(node => node.output.jobId))];
      // Bound a busy workflow's work per round; sequential requests never overlap.
      const start = this.cursor % Math.max(1, jobs.length);
      const batch = [...jobs.slice(start), ...jobs.slice(0, start)].slice(0, 8);
      this.cursor = start + batch.length;
      for (const jobId of batch) {
        if (!this.active || this.epoch !== epoch || this.getWorkflow()?.id !== workflowId) break;
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) continue;
        const key = `${workflowId}/${jobId}`, backoff = this.errors.get(key);
        if (backoff?.halted || (backoff?.nextAt || 0) > Date.now()) continue;
        try {
          const job = await this.api('GET', `/api/jobs/${encodeURIComponent(jobId)}`);
          if (!this.active || this.epoch !== epoch || this.getWorkflow()?.id !== workflowId) continue;
          this.errors.delete(key);
          await this._merge(workflowId, jobId, job, epoch);
        } catch (_error) {
          if (!this.active || this.epoch !== epoch || this.getWorkflow()?.id !== workflowId) continue;
          const failures = (backoff?.failures || 0) + 1;
          this.errors.set(key, {failures, nextAt: Date.now() + Math.min(30000, INTERVAL * 2 ** (failures - 1)), halted: failures >= 6});
          if (failures === 1) this.notify('暂时无法读取图像进度，稍后只重查状态；不会重复生成。');
          if (failures === 6) this.notify('读取图像进度连续失败，已暂停查询。重新打开平台后可继续查看，任务不会自动重发。');
        }
      }
      // Avoid retaining unrelated project IDs after switching workflows.
      for (const key of this.errors.keys()) if (!key.startsWith(`${workflowId}/`)) this.errors.delete(key);
    } finally {
      this.busy = false;
      if (this.active) this._schedule();
    }
  }

  async _merge(workflowId, jobId, job, epoch) {
    const current = this.getWorkflow();
    if (!current || current.id !== workflowId || !this.active || this.epoch !== epoch) return;
    const status = String(job?.status || '');
    if (!ACTIVE.has(status) && !SUCCEEDED.has(status) && !FAILED.has(status)) return;
    const next = copy(current), updated = [];
    let finished = false, invalidResult = false, olderInput = false;
    for (const node of next.nodes || []) {
      if (node.output?.kind !== 'generation_job' || node.output.jobId !== jobId
          || !ACTIVE.has(node.output.jobStatus || node.output.status || node.status)) continue;
      const before = JSON.stringify({output: node.output, status: node.status});
      const output = node.output;
      const amount = progress(job.progress);
      if (amount !== undefined) output.progress = amount;
      output.jobStatus = status;
      if (typeof job.message === 'string') output.message = job.message.slice(0, 1000);
      if (SUCCEEDED.has(status)) {
        const candidate = localImage(job.outputUrl || job.previewUrl || job.result?.url);
        if (!candidate) {
          output.jobStatus = 'invalid_result';
          output.message = '任务返回的图片地址无效，未采用任何结果；请检查任务记录。';
          node.status = 'failed'; invalidResult = true;
        } else {
          output.candidateImageUrl = candidate;
          output.candidateReference = {url: candidate, jobId, generated: true,
            projectId: job.projectId || output.projectId, projectRevision: job.projectRevision || output.projectRevision};
          if (job.usage && typeof job.usage === 'object') output.usage = copy(job.usage);
          output.progress = 1;
          output.message = '新图片已返回，等待你比较并采用；当前画面仍保留原版。';
          olderInput ||= node.status === 'stale';
          output.candidateBasedOnOlderInput = node.status === 'stale';
          // An upstream change remains visible; a completed job does not make
          // its older inputs current again.
          if (node.status !== 'stale') node.status = 'ready';
          finished = true;
        }
      } else if (FAILED.has(status)) {
        node.status = status === 'interrupted' ? 'interrupted' : 'failed';
        output.message ||= '图像任务未完成；没有自动重试。';
        finished = true;
      } else if (node.status !== 'stale') node.status = 'running';
      if (before !== JSON.stringify({output: node.output, status: node.status})) updated.push(node);
    }
    if (!updated.length) return;
    // The request may have awaited while a different node was being edited.
    // This snapshot was taken after the GET and merges only matching job nodes.
    await this.updateWorkflow(next);
    if (!this.active || this.epoch !== epoch || this.getWorkflow()?.id !== workflowId) return;
    for (const node of updated) this.onUpdate(node.id, copy(node.output));
    if (invalidResult) this.notify('返回的图像地址无效，结果未被采用。');
    else if (finished && SUCCEEDED.has(status)) this.notify(olderInput ? '新图片已返回，但基于修改前的输入。请比较后决定是否采用。' : '新图片已返回。进入图像生成节点比较，满意后再采用。');
    else if (finished) this.notify('图像任务未完成，已保留原画面与任务记录，没有自动重试。');
  }
}
