/** Explicit pages for bounded desktop panels. Keeps the original controls and listeners alive. */
export function pagePanel(panel, { label = '内容', footer = null } = {}) {
  if (!panel || panel._relicPager) return panel?._relicPager;
  const doc = panel.ownerDocument, win = doc.defaultView;
  const make = (tag, cls, text) => { const n = doc.createElement(tag); n.className = cls; if (text) n.textContent = text; return n; };
  const content = make('div', 'ns-page-content'), viewport = make('div', 'ns-page-viewport');
  const spacer = make('div', 'ns-page-spacer'); spacer.setAttribute('aria-hidden','true');
  const nav = make('nav', 'ns-page-nav'), prev = make('button', 'ns-button ns-quiet', '‹'), next = make('button', 'ns-button ns-quiet', '›');
  const count = make('span', 'ns-page-count'), name = make('span', 'ns-page-label', label);
  prev.type = next.type = 'button'; prev.setAttribute('aria-label', `${label}上一页`); next.setAttribute('aria-label', `${label}下一页`);
  nav.setAttribute('aria-label', `${label}翻页`); count.setAttribute('aria-live', 'polite');
  viewport.tabIndex = 0; viewport.setAttribute('aria-label', `${label}，使用上一页和下一页查看`);
  content.append(...panel.childNodes); viewport.append(content,spacer); nav.append(name, prev, count, next);
  panel.replaceChildren(nav, viewport); if (footer) panel.append(footer);
  panel.classList.add('ns-paged-panel');
  let page = 0, total = 1, offsets = [0], scheduled = 0, dead = false;
  function update() {
    scheduled = 0; if (dead || !viewport.clientHeight) return;
    const height=viewport.clientHeight, top=content.getBoundingClientRect().top;
    // Prefer a field/paragraph boundary so the next page starts with its label.
    const boundaries=[...content.querySelectorAll('.ns-ws-field,.ns-kit-step,h3,h4,p,details,label,li,.ns-ws-actions,input,select,textarea,button')]
      .filter(n=>n.getClientRects().length).map(n=>Math.max(0,n.getBoundingClientRect().top-top-10)).sort((a,b)=>a-b);
    offsets=[0];
    while(offsets.at(-1)+height<content.scrollHeight-1 && offsets.length<500){
      const start=offsets.at(-1),limit=start+Math.max(60,height-28);
      const candidate=boundaries.filter(y=>y>start+Math.min(80,height/3)&&y<=limit).at(-1);
      offsets.push(candidate??limit);
    }
    total=offsets.length;
    spacer.style.height=`${Math.max(0,offsets.at(-1)+height-content.scrollHeight)}px`;
    page = Math.min(Math.max(0, page), total - 1);
    viewport.scrollTop = offsets[page];
    const text = `${page + 1} / ${total}`; if (count.textContent !== text) count.textContent = text;
    prev.disabled = page === 0; next.disabled = page === total - 1;
    panel.dataset.page = String(page + 1); panel.dataset.pages = String(total);
  }
  function schedule() { if (!scheduled && !dead) scheduled = win.requestAnimationFrame(update); }
  function go(index) { page = index; update(); }
  function reveal(target) {
    if (!content.contains(target)) return;
    const y = target.getBoundingClientRect().top - content.getBoundingClientRect().top;
    page = Math.max(0,offsets.findLastIndex(offset=>offset<=Math.max(0,y-8))); update();
  }
  const back = () => go(page - 1), forward = () => go(page + 1);
  prev.addEventListener('click', back); next.addEventListener('click', forward);
  function key(event) { if (!['PageDown', 'PageUp'].includes(event.key) || event.target.closest('input,select,textarea,[contenteditable=true]')) return; event.preventDefault(); go(page + (event.key === 'PageDown' ? 1 : -1)); }
  function focus(event) {
    const rect = event.target.getBoundingClientRect(), view = viewport.getBoundingClientRect();
    if (rect.top < view.top || rect.bottom > view.bottom) reveal(event.target);
  }
  function requested(event) { reveal(event.target); }
  viewport.addEventListener('keydown', key); content.addEventListener('focusin', focus); content.addEventListener('relic:reveal', requested);
  const resize = new win.ResizeObserver(schedule); resize.observe(viewport); resize.observe(content);
  const mutation = new win.MutationObserver(schedule); mutation.observe(content, { childList: true, subtree: true, attributes: true, characterData: true });
  const api = { content, viewport, go, reveal, refresh: schedule, destroy() {
    dead = true; win.cancelAnimationFrame(scheduled); resize.disconnect(); mutation.disconnect();
    prev.removeEventListener('click', back); next.removeEventListener('click', forward);
    viewport.removeEventListener('keydown', key); content.removeEventListener('focusin', focus); content.removeEventListener('relic:reveal', requested);
    delete panel._relicPager;
  } };
  panel._relicPager = api; schedule(); return api;
}

export function installWorkbenchStyle(doc = document) {
  if (doc.querySelector('link[data-paged-workbench]')) return;
  const link = doc.createElement('link'); link.rel = 'stylesheet'; link.dataset.pagedWorkbench = 'true';
  link.href = new URL('../styles/workbench-v0116.css', import.meta.url).href; doc.head.append(link);
}

export function pageControls(panel, workspace, label = '设置') {
  if (!panel || panel._relicPager) return;
  const footer = panel.ownerDocument.createElement('div'); footer.className = 'ns-fixed-actions';
  // Nested service/candidate sections rebuild themselves. Their buttons must stay with them.
  const rows=new Set([...panel.children].filter(n=>n.matches('.ns-ws-actions,.ns-kit-generate')));
  panel.querySelectorAll('[data-fixed-actions=true]').forEach(row=>rows.add(row));
  for (const row of rows) {
    if (row.querySelector('.is-primary') || row.classList.contains('ns-kit-generate')) footer.append(row);
  }
  const billing=panel.querySelector('.ns-generation-billing');if(footer.childNodes.length&&billing)footer.prepend(billing);
  const pager = pagePanel(panel, { label, footer: footer.childNodes.length ? footer : null });
  workspace.cleanup(() => pager.destroy());
}

/** Fit the actual canvas rectangle, not an object-fit letterbox with incorrect pointer coordinates. */
export function fitDrawingCanvases(root, workspace) {
  const observed=new Set(),observer=new ResizeObserver(fit);
  function fit(){
    for(const wrap of root.querySelectorAll('.ns-ws-canvas-wrap')){
      const canvas=wrap.querySelector('canvas.ns-ws-selection-canvas,canvas.ns-ws-experiment-canvas');
      if(!canvas?.width||!canvas.height)continue;
      if(!observed.has(wrap)){observed.add(wrap);observer.observe(wrap);}
      const style=getComputedStyle(wrap),width=wrap.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),height=wrap.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
      if(width<=0||height<=0)continue;
      const scale=Math.min(width/canvas.width,height/canvas.height);
      canvas.style.setProperty('width',`${Math.max(1,Math.floor(canvas.width*scale))}px`,'important');
      canvas.style.setProperty('height',`${Math.max(1,Math.floor(canvas.height*scale))}px`,'important');
      canvas.style.setProperty('max-height','none','important');
    }
  }
  const changes=new MutationObserver(fit);changes.observe(root,{childList:true,subtree:true});
  const frame=requestAnimationFrame(fit);workspace.cleanup(()=>{cancelAnimationFrame(frame);observer.disconnect();changes.disconnect();});
}
