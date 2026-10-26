/* Real embedded editor, gestures, undo and persistence; bundled demo only. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.RELIC_QA_PLAYWRIGHT||'C:/Users/lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const root=path.resolve(__dirname,'..'),out=path.join(root,'work/v0116-blood-check'),port=Number(process.env.RELIC_QA_PORT||18136),base=`http://127.0.0.1:${port}`;
fs.mkdirSync(out,{recursive:true});const data=fs.mkdtempSync(path.join(out,'workbench-isolated-'));
const server=spawn(process.env.RELIC_QA_PYTHON||path.join(root,'.desktop-build/Scripts/python.exe'),['-B','-m','uvicorn','app:app','--host','127.0.0.1','--port',String(port),'--log-level','warning'],{cwd:root,env:{...process.env,RELIC_DATA_DIR:data,PYTHONUTF8:'1'},windowsHide:true});
let logs='',browser,page;server.stderr.on('data',v=>logs+=v.toString());
const report={checks:[],errors:[],externalRequests:0,modelCalls:0,isolatedData:data};
const check=(name,value,detail)=>{report.checks.push({name,passed:!!value,...(detail?{detail}:{})});assert(value,name);};
async function reveal(frame,selector){await frame.locator(selector).evaluate(el=>{for(let p=el.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;el.dispatchEvent(new CustomEvent('relic:reveal',{bubbles:true}));});await page.waitForTimeout(100);}
async function snapshot(name){await page.screenshot({path:path.join(out,name+'.png')});}
async function readyFrame(){await page.waitForFunction(()=>document.querySelector('#workspace iframe')?.contentWindow?.RelicNodeWorkspace?.getPracticeState?.().ready);return page.frames().find(f=>f.url().includes('nodeEmbed=1'));}
async function slider(frame,id,value){await reveal(frame,'#'+id);await frame.locator('#'+id).evaluate((el,v)=>{el.value=String(v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},value);await page.waitForTimeout(150);}
(async()=>{try{
  let healthy=false;for(let i=0;i<180;i++){try{healthy=(await fetch(base+'/api/health')).ok;if(healthy)break;}catch{}if(server.exitCode!==null)throw Error('Isolated backend exited');await new Promise(r=>setTimeout(r,100));}assert(healthy,'Isolated backend ready');
  browser=await chromium.launch({executablePath:process.env.RELIC_QA_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  page=await browser.newPage({viewport:{width:1440,height:940},reducedMotion:'reduce'});page.setDefaultTimeout(25000);page.on('pageerror',e=>report.errors.push(e.message));page.on('dialog',d=>d.dismiss());
  await page.route('**/*',route=>{const r=route.request(),u=r.url();if(!u.startsWith(base)&&!u.startsWith('data:')&&!u.startsWith('blob:')){report.externalRequests++;return route.abort();}if(r.method()==='POST'&&/\/api\/(?:node-research\/(?:identify|scenes)|assistant\/chat|node-studio\/workflows\/[^/]+\/nodes\/[^/]+\/run|jobs|generate)/.test(u)){report.modelCalls++;return route.abort();}return route.continue();});
  await page.goto(base);await page.waitForFunction(()=>window.RelicNodeStudio?.getCatalog().length>=20);await page.locator('#entrySplash').waitFor({state:'hidden'});
  await page.locator('#startPracticeButton').click();await page.locator('#practiceSkip').click();
  const workflow=await page.evaluate(()=>RelicNodeStudio.getWorkflow()),id=workflow.nodes.find(n=>n.type==='precision_edit').id;
  await page.locator(`[data-node="${id}"]`).dblclick();let frame=await readyFrame();
  await frame.evaluate(()=>selectBrush('blood'));await reveal(frame,'[data-blood-preset="wide"]');await frame.locator('[data-blood-preset="wide"]').click();
  check('large-area preset selects coverage, amount and fan directly',await frame.evaluate(()=>state.bloodSettings.coverage===.92&&state.bloodSettings.spread===.82&&state.bloodSettings.amount===.84));
  const bounds=await frame.locator('#brushCanvas').boundingBox();assert(bounds?.height>150);
  await page.mouse.move(bounds.x+bounds.width*.35,bounds.y+bounds.height*.32);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.65,bounds.y+bounds.height*.53,{steps:12});await page.mouse.up();
  await frame.waitForFunction(()=>state.brushStrokes.length===1);
  const first=await frame.evaluate(()=>state.brushStrokes[0]);check('real drag produces one editable broad splatter',first.bloodParameters.coverage===.92&&first.points.length===2&&first.shapes.length>120);
  await reveal(frame,'#bloodCoverage');await snapshot('workbench-wide-1440');
  await slider(frame,'bloodCoverage',32);const changed=await frame.evaluate(()=>state.brushStrokes[0]);
  check('releasing coverage updates the selected impact without an Apply button',changed.bloodParameters.coverage===.32&&changed.id===first.id&&JSON.stringify(changed.shapes)!==JSON.stringify(first.shapes));
  check('changing coverage preserves recorded drag force and seed',changed.bloodParameters.force===first.bloodParameters.force&&changed.seed===first.seed);
  await reveal(frame,'#brushUndo');await frame.locator('#brushUndo').click();check('single undo restores exact geometry',await frame.evaluate(v=>JSON.stringify(state.brushStrokes[0])===JSON.stringify(v),first));
  await slider(frame,'bloodForce',65);check('explicit force change updates the selected layer',await frame.evaluate(()=>state.brushStrokes.length===1&&state.brushStrokes[0].bloodParameters.force===.65));
  await reveal(frame,'#brushUndo');await frame.locator('#brushUndo').click();
  const paging=[];
  for(const viewport of [{width:1440,height:940},{width:1024,height:700}]){
    await page.setViewportSize(viewport);await page.waitForTimeout(250);
    for(const selector of ['[data-blood-preset="wide"]','#bloodForce','#bloodCoverage','#bloodAmount','#bloodSpread','#bloodDirection']){
      await reveal(frame,selector);
      const metrics=await frame.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect(),panel=el.closest('.ns-paged-panel'),v=panel?.querySelector('.ns-page-viewport')?.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,frameHeight:innerHeight,pages:panel?.dataset.pages,inside:!!v&&r.top>=v.top-1&&r.bottom<=v.bottom+1};});
      paging.push({viewport,selector,...metrics});
      check(`blood control ${selector} reachable at ${viewport.width}`,metrics.inside&&metrics.height>0,paging.at(-1));
    }
    const inventory=await frame.evaluate(()=>{
      const panel=document.querySelector('.control-panel');panel.querySelectorAll('details').forEach(el=>el.open=true);
      return [...panel.querySelectorAll('.ns-page-content button,.ns-page-content select,.ns-page-content input:not([type=hidden]),.ns-page-content textarea,.ns-page-content summary')].filter(el=>el.getBoundingClientRect().height>0).map((el,i)=>{el.dataset.qaControl=String(i);return {index:i,label:el.id||el.getAttribute('aria-label')||el.textContent.trim().slice(0,40)};});
    });
    await page.waitForTimeout(180);const unreachable=[];
    for(const item of inventory){
      await reveal(frame,`[data-qa-control="${item.index}"]`);
      const inside=await frame.locator(`[data-qa-control="${item.index}"]`).evaluate(el=>{const r=el.getBoundingClientRect(),v=el.closest('.ns-paged-panel')?.querySelector('.ns-page-viewport')?.getBoundingClientRect();return !!v&&r.top>=v.top-1&&r.bottom<=v.bottom+1&&r.left>=v.left-1&&r.right<=v.right+1;});
      if(!inside)unreachable.push(item.label);
    }
    check(`all ${inventory.length} expanded sidebar controls reachable at ${viewport.width}`,!unreachable.length,unreachable);
    await reveal(frame,'#bloodCoverage');await snapshot('workbench-wide-'+viewport.width);
  }
  await page.setViewportSize({width:1440,height:940});await page.locator('#saveWorkspace').click();
  await page.waitForFunction(value=>RelicNodeStudio.getWorkflow().nodes.find(n=>n.id===value)?.output?.brushStrokes?.length===1,id);
  const saved=await page.evaluate(value=>RelicNodeStudio.getWorkflow().nodes.find(n=>n.id===value).output,id);
  check('node output persists coverage and editable geometry',saved.brushStrokes[0].bloodParameters.coverage===.92&&JSON.stringify(saved.brushStrokes[0].shapes)===JSON.stringify(first.shapes));
  const asset=await fetch(base+saved.imageUrl);assert(asset.ok);fs.writeFileSync(path.join(out,'workbench-saved-guide.png'),Buffer.from(await asset.arrayBuffer()));
  await page.locator('#leaveWorkspace').click();await page.locator('#workspace').waitFor({state:'hidden'});await page.locator(`[data-node="${id}"]`).dblclick();frame=await readyFrame();
  const reopened=await frame.evaluate(()=>state.brushStrokes[0]);assert.deepEqual(reopened.shapes,first.shapes);
  check('reopening preserves the output instead of redrawing with a new seed',reopened.seed===first.seed&&reopened.bloodParameters.coverage===first.bloodParameters.coverage);
  check('no paid calls, external requests or browser exceptions',report.modelCalls===0&&report.externalRequests===0&&report.errors.length===0);
  report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;report.serverLog=logs.slice(-3500);process.exitCode=1;if(page)await snapshot('workbench-failure').catch(()=>{});}finally{await browser?.close();server.kill();fs.writeFileSync(path.join(out,'workbench-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}})();
