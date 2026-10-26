/* Real app + routes + synthetic model jobs. Never contacts an image provider. */
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const root=path.resolve(__dirname,'..'),out=path.join(root,'work/v0116-generation-qa'),base='http://127.0.0.1:18016';
fs.mkdirSync(out,{recursive:true});const data=fs.mkdtempSync(path.join(out,'isolated-'));
const server=spawn(path.join(root,'.desktop-build/Scripts/python.exe'),['-B','tools/check_generation_results.py','--serve','--data-dir',data,'--port','18016'],{cwd:root,env:{...process.env,PYTHONUTF8:'1'},windowsHide:true});
let logs='';server.stderr.on('data',d=>logs+=d);
const report={checks:[],errors:[],externalRequests:0,paidCalls:0,userImagesUsed:false};let browser,page;
function check(name,value){report.checks.push({name,passed:!!value});assert(value,name);}
async function calls(){return (await (await fetch(base+'/api/test-generation/calls')).json()).calls;}
async function reopen(id){await page.reload();await page.waitForFunction(()=>window.RelicNodeStudio?.getCatalog().length>=23);await page.locator('#entrySplash').waitFor({state:'hidden'});await page.locator('#projectsButton').click();await page.locator(`[data-project="${id}"]`).click();await page.waitForFunction(id=>RelicNodeStudio.getWorkflow()?.id===id,id);}
async function enter(id){await page.locator(`[data-node="${id}"]`).dblclick();await page.locator('#workspace').waitFor({state:'visible'});await page.locator('[data-current-generation]').waitFor();}
async function finish(id,status='succeeded'){await fetch(base+'/api/test-generation/finish/'+id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});}
const current=()=>page.locator('[data-current-generation]').getAttribute('src');
(async()=>{try{
 for(let i=0;i<160;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.route('**/*',route=>{const u=route.request().url();if(!u.startsWith(base)&&!u.startsWith('data:')&&!u.startsWith('blob:')){report.externalRequests++;return route.abort();}return route.continue();});
 await page.goto(base);await page.waitForFunction(()=>window.RelicNodeStudio?.getCatalog().length>=23);await page.locator('#entrySplash').waitFor({state:'hidden'});
 await page.locator('#sampleButton').click();await page.waitForFunction(()=>!document.getElementById('startButton').disabled);await page.locator('#startButton').click();await page.locator('#studio').waitFor({state:'visible'});
 const setup=await page.evaluate(async()=>{
   await RelicNodeStudio.save();const w=RelicNodeStudio.getWorkflow(),{makeNode}=await import('/node-studio/core/model.js'),c=RelicNodeStudio.getCatalog();
   const input=w.nodes.find(n=>n.type==='garment_input'),image=w.nodes.find(n=>n.type==='image_generate'),downstream=makeNode('precision_edit',c);
   input.attachments={top:[],bottom:[]};image.attachments={top:[],bottom:[]};image.params={intent:'披风下摆加一些红色飞溅'};
   const output={kind:'garment',imageUrl:input.params.front.url,reference:input.params.front};
   image.output={...output,brushStrokes:[{id:'test-stroke'}],projectSnapshot:{brushStrokes:[{id:'test-stroke'}]}};image.status='succeeded';downstream.output=output;downstream.status='succeeded';
   w.nodes=[input,image,downstream];w.order=w.nodes.map(n=>n.id);w.routes=[];w.branches=[];w.stash=[];
   const res=await fetch('/api/node-studio/workflows/'+w.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflow:w,expectedRevision:w.revision})});if(!res.ok)throw Error(await res.text());
   return {id:w.id,image:image.id,downstream:downstream.id,reference:input.params.front.url};
 });
 await reopen(setup.id);await enter(setup.image);
 check('entering node makes no model request',(await calls()).length===0);
 check('shared model visible and no per-request checkbox',await page.locator('#ns-image-confirm').count()===0&&(await page.locator('.ns-generation-billing').textContent()).includes('fixture-image'));
 await page.getByRole('button',{name:'生成一版',exact:true}).click();
 await page.waitForFunction(id=>RelicNodeStudio.getWorkflow().nodes.find(n=>n.id===id).output?.jobStatus==='queued',setup.image);
 check('pending keeps main image and disables duplicate submission',(await current())===setup.reference&&await page.getByRole('button',{name:'生成一版',exact:true}).isDisabled());
 check('one click submits one mock cloud image job',(await calls()).length===1);
 await finish('job-autoversion-1');
 await page.waitForFunction(()=>document.querySelector('[data-current-generation]')?.getAttribute('src')==='/data/jobs/job-autoversion-1/result.png');
 check('success replaces main canvas without adoption controls',await page.getByRole('button',{name:'采用这版效果',exact:true}).count()===0);
 check('rasterized result clears replayable marks and invalidates downstream',await page.evaluate(({image,downstream})=>{const w=RelicNodeStudio.getWorkflow(),o=w.nodes.find(n=>n.id===image).output;return !o.brushStrokes.length&&o.projectSnapshot===null&&w.nodes.find(n=>n.id===downstream).status==='stale';},setup));
 await page.screenshot({path:path.join(out,'result-current.png')});
 await reopen(setup.id);await enter(setup.image);
 check('current result survives reload',(await current())==='/data/jobs/job-autoversion-1/result.png');
 const previous=await page.locator('[data-image-versions] option').evaluateAll(options=>options.find(o=>o.value!=='current').value);
 await page.locator('[data-image-versions]').selectOption(previous);await page.waitForFunction(ref=>document.querySelector('[data-current-generation]')?.getAttribute('src')===ref,setup.reference);
 await reopen(setup.id);await enter(setup.image);check('version selection persists and makes no image request',(await current())===setup.reference&&(await calls()).length===1);
 const generated=await page.locator('[data-image-versions] option').evaluateAll(options=>options.find(o=>o.value!=='current').value);
 await page.locator('[data-image-versions]').selectOption(generated);await page.waitForFunction(()=>document.querySelector('[data-current-generation]')?.getAttribute('src')==='/data/jobs/job-autoversion-1/result.png');
 await page.getByRole('button',{name:'生成一版',exact:true}).click();await page.waitForFunction(id=>RelicNodeStudio.getWorkflow().nodes.find(n=>n.id===id).output?.jobStatus==='queued',setup.image);
 check('second queued request keeps prior generated result',(await current())==='/data/jobs/job-autoversion-1/result.png');
 await finish('job-autoversion-2','failed');await page.waitForFunction(id=>RelicNodeStudio.getWorkflow().nodes.find(n=>n.id===id).output?.jobStatus==='failed',setup.image);
 await page.waitForFunction(()=>!document.querySelector('[data-generation-action]')?.disabled);
 check('failure preserves prior result and allows explicit retry',(await current())==='/data/jobs/job-autoversion-1/result.png'&&!await page.getByRole('button',{name:'生成一版',exact:true}).isDisabled());
 await new Promise(resolve=>setTimeout(resolve,1800));check('failure never automatically resubmits',(await calls()).length===2);
 check('no browser errors or external network',report.errors.length===0&&report.externalRequests===0);report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;report.serverLog=logs;process.exitCode=1;}
finally{if(page&&!report.passed)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});if(browser)await browser.close();server.kill();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}})();
