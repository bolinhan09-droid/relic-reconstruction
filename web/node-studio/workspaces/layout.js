import { el } from './shared.js';

/** Give all tools one workbench hierarchy without changing their controls or handlers. */
export function arrangeWorkspace(workspace, context) {
  if (!workspace?.body || workspace.root.dataset.arranged) return workspace;
  workspace.root.dataset.arranged = 'true';
  const type = context.node.type;
  const children = [...workspace.body.children];
  if (['branch_create', 'branch_merge', 'blend_create', 'battle_simulation'].includes(type)) {
    workspace.root.classList.add('ns-ws-wide');
    return workspace;
  }
  const visualSelector = '.ns-ws-preview, .ns-ws-selection-board, .ns-ws-canvas-wrap, .ns-ws-stencil-picker';
  const hasVisual = children.some(child => child.matches(visualSelector));
  if (!hasVisual) { workspace.root.classList.add('ns-ws-document'); return workspace; }
  const stage = el('section', { class: 'ns-ws-stage', 'aria-label': '创作画布' });
  const controls = el('aside', { class: 'ns-ws-inspector', 'aria-label': '本步设置' });
  const heading = el('div', { class: 'ns-ws-inspector-heading' }, el('h3', { text: '本步设置' }));
  controls.append(heading);
  let lastWasVisual = false;
  for (const child of children) {
    const visual = child.matches(visualSelector) || child.matches('.ns-ws-detail-tools, .ns-ws-generation-candidate');
    const drawingActions = ['region_generate', 'stencil_export'].includes(type)
      && lastWasVisual && child.matches('.ns-ws-actions') && !child.querySelector('.is-primary');
    (visual || drawingActions ? stage : controls).append(child);
    lastWasVisual = visual;
  }
  workspace.body.replaceChildren(stage, controls);
  workspace.root.classList.add('ns-ws-workbench');
  return workspace;
}
