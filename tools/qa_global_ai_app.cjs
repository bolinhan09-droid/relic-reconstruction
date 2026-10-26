/* Actual desktop web UI + isolated backend; mock keys are configured, never used. */
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const root=path.resolve(__dirname,'..'),out=path.join(root,'work/v0113-global-ai-app'),base='http://127.0.0.1:18113';fs.mkdirSync(out,{recursive:true});
const data=fs.mkdtempSync(path.join(out,'isolated-'));
const server=spawn(path.join(root,'.desktop-build/Scripts/python.exe'),['-B','-m','uvicorn','app:app','--host','127.0.0.1','--port','18113','--log-level','warning'],{cwd:root,env:{...process.env,RELIC_DATA_DIR:data,PYTHONUTF8:'1'},windowsHide:true});
const report={checks:[],errors:[],externalRequests:0,modelCalls:0};let browser,page;
function check(name,value){report.checks.push({name,passed:!!value});assert(value,name);}
(async()=>{try{
 for(let i=0;i<160;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.route('**/*',route=>{
  const u=route.request().url();if(!u.startsWith(base)&&!u.startsWith('data:')&&!u.startsWith('blob:')){report.externalRequests++;return route.abort();}
  if(route.request().method()==='POST'&&/\/api\/(?:node-research\/(?:identify|scenes)|assistant\/chat|node-studio\/workflows\/[^/]+\/nodes\/[^/]+\/run|jobs|generate)/.test(u)){report.modelCalls++;return route.fulfill({status:418,contentType:'application/json',body:'{"detail":"QA blocks model execution"}'});}
  route.continue();
 });
 await page.goto(base);await page.waitForFunction(()=>window.RelicNodeStudio?.getCatalog().length>=23);await page.locator('#entrySplash').waitFor({state:'hidden'});
 await page.locator('#aiSettingsButton').click();await page.locator('.ns-global-ai-dialog input[type=password]').waitFor();
 await page.locator('.ns-global-ai-dialog input[type=password]').fill('fake-app-assistant-key');await page.getByRole('button',{name:'保存连接',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.ns-global-ai-dialog>.ns-ws-status').textContent.includes('已保存'));
 await page.screenshot({path:path.join(out,'global-ai-settings.png')});
 await page.keyboard.press('Escape');check('entry settings escape restores trigger',await page.locator('#aiSettingsButton').evaluate(el=>el===document.activeElement)&&!await page.locator('.ns-global-ai-dialog').isVisible());
 await page.locator('#sampleButton').click();await page.waitForFunction(()=>!document.getElementById('startButton').disabled);await page.locator('#startButton').click();await page.locator('#studio').waitFor({state:'visible'});
 const setup=await page.evaluate(async()=>{
  await RelicNodeStudio.save();const w=RelicNodeStudio.getWorkflow(),{makeNode}=await import('/node-studio/core/model.js'),c=RelicNodeStudio.getCatalog();const ids={};
  for(const type of ['intent_assist','design_advice','character_research']){const n=makeNode(type,c);w.nodes.push(n);w.order.push(n.id);ids[type]=n.id;}
  const res=await fetch('/api/node-studio/workflows/'+w.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflow:w,expectedRevision:w.revision})});if(!res.ok)throw Error(await res.text());
  return {id:w.id,ids,image:w.nodes.find(n=>n.type==='image_generate').id};
 });
 await page.reload();await page.waitForFunction(()=>RelicNodeStudio.getCatalog().length>=23);await page.locator('#entrySplash').waitFor({state:'hidden'});await page.locator('#projectsButton').click();await page.locator(`[data-project="${setup.id}"]`).click();await page.waitForFunction(id=>RelicNodeStudio.getWorkflow()?.id===id,setup.id);
 for(const type of ['intent_assist','design_advice']){
  await page.evaluate(id=>RelicNodeStudio.openNode(id),setup.ids[type]);await page.locator('.ns-ai-connection-status').waitFor();
  check(type+' uses shared assistant without a key form',(await page.locator('.ns-ai-connection-status').innerText()).includes('使用全局连接')&&await page.locator('#workspace input[type=password]').count()===0);
  await page.locator('#workspaceAiSettingsButton').click();await page.locator('.ns-global-ai-dialog').waitFor({state:'visible'});await page.keyboard.press('Escape');
  check(type+' settings escape stays in node and restores trigger',await page.locator('#workspace').isVisible()&&await page.locator('#workspaceAiSettingsButton').evaluate(el=>el===document.activeElement));
  await page.locator('#leaveWorkspace').click();await page.locator('#workspace').waitFor({state:'hidden'});
 }
 await page.evaluate(id=>RelicNodeStudio.openNode(id),setup.ids.character_research);await page.getByRole('button',{name:'AI 设置',exact:true}).last().waitFor();
 check('role recognition also uses shared configuration without skipping image consent',await page.locator('#workspace input[type=password]').count()===0&&await page.locator('#ns-research-consent').count()===1);
 await page.locator('#leaveWorkspace').click();await page.locator('#workspace').waitFor({state:'hidden'});
 await page.evaluate(id=>RelicNodeStudio.openNode(id),setup.image);await page.locator('#workspace .ns-ai-connection-status').waitFor();
 check('image node has no API or model entry form',await page.locator('#workspace input[type=password]').count()===0&&await page.locator('#workspace input[id*="-model-"]').count()===0);
 await page.locator('#workspace .ns-ai-connection-row button').click();await page.getByRole('tab',{name:'图像生成',exact:true}).waitFor();
 await page.locator('#global-image-secret').fill('fake-app-image-key');await page.getByRole('button',{name:'保存图像连接',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#workspace .ns-ai-connection-status').textContent.includes('使用全局连接'));
 await page.keyboard.press('Escape');await page.screenshot({path:path.join(out,'image-global-connection.png')});
 check('saving global image configuration refreshes currently open node',await page.locator('#workspace .ns-ai-connection-status').innerText().then(s=>s.includes('GPT 图像')&&s.includes('使用全局连接')));
 check('no creation or model calls on settings, opening or saving',report.modelCalls===0&&report.externalRequests===0&&report.errors.length===0);
 report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;process.exitCode=1;}
finally{if(browser)await browser.close();server.kill();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}})();
