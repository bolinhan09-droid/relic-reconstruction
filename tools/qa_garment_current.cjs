/* Real polygon extraction and four-point flattening, using only a synthetic sample. */
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const root=path.resolve(__dirname,'..'),out=path.join(root,'work/v0116-garment-qa'),base='http://127.0.0.1:18017';
fs.mkdirSync(out,{recursive:true});const data=fs.mkdtempSync(path.join(out,'isolated-'));
const server=spawn(path.join(root,'.desktop-build/Scripts/python.exe'),['-B','tools/check_generation_results.py','--serve','--data-dir',data,'--port','18017'],{cwd:root,env:{...process.env,PYTHONUTF8:'1'},windowsHide:true});
let logs='';server.stderr.on('data',d=>logs+=d);let browser,page;
const report={checks:[],errors:[],paidCalls:0,userImagesUsed:false,externalRequests:0};
function check(name,value){report.checks.push({name,passed:!!value});assert(value,name);}
async function reopen(id){await page.reload();await page.waitForFunction(()=>window.RelicNodeStudio?.getCatalog().length>=23);await page.locator('#entrySplash').waitFor({state:'hidden'});await page.locator('#projectsButton').click();await page.locator(`[data-project="${id}"]`).click();await page.waitForFunction(id=>RelicNodeStudio.getWorkflow()?.id===id,id);}
async function enter(id){await page.locator(`[data-node="${id}"]`).dblclick();await page.locator('#workspace').waitFor({state:'visible'});await page.locator('.ns-garment-selection').waitFor({state:'attached'});}
(async()=>{try{
 for(let i=0;i<160;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 page.on('pageerror',e=>report.errors.push(e.message));await page.route('**/*',route=>{const u=route.request().url();if(!u.startsWith(base)&&!u.startsWith('data:')&&!u.startsWith('blob:')){report.externalRequests++;return route.abort();}return route.continue();});
 await page.goto(base);await page.waitForFunction(()=>window.RelicNodeStudio?.getCatalog().length>=23);await page.locator('#entrySplash').waitFor({state:'hidden'});
 await page.locator('#sampleButton').click();await page.waitForFunction(()=>!document.getElementById('startButton').disabled);await page.locator('#startButton').click();await page.locator('#studio').waitFor({state:'visible'});
 const setup=await page.evaluate(async()=>{
  await RelicNodeStudio.save();const w=RelicNodeStudio.getWorkflow(),{makeNode}=await import('/node-studio/core/model.js'),c=RelicNodeStudio.getCatalog();
  const input=w.nodes.find(n=>n.type==='garment_input'),split=makeNode('garment_split',c),flat=makeNode('garment_flatten',c);input.attachments={top:[],bottom:[]};
  split.params={method:'polygon',partName:'测试披风',selection:{polygon:[{x:.2,y:.2},{x:.8,y:.2},{x:.8,y:.8},{x:.2,y:.8}]}};
  flat.params={method:'geometry',selection:{quad:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]}};
  w.nodes=[input,split,flat];w.order=w.nodes.map(n=>n.id);w.routes=[];w.branches=[];w.stash=[];
  const res=await fetch('/api/node-studio/workflows/'+w.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflow:w,expectedRevision:w.revision})});if(!res.ok)throw Error(await res.text());return{id:w.id,split:split.id,flat:flat.id};
 });
 await reopen(setup.id);await enter(setup.split);check('selection starts on main canvas',await page.locator('.ns-garment-selection').isVisible());
 await page.getByRole('button',{name:'提取服装部件',exact:true}).click();await page.locator('[data-garment-current]').waitFor({state:'visible'});
 check('split result automatically replaces main canvas',!await page.locator('.ns-garment-selection').isVisible()&&await page.locator('[data-garment-current]').getAttribute('src'));
 check('no adopt confirmation remains',await page.getByRole('button',{name:'采用这个结果',exact:true}).count()===0);
 await page.getByRole('button',{name:'选区',exact:true}).click();check('small view tab restores selection for further editing',await page.locator('.ns-garment-selection').isVisible());
 await page.getByRole('button',{name:'当前结果',exact:true}).click();await page.screenshot({path:path.join(out,'split-current.png')});
 await page.waitForFunction(id=>!RelicNodeStudio.getWorkflow().nodes.find(n=>n.id===id).params.pendingGarmentJobId,setup.split);await page.locator('#leaveWorkspace').click();await enter(setup.flat);
 await page.getByRole('button',{name:'展开衣片',exact:true}).click();await page.locator('[data-garment-current]').waitFor({state:'visible'});
 check('four-point flattening automatically becomes current output',await page.evaluate(id=>RelicNodeStudio.getWorkflow().nodes.find(n=>n.id===id).output?.view==='flat_reference',setup.flat));
 await page.waitForFunction(id=>!RelicNodeStudio.getWorkflow().nodes.find(n=>n.id===id).params.pendingGarmentJobId,setup.flat);
 await reopen(setup.id);await enter(setup.flat);check('flattened output persists and opens in same main canvas',await page.locator('[data-garment-current]').isVisible());
 check('successful output remains completed after recovery marker is cleared',await page.evaluate(id=>['completed','succeeded'].includes(RelicNodeStudio.getWorkflow().nodes.find(n=>n.id===id).status),setup.flat));
 await page.screenshot({path:path.join(out,'flatten-current.png')});
 check('no browser errors or external requests',report.errors.length===0&&report.externalRequests===0);report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;report.serverLog=logs;process.exitCode=1;}
finally{if(page&&!report.passed)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});if(browser)await browser.close();server.kill();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}})();
