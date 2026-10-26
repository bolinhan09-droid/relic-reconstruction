/* Browser UI checks with in-memory fake settings. No API key or paid call. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const root=path.resolve(__dirname,'..'),out=path.join(root,'work/v0113-global-ai');fs.mkdirSync(out,{recursive:true});
const report={checks:[],errors:[],externalRequests:0};
function check(name,passed){report.checks.push({name,passed:!!passed});assert(passed,name);}
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1300,height:950}});page.on('pageerror',e=>report.errors.push(e.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!=='http://relic.test'){report.externalRequests++;return route.abort();}
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><meta charset="utf-8"><body><button id="launch">AI 设置</button><main id="assistant"></main><main id="image"></main></body></html>'});
   const file=path.resolve(root,'web','.'+decodeURIComponent(url.pathname));assert(file.startsWith(path.resolve(root,'web')+path.sep));
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/plain',body:fs.readFileSync(file)});
  });
  await page.goto('http://relic.test/');
  await page.evaluate(async()=>{
   const {mountGlobalAiSettings}=await import('/node-studio/components/global-ai-settings.js');
   const {assistantSettings}=await import('/node-studio/workspaces/assistant-settings.js');
   const {imageConnection}=await import('/node-studio/workspaces/image-connection.js');
   window.calls=[];window.params=[];window.messages=[];
   window.addEventListener('relic-ai-settings-changed',e=>messages.push(structuredClone(e.detail)));
   let assistant={provider:'deepseek',model:'deepseek-flash',baseUrl:'https://api.deepseek.com/v1',vision:true,ready:false,hasKey:false};
   let images={provider:'openai',providers:{openai:{provider:'openai',model:'gpt-image-2',quality:'medium',ready:false,hasKey:false},qwen:{provider:'qwen',model:'qwen-image-3.0-pro',quality:'auto',ready:false,hasKey:false},local_openai:{provider:'local_openai',model:'sd-cpp-local',baseUrl:'http://127.0.0.1:8190/v1',quality:'auto',ready:true},openai_compatible:{provider:'openai_compatible',model:'gpt-image-2',quality:'medium',ready:false}}};
   window.settingsApi=async(method,url,payload)=>{
    calls.push({method,url,payload:payload?structuredClone(payload):null});
    if(url==='/api/assistant/settings'){
     if(method==='POST'){const {apiKey,...publicFields}=payload;assistant={...publicFields,ready:!!apiKey||assistant.ready,hasKey:!!apiKey||assistant.hasKey};}return structuredClone(assistant);
    }
    if(url==='/api/settings/ai'){
     if(method==='POST'){const {apiKey,...publicFields}=payload;images.provider=publicFields.provider;images.providers[publicFields.provider]={...publicFields,ready:!!apiKey,hasKey:!!apiKey};}return structuredClone(images);
    }
    if(url==='/api/node-research/settings')return {...structuredClone(assistant),visionReady:assistant.ready&&assistant.vision};
    throw Error('Unexpected request '+url);
   };
   function host(id){const root=document.getElementById(id),controller=new AbortController();root.dataset.workspace=id;const params={};return {root,params,signal:controller.signal,on(t,e,h){t.addEventListener(e,h,{signal:controller.signal});},cleanup(f){controller.signal.addEventListener('abort',f);},say(){},patch(p){Object.assign(params,p);window.params.push(structuredClone(p));},button(label,fn){const b=document.createElement('button');b.textContent=label;b.onclick=fn;return b;}};}
   window.globalSettings=mountGlobalAiSettings({api:settingsApi});
   const a=await assistantSettings(host('assistant'),{api:settingsApi,node:{id:'a'}});document.getElementById('assistant').append(a.element);
   window.imageService=await imageConnection(host('image'),{api:settingsApi,node:{id:'i'}});document.getElementById('image').append(imageService.element);
   document.getElementById('launch').onclick=()=>globalSettings.open('assistant');
  });
  check('node views contain no credential or model fields',await page.locator('main input[type=password]').count()===0&&await page.locator('main input[type=text]').count()===0);
  await page.locator('#launch').click();await page.locator('.ns-global-ai-dialog input[type=password]').waitFor();
  check('global assistant form pre-fills model and hides advanced options',await page.locator('.ns-global-ai-dialog input[id*=_assistantModel]').inputValue()==='deepseek-flash'&&!await page.locator('.ns-global-ai-dialog input[id*=_assistantModel]').isVisible());
  await page.locator('.ns-global-ai-dialog input[type=password]').fill('fake-global-assistant-key');await page.getByRole('button',{name:'保存连接',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#assistant').textContent.includes('使用全局连接'));
  check('one shared save refreshes assistant node',await page.evaluate(()=>calls.filter(c=>c.method==='POST'&&c.url==='/api/assistant/settings').length===1));
  check('secret cleared after save',await page.locator('.ns-global-ai-dialog input[type=password]').inputValue()==='');
  await page.getByRole('tab',{name:'图像生成',exact:true}).click();await page.locator('#global-image-secret').waitFor();
  await page.locator('#global-image-secret').fill('fake-global-image-key');await page.getByRole('button',{name:'保存图像连接',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#image').textContent.includes('使用全局连接'));
  check('image API configuration stays separate from chat API',await page.evaluate(()=>calls.find(c=>c.url==='/api/settings/ai'&&c.method==='POST').payload.model==='gpt-image-2'&&calls.find(c=>c.url==='/api/assistant/settings'&&c.method==='POST').payload.model==='deepseek-flash'));
  await page.getByLabel('图像服务',{exact:true}).selectOption('qwen');await page.locator('#global-image-secret').fill('fake-qwen-key');await page.getByLabel('百炼工作空间 ID',{exact:true}).fill('test-workspace');await page.getByRole('button',{name:'保存图像连接',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#image').textContent.includes('千问图像'));
  check('default node follows later global selection',await page.evaluate(()=>imageService.provider()===''&&imageService.effectSnapshot().provider==='qwen'));
  const posts=await page.evaluate(()=>calls.filter(c=>c.method==='POST').length);
  await page.evaluate(()=>imageService.prepareGeneration());
  check('generation preparation never rewrites global settings',await page.evaluate(()=>calls.filter(c=>c.method==='POST').length)===posts);
  await page.keyboard.press('Escape');
  check('Escape closes settings and restores trigger focus',await page.evaluate(()=>!globalSettings.isOpen()&&document.activeElement.id==='launch'));
  await page.locator('#image summary').click();await page.locator('#image select').selectOption('openai');
  check('per-node service selection does not change global selection',await page.evaluate(()=>imageService.provider()==='openai'&&imageService.settings().provider==='qwen'&&calls.filter(c=>c.method==='POST').length===3));
  await page.locator('#assistant button').click();await page.locator('.ns-global-ai-dialog input[type=password]').waitFor();
  check('node settings shortcut opens same global dialog',await page.locator('dialog').count()===1&&await page.evaluate(()=>globalSettings.isOpen()));
  await page.locator('.ns-global-ai-dialog select[id*=_assistantProvider]').selectOption('local_openai');await page.locator('.ns-global-ai-dialog select[id*=_assistantProvider]').selectOption('deepseek');
  check('switching back to DeepSeek restores its preset',await page.locator('.ns-global-ai-dialog input[id*=_assistantModel]').inputValue()==='deepseek-flash');
  await page.keyboard.press('Escape');
  check('keys never appear in node state or settings-change events',await page.evaluate(()=>!JSON.stringify({params,messages}).includes('fake-')));
  // Real embedded legacy script requests parent settings instead of its own form.
  await page.route('**/legacy-fixture?nodeEmbed=1',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
  await page.evaluate(()=>{const f=document.createElement('iframe');f.id='legacy';f.src='/legacy-fixture?nodeEmbed=1';document.body.append(f);});
  await page.frameLocator('#legacy').locator('body').waitFor({state:'attached'});
  const frame=await(await page.locator('#legacy').elementHandle()).contentFrame();
  await frame.evaluate(()=>{window.api=async()=>({ready:true,provider:'deepseek'});});
  await frame.addScriptTag({path:path.join(root,'web/co-design.js')});
  await frame.evaluate(()=>openCoAssistantSettings());await page.waitForFunction(()=>globalSettings.isOpen());
  check('embedded assistant opens global settings without its own credential form',await frame.locator('#coConnectionDialog').count()===0);
  await page.keyboard.press('Escape');
  check('no browser exceptions or external requests',report.errors.length===0&&report.externalRequests===0);
  report.passed=true;
 }catch(error){report.passed=false;report.failure=error.stack;process.exitCode=1;}
 finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
})();
