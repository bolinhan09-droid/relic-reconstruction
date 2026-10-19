/* Saved projects live in the workspace; desktop and browser drafts are separate. */
'use strict';
const browserDownloadBlob=downloadBlob;
downloadBlob=function(blob,name){
  if(!window.pywebview?.api?.save_export)return browserDownloadBlob(blob,name);
  // Native desktop saves do not depend on browser download permissions/gestures.
  const reader=new FileReader();
  reader.onload=async()=>{
    try{
      const result=await window.pywebview.api.save_export(name,String(reader.result).split(',')[1]);
      toast(result.ok?'文件已保存。':result.cancelled?'已取消保存。':result.message||'文件未保存。');
    }catch(error){toast('导出未完成：'+error.message);}
  };
  reader.onerror=()=>toast('导出内容无法读取。');reader.readAsDataURL(blob);
};
const desktopProjectsDialog=document.createElement('dialog');
desktopProjectsDialog.className='cloud-settings-dialog';
desktopProjectsDialog.innerHTML=`<div class="dialog-heading"><div><span class="eyebrow">LOCAL WORKSPACE</span><h2>我的方案</h2></div><button class="tool-button" data-close aria-label="关闭">关闭</button></div><p>保存在这台电脑上的方案。打开前会先保存当前草稿。</p><div id="desktopProjectList" role="status">正在读取…</div>`;
document.body.append(desktopProjectsDialog);
desktopProjectsDialog.querySelector('[data-close]').onclick=()=>desktopProjectsDialog.close();
const savedProjectsButton=document.createElement('button');
savedProjectsButton.id='desktopProjectsButton';savedProjectsButton.className='button text-button';savedProjectsButton.innerHTML='<span>我的方案</span>';
document.querySelector('.header-actions').prepend(savedProjectsButton);
savedProjectsButton.onclick=async()=>{
  desktopProjectsDialog.showModal();
  const list=desktopProjectsDialog.querySelector('#desktopProjectList');list.textContent='正在读取…';
  try{
    const result=await api('/api/projects');const projects=Array.isArray(result)?result:result.projects||[];
    list.innerHTML=projects.length?projects.map(p=>`<button class="button outline-button full-width" style="margin:8px 0;text-align:left;justify-content:space-between" data-project="${escapeHtml(p.id)}"><span>${escapeHtml(p.title||'未命名方案')}</span><small>${escapeHtml((p.updatedAt||p.createdAt||'').slice(0,10))}</small></button>`).join(''):'还没有保存的方案。上传照片开始创作，点击「保存方案」后就会出现在这里。';
    list.querySelectorAll('[data-project]').forEach(button=>button.onclick=async()=>{
      if(typeof quickLocked==='function'&&quickLocked()){toast('请等待当前任务完成后切换方案。');return;}
      try{
        button.disabled=true;
        if(hasPendingEdits()&&imageReference())await saveProject(false);
        const project=await api('/api/projects/'+encodeURIComponent(button.dataset.project));
        const strokes=typeof validateBrushDraft==='function'?validateBrushDraft(project.brushStrokes||[]):[];
        // Do not inherit references, handoff contexts or assistant actions from another project.
        state={...project,projectId:project.id,revision:project.revision,title:project.title,
          brushStrokes:strokes,quickMode:true,brushMode:true,quickStage:'refine',step:2,
          job:null,conceptJob:null,previewUrl:null,handoffContexts:{},qualityChecklist:{},
          brushSettings:{type:'blood',mode:'area',size:.08,opacity:.6,color:'#782c2b',spread:.55,direction:-.6},
          coAssistant:{messages:project.coAssistant?.messages||[],busy:false},pendingEdits:false};
        history=[];selected=null;compare=false;if(typeof resetBrushHistory==='function')resetBrushHistory();
        coPendingArea=null;coRegionDraft=null;coRegionPointer=null;coSelectedStroke=null;coRawView=false;
        if(typeof ensureV2State==='function')ensureV2State();
        state.savedSignature=contentSignature();
        state.coSavedContextSignature=typeof coContextPayload==='function'?JSON.stringify({id:state.projectId,...coContextPayload()}):'';
        const jobs=await api('/api/projects/'+encodeURIComponent(project.id)+'/jobs');
        const job=(jobs.jobs||[]).find(j=>j.artifactKind!=='concept'&&j.status==='succeeded'&&Number(j.projectRevision)===Number(project.revision));
        if(job){state.job=job;state.previewUrl=job.outputUrl||job.previewUrl;}
        render();persistDraft();desktopProjectsDialog.close();toast('已打开本机保存的方案。');
      }catch(error){toast(error.message);}finally{button.disabled=false;}
    });
  }catch(error){list.textContent=error.message;}
};

// Personal theme artwork stays in this workspace and never enters public builds.
fetch('/api/health').then(response=>response.json()).then(info=>{
  if(info.themeUrl==='/data/theme.png'){
    const image=document.querySelector('.landing-art img');if(image)image.src=info.themeUrl;
    const style=document.createElement('style');
    style.textContent=".studio-shell:before{background:linear-gradient(90deg,#061b23ee,#08222ee8),url('/data/theme.png') right bottom/cover}";
    document.head.append(style);
  }
}).catch(()=>{});
