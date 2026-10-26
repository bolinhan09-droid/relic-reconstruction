import { createWorkspace, el, actions, notice, assetURL, inputFor } from './shared.js';
import { collectMergeCandidates } from '../core/model.js';

const workflowNow = context => context.getWorkflow?.() || context.workflow;

export async function branchCreate(container, context) {
  const ws = createWorkspace(container, context, { title: '分支探索', description: '从同一个起点保留多个方向。每条路线独立创作，原方案仍然保留。' });
  const source = el('div', { class: 'ns-ws-branch-source' }, ws.preview(inputFor(context), '共同起点'),
    el('div', {}, el('h3', { text: '把不同想法，放进不同路线' }), el('p', { text: '先给路线取个名字，再返回总览把创作节点拖到对应路线。之后可以随时增补、重新排序或汇合。' })));
  const routes = el('div', { class: 'ns-ws-route-grid' });
  function refresh() {
    const workflow = workflowNow(context);
    const branches = (workflow.branches || []).filter(branch => branch.forkId === context.node.id);
    const candidates = collectMergeCandidates(workflow, context.node.id, { all: true });
    routes.replaceChildren();
    for (const [index, branch] of branches.entries()) {
      const candidate = candidates.find(value => value.branchId === branch.id);
      const url = assetURL(candidate?.output || candidate);
      const fieldID = `route-label-${branch.id}`;
      const name = el('input', { class: 'ns-input', id: fieldID, value: branch.label || `路线 ${index + 1}`, maxlength: 48 });
      ws.on(name, 'change', async () => {
        const next = name.value.trim();
        if (!next) { name.value = branch.label || `路线 ${index + 1}`; return; }
        try { await context.renameBranch?.(branch.id, next); ws.say('路线名称已更新。'); }
        catch (error) { ws.say(error.message, true); }
      });
      const image = el('div', { class: 'ns-ws-route-preview' }, url ? el('img', { src: url, alt: branch.label || `路线 ${index + 1}` }) : el('p', { text: '还没有独立输出\n沿这条路线继续创作' }));
      routes.append(el('section', { class: 'ns-ws-route-card' },
        el('label', { for: fieldID, class: 'ns-ws-route-label', text: `探索路线 ${index + 1}` }), name, image,
        el('p', { class: 'ns-ws-route-meta', text: `${(branch.order || []).length} 个步骤${candidate ? ' · 已有可汇合的输出' : ' · 从共同起点开始'}` }),
        ws.button('前往这条路线', async () => { await ws.save(); context.focusBranch?.(branch.id); })));
    }
    if (!branches.length) routes.append(notice('还没有探索路线。添加一条路线，从当前方案继续。'));
  }
  ws.body.append(source, routes, actions(ws.button('添加探索路线', async () => {
    if (!context.addBranch) throw new Error('当前版本未接入分支操作，请重新打开当前创作台');
    await context.addBranch(context.node.id); refresh(); ws.say('新路线已添加，可以分别探索不同效果。');
  }, { primary: true })), notice('汇合时收集每条路线最后一份已采用的图片；还未采用的生成候选会继续留在原节点里。'));
  refresh(); return ws;
}

export async function branchMerge(container, context) {
  const ws = createWorkspace(container, context, { title: '方案汇合', description: '把多条路线收集到一起，保留各自的输出。接上融合创作后，再决定怎样取舍。' });
  const candidates = collectMergeCandidates(workflowNow(context), context.node.id, { all: true });
  const stored = ws.params.selectedCandidateIds;
  let selected = new Set(Array.isArray(stored) ? stored.filter(id => candidates.some(candidate => candidate.id === id)) : candidates.map(candidate => candidate.id));
  const grid = el('div', { class: 'ns-ws-merge-grid' });
  const summary = el('p', { class: 'ns-ws-merge-summary', role: 'status', 'aria-live': 'polite' });
  function updateSummary() {
    summary.textContent = `已选择 ${selected.size} / ${candidates.length} 个方案${selected.size > 3 ? '；进入融合创作后，可从中选择两至三个参与本轮融合。' : '，每张图片保持独立。'}`;
    for (const card of grid.children) card.classList.toggle('is-selected', selected.has(card.dataset.candidateId));
  }
  for (const [index, candidate] of candidates.entries()) {
    const checkID = `merge-choice-${context.node.id}-${index}`;
    const check = el('input', { id: checkID, type: 'checkbox', checked: selected.has(candidate.id) });
    const title = candidate.branchLabel || candidate.label || `方案 ${index + 1}`;
    const image = assetURL(candidate.output || candidate);
    const card = el('section', { class: 'ns-ws-merge-card', dataset: { candidateId: candidate.id } },
      el('label', { for: checkID, class: 'ns-ws-merge-choice' }, check, el('strong', { text: title })),
      image ? el('img', { src: image, alt: title }) : notice('这条路线还没有可用的图片。'),
      el('span', { class: 'ns-ws-route-meta', text: candidate.label || '该路线最新已采用的输出' }));
    ws.on(check, 'change', () => { if (check.checked) selected.add(candidate.id); else selected.delete(candidate.id); ws.patch({ selectedCandidateIds: [...selected] }); updateSummary(); });
    grid.append(card);
  }
  if (!candidates.length) grid.append(notice('分支还没有可汇合的输出。先在各条路线里完成创作并采用结果，再回到这里。'));
  ws.body.append(el('div', { class: 'ns-ws-merge-topline' }, el('h3', { text: '保留这些路线的结果' }), summary), grid,
    actions(ws.button('保存汇合候选', async () => {
      if (selected.size < 2) throw new Error('请选择至少两个方案，或先到其他路线完成一份输出。');
      ws.patch({ selectedCandidateIds: [...selected] }); await ws.run();
    }, { primary: true })), notice('汇合只整理候选，不会叠图，也不会调用生成接口。后面可以接“融合创作”来分配偏好，再接“图像生成”产生新版本。'));
  updateSummary(); return ws;
}
