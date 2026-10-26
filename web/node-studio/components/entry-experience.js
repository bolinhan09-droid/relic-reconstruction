import {escape,icon,safeImage} from './icons.js';

const reducedMotion=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const timeLabel=value=>{
  const date=new Date(value);
  return Number.isNaN(date.getTime())?'保存时间未知':new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
};

/** Entry owns presentation only. Workflow reads and writes remain in app.js. */
export function createEntryExperience({openProject,deleteProject,onRetryHistory}){
  const $=id=>document.getElementById(id);
  let ready=false,rows=[],opening=null,transition=null,splashDismissed=false,historyState='loading',splashTimer=null;
  const parts={catalog:'pending',history:'pending'};
  const splash=$('entrySplash');
  const inertTargets=[document.querySelector('.ns-topbar'),$('entry')].filter(Boolean);
  // A cached local start should open directly. Only a genuinely pending catalog
  // shows the quiet loading screen; recent projects can keep loading inline.
  splash.hidden=true;
  splash.setAttribute('aria-hidden','true');
  splash.inert=true;
  const progress=document.createElement('div');
  progress.className='ns-boot-progress';
  progress.setAttribute('role','progressbar');
  progress.setAttribute('aria-label','正在加载创作工作区');
  $('entrySplashStatus').after(progress);
  function showSplash(){
    if(splashDismissed||parts.catalog!=='pending')return;
    splash.hidden=false;splash.inert=false;
    splash.removeAttribute('aria-hidden');
    inertTargets.forEach(element=>element.inert=true);
  }
  splashTimer=setTimeout(showSplash,180);

  function cancelTransition(){
    if(!transition)return;
    transition.cancelled=true;
    transition.animations.forEach(animation=>animation.cancel());
    transition.elements.forEach(element=>element.remove());
    transition=null;
  }
  async function dismissSplash(){
    if(splashDismissed)return;
    splashDismissed=true;
    clearTimeout(splashTimer);splashTimer=null;
    inertTargets.forEach(element=>element.inert=false);
    splash.setAttribute('aria-hidden','true');
    splash.inert=true;
    splash.hidden=true;
  }
  function markBootPart(kind,success){
    parts[kind]=success?'done':'failed';
    const pending=Object.keys(parts).filter(key=>parts[key]==='pending');
    $('entrySplashStatus').textContent=pending.includes('catalog')?'正在准备创作工作区…':pending.includes('history')?'正在读取本机创作…':'创作台已就绪';
    for(const key of Object.keys(parts)){
      const marker=splash.querySelector(`[data-boot-part="${key}"]`);
      if(marker){marker.dataset.state=parts[key];marker.textContent=parts[key]==='done'?'✓':parts[key]==='failed'?'!':'·';}
    }
    if(kind==='catalog'){
      ready=success;
      $('entry').setAttribute('aria-busy',String(!success));
      if(historyState==='ready')renderHistory(rows);
    }
    // The editing tools are the only blocking startup dependency. A slow or
    // failed history request must not lock an otherwise usable creation page.
    if(kind==='catalog'||!pending.length)void dismissSplash();
  }
  function renderHistory(nextRows){
    historyState='ready';
    rows=Array.isArray(nextRows)?nextRows:[];
    const list=$('entryHistoryList');
    if(!list)return;
    $('entryHistoryStatus').textContent=rows.length?`${rows.length} 份本机创作`:'你的第一份创作，将留在这里';
    list.setAttribute('aria-busy','false');
    list.innerHTML=rows.length?rows.slice(0,8).map(row=>{
      const image=safeImage(row.thumbnailUrl||row.thumbnail||row.imageUrl);
      const count=Number.isFinite(Number(row.nodeCount))?Number(row.nodeCount):row.order?.length||0;
      return `<article class="ns-history-item"><button class="ns-history-card" data-history-id="${escape(row.id)}" ${!ready||opening?'disabled':''} aria-label="继续创作：${escape(row.title||'未命名创作')}"><span class="ns-history-picture">${image?`<img src="${escape(image)}" alt="" loading="lazy" draggable="false">`:icon('garment')}<span class="ns-history-open" aria-hidden="true">继续创作 ↗</span></span><span class="ns-history-details"><strong>${escape(row.title||'未命名创作')}</strong><span><small>${count} 个节点</small><time datetime="${escape(row.updatedAt||'')}">${escape(timeLabel(row.updatedAt))}</time></span></span></button>${deleteProject?`<button class="ns-history-delete" data-history-delete="${escape(row.id)}" ${!ready||opening?'disabled':''} aria-label="删除创作：${escape(row.title||'未命名创作')}">删除</button>`:''}</article>`;
    }).join(''):'<div class="ns-history-empty"><span aria-hidden="true">'+icon('history')+'</span><div><strong>还没有保存的创作</strong><p>从一张服装照片开始，之后可以在这里继续。</p></div></div>';
    list.querySelectorAll('img').forEach(image=>image.addEventListener('error',()=>{image.replaceWith(Object.assign(document.createElement('span'),{className:'ns-history-unavailable',textContent:'预览暂不可用'}));},{once:true}));
    list.querySelectorAll('[data-history-id]').forEach(button=>button.addEventListener('click',async()=>{
      if(!ready||opening)return;
      opening=button.dataset.historyId;renderHistory(rows);
      $('entryHistoryStatus').textContent='正在打开创作…';
      let errorMessage='';
      try{await openProject(opening);}catch(error){errorMessage=error.message;}finally{opening=null;renderHistory(rows);if(errorMessage)$('entryHistoryStatus').textContent=errorMessage;}
    }));
    list.querySelectorAll('[data-history-delete]').forEach(button=>button.addEventListener('click',async event=>{
      event.stopPropagation();if(!ready||opening||!deleteProject)return;
      button.disabled=true;
      try{await deleteProject(button.dataset.historyDelete);}finally{if(button.isConnected)button.disabled=false;}
    }));
  }
  function historyLoading(){
    historyState='loading';
    $('entryHistoryStatus').textContent='正在读取本机创作…';
    $('entryHistoryList').setAttribute('aria-busy','true');
    if(!rows.length)$('entryHistoryList').innerHTML='<div class="ns-history-loading">正在取回你的创作记录<span class="ns-loading-line" aria-hidden="true"></span></div>';
  }
  function historyError(error){
    historyState='error';
    $('entryHistoryList').setAttribute('aria-busy','false');
    $('entryHistoryStatus').textContent='记录暂时无法读取';
    if(!rows.length)$('entryHistoryList').innerHTML=`<div class="ns-history-empty"><span aria-hidden="true">${icon('history')}</span><div><strong>暂时未能读取创作记录</strong><p>${escape(error.message||'请检查本机服务后点击刷新。')}</p></div></div>`;
  }
  function uploadState({pending=false,hasImage=false,message='',error=false}={}){
    $('frontDrop').classList.toggle('has-upload',hasImage);
    $('uploadStage').setAttribute('aria-busy',String(pending));
    $('entryStatus').textContent=message;
    $('entryStatus').classList.toggle('is-error',error);
    $('startButton').disabled=!ready||pending||!hasImage;
  }
  async function transitionToStudio({source,show,target}){
    cancelTransition();
    const rect=source?.getBoundingClientRect();
    const src=source?.currentSrc||source?.src;
    const scope={cancelled:false,animations:[],elements:[]};transition=scope;
    const ghost=rect&&src&&!reducedMotion()?document.createElement('img'):null;
    if(ghost){
      ghost.src=src;ghost.alt='';ghost.className='ns-entry-flight';
      Object.assign(ghost.style,{left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});
      document.body.append(ghost);scope.elements.push(ghost);
    }
    show();
    const destination=target?.();
    if(!ghost||!destination){cancelTransition();return;}
    await new Promise(resolve=>requestAnimationFrame(resolve));
    if(scope.cancelled)return;
    const dest=destination.getBoundingClientRect();
    // Spatial continuity comes from the actual uploaded image, with no
    // decorative full-screen slash competing with the new workspace.
    scope.animations.push(ghost.animate([{transform:'translate(0,0) scale(1)',opacity:1},{transform:`translate(${dest.left-rect.left}px,${dest.top-rect.top}px) scale(${dest.width/rect.width},${dest.height/rect.height})`,opacity:1,offset:.86},{transform:`translate(${dest.left-rect.left}px,${dest.top-rect.top}px) scale(${dest.width/rect.width},${dest.height/rect.height})`,opacity:0}],{duration:380,easing:'cubic-bezier(.22,.75,.15,1)',fill:'forwards'}));
    try{await Promise.all(scope.animations.map(animation=>animation.finished.catch(()=>{})));}
    finally{scope.elements.forEach(element=>element.remove());if(transition===scope)transition=null;}
  }
  $('skipEntrySplash').addEventListener('click',()=>void dismissSplash());
  $('entryHistoryRefresh').addEventListener('click',()=>void onRetryHistory());
  window.addEventListener('pagehide',()=>{clearTimeout(splashTimer);cancelTransition();});
  return {renderHistory,historyLoading,historyError,markBootPart,dismissSplash,transitionToStudio,cancelTransition,uploadState};
}
