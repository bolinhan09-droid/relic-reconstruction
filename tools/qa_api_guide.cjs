/* Isolated desktop UI onboarding smoke: synthetic storage and no model execution. */
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const root=path.resolve(__dirname,'..'),out=path.join(root,'work/v0117-api-guide'),base='http://127.0.0.1:18117';
fs.mkdirSync(out,{recursive:true});
const data=fs.mkdtempSync(path.join(out,'isolated-'));
const server=spawn(path.join(root,'.desktop-build/Scripts/python.exe'),['-B','-m','uvicorn','app:app','--host','127.0.0.1','--port','18117','--log-level','warning'],{cwd:root,env:{...process.env,RELIC_DATA_DIR:data,PYTHONUTF8:'1'},windowsHide:true});
const report={checks:[],errors:[],externalRequests:0,postRequests:0,temporaryMount:false};let browser,page;
function check(name,value){report.checks.push({name,passed:!!value});assert(value,name);}
async function ready(){
 await page.waitForFunction(()=>window.RelicNodeStudio?.getCatalog().length>=23);await page.locator('#entrySplash').waitFor({state:'hidden'});
 if(await page.locator('#apiGuideButton').count()===0){
  report.temporaryMount=true;
  await page.evaluate(async()=>{const {mountApiGuide}=await import('/node-studio/components/api-guide.js');window.qaGuide=mountApiGuide({openSettings:section=>window.dispatchEvent(new CustomEvent('relic-open-ai-settings',{detail:{section}}))});});
 }
}
(async()=>{try{
 for(let i=0;i<160;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});page=await browser.newPage({viewport:{width:1440,height:900}});
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.route('**/*',route=>{
  const request=route.request(),u=request.url();
  if(!u.startsWith(base)&&!u.startsWith('data:')&&!u.startsWith('blob:')){report.externalRequests++;return route.abort();}
  if(request.method()==='POST'){report.postRequests++;return route.fulfill({status:418,contentType:'application/json',body:'{"detail":"QA blocks POSTs"}'});}
  return route.continue();
 });
 await page.goto(base);await ready();
 const guide=page.locator('.ns-api-guide-dialog'),settings=page.locator('.ns-global-ai-dialog');
 check('first launch has no forced guide',!await guide.isVisible());
 check('API entry and existing guided practice remain available',await page.locator('#apiGuideButton').isVisible()&&await page.locator('#startPracticeButton').isVisible());
 await page.locator('#apiGuideButton').click();check('guide begins with settings location',await guide.getByText('入口在左上角',{exact:true}).isVisible());
 await page.screenshot({path:path.join(out,'guide-location.png')});
 await page.keyboard.press('Tab');check('keyboard stays in guide',await guide.evaluate(el=>el.contains(document.activeElement)));
 await guide.getByRole('button',{name:'下一步',exact:true}).click();
 await guide.getByRole('button',{name:'图像生成',exact:false}).click();
 await guide.getByRole('button',{name:'下一步',exact:true}).click();
 await guide.getByText('使用千问 / 阿里云百炼',{exact:true}).click();
 check('Qwen help matches region and workspace fields',(await guide.innerText()).includes('百炼工作空间 ID')&&(await guide.innerText()).includes('地域'));
 check('Qwen help uses only official Alibaba links',(await guide.locator('a').evaluateAll(links=>links.map(a=>new URL(a.href).hostname))).every(host=>host==='bailian.console.aliyun.com'||host==='help.aliyun.com'));
 await page.screenshot({path:path.join(out,'guide-qwen.png')});
 await guide.getByRole('button',{name:'去填写 API',exact:true}).click();
 await settings.locator('#global-image-secret').waitFor();
 check('finishing opens the selected settings tab directly',!await guide.isVisible()&&await page.locator('#global-ai-tab-image').getAttribute('aria-selected')==='true');
 check('first settings visit expands brief help',await settings.locator('.ns-global-api-hint').evaluate(el=>el.open));
 await settings.locator('select').first().selectOption('qwen');
 check('Qwen form exposes workspace ID',await settings.getByLabel('百炼工作空间 ID',{exact:true}).isVisible());
 await page.screenshot({path:path.join(out,'settings-first-use.png')});
 await page.keyboard.press('Escape');check('settings closes without changing entry',!await settings.isVisible()&&await page.locator('#onboardingOffer').isVisible());
 await page.locator('#aiSettingsButton').click();await settings.locator('input[type=password]').waitFor();
 check('next settings visit keeps help collapsed',!await settings.locator('.ns-global-api-hint').evaluate(el=>el.open));
 await settings.locator('.ns-global-api-hint summary').click();
 await settings.getByRole('button',{name:'查看 3 步引导',exact:true}).click();
 await page.keyboard.press('Escape');check('Escape returns to open settings and replay trigger',!await guide.isVisible()&&await settings.isVisible()&&await settings.getByRole('button',{name:'查看 3 步引导',exact:true}).evaluate(el=>el===document.activeElement));
 await page.keyboard.press('Escape');check('settings restores main trigger',await page.locator('#aiSettingsButton').evaluate(el=>el===document.activeElement));
 await page.locator('#apiGuideButton').click();await guide.getByRole('button',{name:'暂时跳过',exact:true}).click();
 check('skip closes and remembers only seen state',!await guide.isVisible()&&await page.evaluate(()=>localStorage.getItem('relic-api-guide-v1')==='seen'));
 await page.reload();await ready();check('refresh does not reopen skipped guide',!await guide.isVisible()&&await page.locator('#apiGuideButton').getAttribute('data-first-use')==='false');
 await page.locator('#helpButton').click();await page.locator('#replayApiGuideButton').click();check('help replays from the beginning',await guide.getAttribute('data-step')==='0');
 await guide.getByRole('button',{name:'下一步',exact:true}).click();await guide.getByRole('button',{name:'下一步',exact:true}).click();
 check('guide states runtime-only secret policy',(await guide.innerText()).includes('重启后需重新填写')&&(await guide.innerText()).includes('不会自动生成'));
 await page.setViewportSize({width:1024,height:700});
 check('small desktop keeps action visible',await guide.getByRole('button',{name:'去填写 API',exact:true}).evaluate(el=>{const r=el.getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0;}));
 await page.screenshot({path:path.join(out,'guide-small-desktop.png')});
 await page.keyboard.press('Escape');check('Escape preserves the underlying Help dialog',await page.locator('#helpDialog').isVisible()&&!await guide.isVisible());
 check('guide storage contains no API payload',await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('relic-api-')).every(k=>localStorage.getItem(k)==='seen')));
 check('no writes, external calls or runtime errors',report.postRequests===0&&report.externalRequests===0&&report.errors.length===0);
 report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;process.exitCode=1;}
finally{if(browser)await browser.close();server.kill();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}})();
