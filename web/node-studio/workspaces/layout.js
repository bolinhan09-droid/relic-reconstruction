import { el } from './shared.js';
import { installWorkbenchStyle, pageControls, pagePanel, fitDrawingCanvases } from './paged-workbench.js';

/** One bounded canvas, contextual pages and a fixed primary action across workbenches. */
export function arrangeWorkspace(ws, context) {
  if (!ws?.body) return ws;
  installWorkbenchStyle();
  fitDrawingCanvases(ws.root,ws);
  if (ws.root.dataset.arranged) {
    for (const panel of ws.root.querySelectorAll('.ns-garment-controls,.ns-kit-controls')) pageControls(panel, ws);
    for (const panel of ws.root.querySelectorAll('.ns-kit-panel')) {
      const pager = pagePanel(panel, {label:'内容'}); ws.cleanup(()=>pager.destroy());
    }
    return ws;
  }
  ws.root.dataset.arranged = 'true';
  const type = context.node.type, children = [...ws.body.children];
  const visualSelector = '.ns-ws-preview,.ns-ws-selection-board,.ns-ws-canvas-wrap,.ns-ws-stencil-picker';
  if (['branch_create','branch_merge','blend_create','battle_simulation'].includes(type)) {
    ws.root.classList.add('ns-ws-wide');
    const bench = ws.body.querySelector('.ns-ws-blend-bench,.ns-battle3d');
    const customControls = bench?.querySelector('.ns-ws-inspector,.ns-battle3d-panel');
    if (customControls) {
      for (const child of children) if (child!==bench) customControls.append(child);
      pageControls(customControls,ws); ws.root.classList.add('ns-fixed-special');
    }
    else pageControls(ws.body, ws, '工作区');
    return ws;
  }
  const hasVisual = children.some(child=>child.matches(visualSelector));
  if (!hasVisual) {
    ws.root.classList.add('ns-ws-document');
    pageControls(ws.body, ws, '设置');
    attachResultStage(ws, ws.body, context, '设置');
    return ws;
  }
  const stage = el('section', {class:'ns-ws-stage','aria-label':'创作画布'});
  const controls = el('aside', {class:'ns-ws-inspector','aria-label':'本步设置'});
  let lastWasVisual = false;
  for (const child of children) {
    const visual = child.matches(visualSelector) || child.matches('.ns-ws-detail-tools,.ns-ws-generation-candidate');
    const drawingActions = ['region_generate','stencil_export'].includes(type) && lastWasVisual && child.matches('.ns-ws-actions') && !child.querySelector('.is-primary');
    (visual || drawingActions ? stage : controls).append(child); lastWasVisual = visual;
  }
  ws.body.replaceChildren(stage, controls); ws.root.classList.add('ns-ws-workbench');
  pageControls(controls, ws);
  if (ws.root.dataset.inlineResult !== 'true') attachResultStage(ws, stage, context);
  return ws;
}

function attachResultStage(ws, stage, context, label='画布') {
  const content = el('section', {class:'ns-result-canvas'}), report = el('section',{class:'ns-result-report',hidden:true});
  const tabs = el('nav',{class:'ns-result-tabs','aria-label':'工作区视图'});
  const canvasTab = el('button',{type:'button',class:'ns-button',text:label,'aria-selected':'true'});
  const resultTab = el('button',{type:'button',class:'ns-button',text:'本步结果','aria-selected':'false',disabled:!context.node.output});
  if (stage === ws.body) {
    const holder = el('section',{class:'ns-ws-stage'}); stage.replaceWith(holder); content.append(stage); holder.append(tabs, content, report);
  } else { content.append(...stage.childNodes); stage.append(tabs,content,report); }
  report.append(ws.output); tabs.append(canvasTab,resultTab);
  const pager = pagePanel(report,{label:'结果'}); ws.cleanup(()=>pager.destroy());
  function choose(result) {
    content.hidden=result; report.hidden=!result;
    canvasTab.setAttribute('aria-selected',String(!result)); resultTab.setAttribute('aria-selected',String(result));
    pager.refresh();
  }
  ws.on(canvasTab,'click',()=>choose(false)); ws.on(resultTab,'click',()=>choose(true));
  ws.on(ws.root,'workspace:output',()=>{ resultTab.disabled=false; choose(true); });
  if (context.node.output) choose(true);
}
