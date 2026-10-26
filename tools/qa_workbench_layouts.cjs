/* Read-only layout smoke across registered workspaces, using synthetic local assets. */
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require('C:/Users/lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const root=path.resolve(__dirname,'..'),out=path.join(root,'work/v0116-workbench-layout-qa'),base='http://127.0.0.1:18018';
fs.mkdirSync(out,{recursive:true});const data=fs.mkdtempSync(path.join(out,'isolated-'));
const server=spawn(path.join(root,'.desktop-build/Scripts/python.exe'),['-B','tools/check_generation_results.py','--serve','--data-dir',data,'--port','18018'],{cwd:root,env:{...process.env,PYTHONUTF8:'1'},windowsHide:true});
let logs='';server.stderr.on('data',d=>logs+=d);let browser,page;
const report={rows:[],errors:[],externalRequests:0,paidCalls:0,userImagesUsed:false};
(async()=>{try{
 for(let i=0;i<160;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader']});page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
 page.on('pageerror',e=>report.errors.push(e.message));await page.route('**/*',route=>{const u=route.request().url();if(!u.startsWith(base)&&!u.startsWith('data:')&&!u.startsWith('blob:')){report.externalRequests++;return route.abort();}return route.continue();});
 await page.goto(base);await page.waitForFunction(()=>window.RelicNodeStudio?.getCatalog().length>=23);await page.locator('#entrySplash').waitFor({state:'hidden'});
 await page.locator('#sampleButton').click();await page.waitForFunction(()=>!document.getElementById('startButton').disabled);await page.locator('#startButton').click();await page.locator('#studio').waitFor({state:'visible'});
 const id=await page.evaluate(()=>RelicNodeStudio.getWorkflow().nodes.find(n=>n.type==='garment_input').id);await page.locator(`[data-node="${id}"]`).dblclick();await page.locator('#workspace').waitFor({state:'visible'});
 await page.evaluate(async()=>{
  const {makeNode,createBranchGroup,insertNode,upstreamOutput}=await import('/node-studio/core/model.js');
  const {mountWorkspace,workspaceRegistry}=await import('/node-studio/workspaces/index.js');
  const {api}=await import('/node-studio/core/api.js');
  const catalog=RelicNodeStudio.getCatalog();let template=structuredClone(RelicNodeStudio.getWorkflow()),active;
  const source=template.nodes.find(n=>n.type==='garment_input');source.params.flat=source.params.front;source.attachments={top:[],bottom:[]};
  template.nodes=[source];template.order=[source.id];template.routes=[];template.branches=[];template.stash=[];
  for(const def of catalog){if(['garment_input','branch_create','branch_merge'].includes(def.type))continue;const n=makeNode(def.type,catalog);template.nodes.push(n);if(def.placement==='attachment')source.attachments[def.slot||'bottom'].push(n.id);else template.order.push(n.id);}
  template=createBranchGroup(template,template.order.at(-1),catalog);
  const fork=template.nodes.find(n=>n.type==='branch_create');
  for(const route of template.branches){template=insertNode(template,'precision_edit',catalog,{laneId:route.id,at:0});template.nodes.find(n=>n.id===template.selectedNodeId).output=structuredClone(source.output);}
  template.branches.push({id:'third-branch',label:'第三条路线',forkId:fork.id,order:[]});template=insertNode(template,'precision_edit',catalog,{laneId:'third-branch',at:0});template.nodes.find(n=>n.id===template.selectedNodeId).output=structuredClone(source.output);
  const merge=template.nodes.find(n=>n.type==='branch_merge');template=insertNode(template,'blend_create',catalog,{afterId:merge.id});const mergedBlendId=template.selectedNodeId;
  let workflow;
  window.layoutQA={types:Object.keys(workspaceRegistry),async mount(type,completed=false){active?.destroy?.();document.getElementById('workspaceActions').replaceChildren();workflow=structuredClone(template);
   const node=workflow.nodes.find(n=>type==='blend_create'?n.id===mergedBlendId:n.type===type);node.params ||= {};
   if(completed && !['branch_create','branch_merge','blend_create'].includes(type))node.output={...structuredClone(source.output),message:'已完成的合成测试输出'};
   if(type==='image_reference')node.params={images:[source.params.front],activeReferenceIndex:0};
   if(type==='intent_assist'&&completed)node.output={kind:'text',text:'披风下摆增加少量血迹，领巾保持干净'};
   const mount=document.createElement('div');mount.className='ns-workspace-mount';document.getElementById('workspaceContent').replaceChildren(mount);
   document.getElementById('workspaceTitle').textContent=catalog.find(d=>d.type===type).label;
   const context={node,workflow,catalog,definition:catalog.find(d=>d.type===type),api,headerActions:document.getElementById('workspaceActions'),getWorkflow:()=>workflow,getInput:()=>type==='blend_create'?{...structuredClone(source.output),kind:'candidate_set'}:structuredClone(source.output),updateNode(patch){Object.assign(node.params,patch);},saveWorkflow:async()=>workflow,commitOutput:async output=>{node.output=output;},runNode:async()=>{throw Error('Layout smoke must not run a model or node');},openLegacy(){},notify(){},setStatus(){},selectCandidate:id=>workflow.nodes.find(n=>n.id===id)?.output,startMaking(){},startReferenceRoute(){},focusBranch(){},getTextInput(){return{};}};
   active=await mountWorkspace(mount,context);return node.id;},destroy(){active?.destroy?.();}};
 });
 const types=await page.evaluate(()=>layoutQA.types);
 for(const viewport of [{width:1440,height:900},{width:1024,height:700}]){
  await page.setViewportSize(viewport);
  for(const type of types){
   const row={type,viewport:viewport.width+'x'+viewport.height};
   try{await page.evaluate(type=>layoutQA.mount(type),type);await page.waitForTimeout(type==='battle_simulation'?900:100);
    Object.assign(row,await page.evaluate(()=>{
     const root=document.querySelector('.ns-node-workspace'),outer=document.querySelector('#workspaceContent');
     const visible=e=>e.checkVisibility?.({checkVisibilityCSS:true})&&!e.closest('[hidden]');
     function clipped(e){let r=e.getBoundingClientRect(),edges={left:0,top:0,right:innerWidth,bottom:innerHeight};for(let p=e.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();if(/hidden|auto|scroll|clip/.test(s.overflowX)){edges.left=Math.max(edges.left,b.left);edges.right=Math.min(edges.right,b.right);}if(/hidden|auto|scroll|clip/.test(s.overflowY)){edges.top=Math.max(edges.top,b.top);edges.bottom=Math.min(edges.bottom,b.bottom);}}
      return r.width>1&&r.height>1&&(r.top<edges.top-3||r.bottom>edges.bottom+3||r.left<edges.left-3||r.right>edges.right+3);}
     const primaries=[...root.querySelectorAll('button.is-primary')].filter(visible).map(e=>({text:e.textContent.trim(),clipped:clipped(e),disabled:e.disabled}));
     const canvases=[...root.querySelectorAll('canvas:not([aria-hidden=true]),.ns-ws-triangle')].filter(visible).map(e=>{
      const pager=e.closest('.ns-paged-panel')?._relicPager;let cut=clipped(e),reachablePage=null;
      if(cut&&pager){const panel=e.closest('.ns-paged-panel'),original=Number(panel.dataset.page||1)-1;for(let i=0;i<Number(panel.dataset.pages||1);i++){pager.go(i);if(!clipped(e)){cut=false;reachablePage=i+1;break;}}pager.go(original);}
      return{class:e.className,width:Math.round(e.getBoundingClientRect().width),height:Math.round(e.getBoundingClientRect().height),clipped:cut,paginated:!!pager,reachablePage};});
     const scrollbars=[outer,root,...root.querySelectorAll('.ns-ws-body,.ns-ws-stage,.ns-garment-stage')].filter(e=>e&&visible(e)&&/auto|scroll/.test(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight+3).map(e=>e.className||e.id);
     return {mounted:!!root,primaries,canvases,scrollbars,pagers:[...root.querySelectorAll('.ns-paged-panel')].map(e=>({pages:e.dataset.pages,height:e.clientHeight}))};
    }));row.issues=[...row.primaries.filter(x=>x.clipped).map(x=>'primary clipped: '+x.text),...row.canvases.filter(x=>x.clipped).map(x=>'canvas clipped: '+x.class),...row.scrollbars.map(x=>'vertical scroll: '+x)];
    await page.screenshot({path:path.join(out,`${viewport.width}-${type}.png`)});
   }catch(error){row.failure=error.message;row.issues=[error.message];}report.rows.push(row);if(row.issues.length)console.log(JSON.stringify(row));
  }
 }
 report.passed=report.rows.every(r=>!r.issues.length)&&report.errors.length===0;
}catch(error){report.passed=false;report.failure=error.stack;report.serverLog=logs;process.exitCode=1;}
finally{if(browser)await browser.close();server.kill();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,rows:report.rows.length,issues:report.rows.filter(r=>r.issues?.length).map(r=>({type:r.type,viewport:r.viewport,issues:r.issues})),errors:report.errors,externalRequests:report.externalRequests,failure:report.failure},null,2));}})();
