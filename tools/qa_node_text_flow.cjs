/* Actual UI -> saved workflow -> actual node API, with model transports mocked. */
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const root=path.resolve(__dirname,'..'),out=path.join(root,'work/v0113-text-flow-qa'),base='http://127.0.0.1:18013';
fs.mkdirSync(out,{recursive:true});const data=fs.mkdtempSync(path.join(out,'isolated-'));
const server=spawn(path.join(root,'.desktop-build/Scripts/python.exe'),['-B','tools/check_node_text_flow.py','--serve','--data-dir',data,'--port','18013'],{cwd:root,env:{...process.env,PYTHONUTF8:'1'},windowsHide:true});
let logs='';server.stderr.on('data',d=>logs+=d);
const report={checks:[],errors:[],externalRequests:0,paidCalls:0};let browser,page;
function check(name,value){report.checks.push({name,passed:!!value});assert(value,name);}
async function calls(){return (await (await fetch(base+'/api/test-text/calls')).json()).calls;}
async function reopen(id){await page.reload();await page.waitForFunction(()=>window.RelicNodeStudio?.getCatalog().length>=23);await page.locator('#entrySplash').waitFor({state:'hidden'});await page.locator('#projectsButton').click();await page.locator(`[data-project="${id}"]`).click();await page.waitForFunction(id=>RelicNodeStudio.getWorkflow()?.id===id,id);}
async function enter(id){await page.locator(`[data-node="${id}"]`).dblclick();await page.locator('#workspace').waitFor({state:'visible'});}
async function leave(){await page.locator('#leaveWorkspace').click();await page.locator('#workspace').waitFor({state:'hidden'});}
(async()=>{try{
 for(let i=0;i<160;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.route('**/*',route=>{const u=route.request().url();if(!u.startsWith(base)&&!u.startsWith('data:')&&!u.startsWith('blob:')){report.externalRequests++;return route.abort();}return route.continue();});
 await page.goto(base);await page.waitForFunction(()=>window.RelicNodeStudio?.getCatalog().length>=23);await page.locator('#entrySplash').waitFor({state:'hidden'});
 await page.locator('#sampleButton').click();await page.waitForFunction(()=>!document.getElementById('startButton').disabled);await page.locator('#startButton').click();await page.locator('#studio').waitFor({state:'visible'});
 const setup=await page.evaluate(async()=>{
   await RelicNodeStudio.save();const w=RelicNodeStudio.getWorkflow(),{makeNode}=await import('/node-studio/core/model.js'),c=RelicNodeStudio.getCatalog();
   const input=w.nodes.find(n=>n.type==='garment_input'),image=w.nodes.find(n=>n.type==='image_generate'),intent=makeNode('intent_assist',c);
   input.attachments={top:[],bottom:[]};image.attachments={top:[],bottom:[]};image.params={};intent.params={intent:'绿色血迹，领巾保持干净'};
   w.nodes=[input,intent,image];w.order=w.nodes.map(n=>n.id);w.routes=[];w.branches=[];w.stash=[];
   const res=await fetch('/api/node-studio/workflows/'+w.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflow:w,expectedRevision:w.revision})});if(!res.ok)throw Error(await res.text());
   return {id:w.id,intent:intent.id,image:image.id,reference:input.params.front.url};
 });
 await reopen(setup.id);await enter(setup.intent);await page.getByRole('button',{name:'一起整理想法',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-intent-output]')?.value.includes('绿色飞溅'));
 check('AI result is immediately published as readable output',(await calls()).filter(x=>x.kind==='assistant').length===1);
 await page.locator('[data-intent-output]').fill('披风下摆改为蓝色浸染，白色领巾留白');await page.getByRole('button',{name:'保存文字输出',exact:true}).click();
 await page.waitForFunction(id=>RelicNodeStudio.getWorkflow().nodes.find(n=>n.id===id).output?.text.includes('蓝色浸染'),setup.intent);await leave();
 check('label displays a text output summary',(await page.locator(`[data-node="${setup.intent}"]`).innerText()).includes('文字输出'));
 check('editing and connecting do not generate an image',(await calls()).filter(x=>x.kind==='image').length===0);
 await enter(setup.image);await page.locator('[data-upstream-text]').waitFor();
 check('generation reads the edited upstream text',await page.locator('[data-upstream-text]').inputValue()==='披风下摆改为蓝色浸染，白色领巾留白');
 await page.getByLabel('本次补充',{exact:true}).fill('袖口保持干净');
 check('image workspace uses shared connection without model or key form',await page.locator('#workspace input[type=password]').count()===0&&await page.locator('#workspace input[id*="-model-"]').count()===0);
 await page.getByRole('button',{name:'生成一版',exact:true}).click();
 for(let i=0;i<100&&!(await calls()).some(c=>c.kind==='image');i++)await new Promise(r=>setTimeout(r,100));
 const imageCall=(await calls()).find(x=>x.kind==='image');
 check('actual image payload consumes inherited text plus separate extra requirements',imageCall.prompt.includes('蓝色浸染')&&imageCall.prompt.includes('袖口保持干净')&&!imageCall.prompt.includes('绿色飞溅'));
 check('image input remains the original garment',imageCall.reference===setup.reference);
 await page.screenshot({path:path.join(out,'generation-text-input.png')});await leave();await reopen(setup.id);await enter(setup.image);
 check('upstream output and extra requirements survive reopening',await page.locator('[data-upstream-text]').inputValue()==='披风下摆改为蓝色浸染，白色领巾留白'&&await page.getByLabel('本次补充',{exact:true}).inputValue()==='袖口保持干净');
 await leave();await enter(setup.intent);await page.locator('[data-intent-output]').fill('披风改为紫色飞溅');await page.getByRole('button',{name:'保存文字输出',exact:true}).click();
 await page.waitForFunction(id=>RelicNodeStudio.getWorkflow().nodes.find(n=>n.id===id).status==='stale',setup.image);await leave();await enter(setup.image);
 check('editing upstream marks existing generation stale and updates the input',await page.locator('[data-upstream-text]').inputValue()==='披风改为紫色飞溅'&&await page.getByLabel('本次补充',{exact:true}).inputValue()==='袖口保持干净');
 check('reopen and upstream edits do not automatically generate',(await calls()).filter(x=>x.kind==='image').length===1);
 check('no browser errors or external network',report.errors.length===0&&report.externalRequests===0);
 report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;report.serverLog=logs;process.exitCode=1;}
finally{if(page&&!report.passed)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});if(browser)await browser.close();server.kill();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}})();
