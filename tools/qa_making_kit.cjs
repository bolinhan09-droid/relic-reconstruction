/* Browser verification against an isolated real backend and synthetic mapping.
 * No personal garment photographs, API credentials, model calls or external requests.
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require(process.env.RELIC_QA_PLAYWRIGHT || 'C:/Users/lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const root = path.resolve(__dirname, '..'), evidence = path.join(root, 'work/making-kit-browser');
fs.mkdirSync(evidence, { recursive: true });
const data = fs.mkdtempSync(path.join(evidence, 'isolated-'));
const python = process.env.RELIC_QA_PYTHON || path.join(root, '.desktop-build/Scripts/python.exe');
const base = `http://127.0.0.1:${Number(process.env.RELIC_QA_PORT || 18125)}`;
const env = { ...process.env, RELIC_DATA_DIR: data, PYTHONUTF8: '1' };
const fixtureCode = `import json,sys
from pathlib import Path
sys.path.insert(0,str(Path.cwd()/'tools'))
import app as core
from check_making_routes import build_fixture
sample=build_fixture(core,core.DATA)
sample=sample['workflow']
next(n for n in sample['nodes'] if n['id']=='make')['params']={}
saved=core.app.state.node_studio_store.create(sample)
(core.DATA/'fixture.json').write_text(json.dumps({'workflowId':saved['id']},ensure_ascii=False),encoding='utf-8')
`;
const setup = spawnSync(python, ['-B', '-c', fixtureCode], { cwd: root, env, windowsHide: true, encoding: 'utf8' });
if (setup.status !== 0) throw Error(setup.stderr || setup.stdout || 'Fixture construction failed');
const fixture = JSON.parse(fs.readFileSync(path.join(data, 'fixture.json'), 'utf8'));
const server = spawn(python, ['-B', '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', base.split(':').pop(), '--log-level', 'warning'], { cwd: root, env, windowsHide: true });
let serverLog = '', browser, page;
server.stderr.on('data', chunk => serverLog += chunk.toString());
server.stdout.on('data', chunk => serverLog += chunk.toString());
server.on('error', error => serverLog += error.message);
const report = { checks: [], errors: [], externalRequests: 0, modelCalls: 0, fixture: 'synthetic real mapping', data };
function check(label, condition) { report.checks.push({ label, passed: !!condition }); assert(condition, label); }
(async () => {
  try {
    let ready = false;
    for (let i = 0; i < 600; i++) {
      try { ready = (await fetch(base + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch {}
      if (ready) break; await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw Error(serverLog || 'Backend did not start');
    browser = await chromium.launch({ executablePath: process.env.RELIC_QA_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.route('**/*', route => {
      const url = route.request().url();
      if (!url.startsWith(base) && !url.startsWith('data:') && !url.startsWith('blob:')) { report.externalRequests++; return route.abort(); }
      if (route.request().method() === 'POST' && /\/api\/(?:generation|image-generation|assistants|local-models)\//.test(url)) { report.modelCalls++; return route.abort(); }
      return route.continue();
    });
    await page.goto(base); await page.waitForFunction(() => window.RelicNodeStudio?.getCatalog().length > 10);
    await page.locator('#entrySplash').waitFor({ state: 'hidden' });
    await page.evaluate(async workflowId => {
      const { mountWorkspace } = await import('/node-studio/workspaces/index.js');
      const { api } = await import('/node-studio/core/api.js');
      let workflow = (await api('GET', `/api/node-studio/workflows/${workflowId}`)).workflow, current;
      const catalog = RelicNodeStudio.getCatalog();
      document.getElementById('workspace').hidden = false; document.body.classList.add('ns-in-workspace');
      const mount = document.createElement('div'); mount.className = 'ns-workspace-mount'; document.getElementById('workspaceContent').replaceChildren(mount);
      document.getElementById('workspaceTitle').textContent = '模板与制作包';
      const save = async () => { workflow = (await api('PUT', `/api/node-studio/workflows/${workflow.id}`, { workflow, expectedRevision: workflow.revision })).workflow; };
      window.makingQA = {
        get workflow() { return workflow; },
        async mount() {
          current?.destroy(); const node = workflow.nodes.find(n => n.id === 'make');
          const context = { workflow, node, catalog, api, headerActions: document.getElementById('workspaceActions'), definition: catalog.find(d => d.type === 'stencil_export'),
            getWorkflow: () => workflow, updateNode: patch => Object.assign(workflow.nodes.find(n => n.id === 'make').params, patch),
            saveWorkflow: save, async runNode() { await save(); const response = await api('POST', `/api/node-studio/workflows/${workflow.id}/nodes/make/run`, { expectedRevision: workflow.revision }); workflow = response.workflow; return response; },
          };
          current = await mountWorkspace(mount, context);
        },
        async staleConfirmation() { workflow.nodes.find(n => n.id === 'make').params.sourceMappingId = 'mapping-previous'; await save(); await this.mount(); },
        async missingMapping() { workflow.nodes.find(n => n.id === 'mapped').output = null; await save(); await this.mount(); },
        async legacyOutput() { workflow.nodes.find(n => n.id === 'make').output = { kind: 'stencil', files: [], message: 'old' }; await save(); await this.mount(); }
      };
      await makingQA.mount();
    }, fixture.workflowId);
    const generate = page.getByRole('button', { name: '生成模板与制作说明', exact: true });
    check('real input inspection reads mapped synthetic garment and brush records', (await page.locator('.ns-kit-readiness').innerText()).includes('笔刷可追溯'));
    check('scale has no guessed default and generation is gated', await page.getByLabel('整张照片实际宽度（mm）', { exact: true }).inputValue() === '' && await generate.isDisabled());
    check('advanced stencil details are initially collapsed', !await page.getByLabel('连接桥宽度（mm）', { exact: true }).isVisible());
    await page.getByLabel('整张照片实际宽度（mm）',{exact:true}).evaluate(el=>el.dispatchEvent(new CustomEvent('relic:reveal',{bubbles:true})));
    await page.getByLabel('整张照片实际宽度（mm）', { exact: true }).fill('180');
    await page.getByRole('button', { name: '按照片比例计算高度', exact: true }).click();
    check('explicit ratio helper fills physical height', await page.getByLabel('整张照片实际高度（mm）', { exact: true }).inputValue() === '240');
    check('dimensions are bound to the inspected mapping', await page.evaluate(() => makingQA.workflow.nodes.find(n => n.id === 'make').params.sourceMappingId === makingQA.workflow.nodes.find(n => n.id === 'mapped').output.mapping.id));
    await page.getByLabel('整张照片实际高度（mm）', { exact: true }).fill('180');
    check('dimension changes revoke scale confirmation and reject distorted ratio', await page.evaluate(()=>makingQA.workflow.nodes.find(n=>n.id==='make').params.scaleConfirmed===false) && await generate.isDisabled());
    await page.getByRole('button', { name: '按照片比例计算高度', exact: true }).click();
    check('generation becomes available after valid measured dimensions', await generate.isEnabled());
    await page.screenshot({ path: path.join(evidence, '01-input-calibration.png') });
    await generate.click();
    await page.waitForFunction(() => window.makingQA.workflow.nodes.find(n => n.id === 'make').output?.kind === 'making_kit', { timeout: 60000 });
    await page.getByRole('heading', { name: '你的制作包', exact: true }).waitFor();
    check('real API generates nested part effect operation cards', await page.locator('.ns-kit-part').count() === 1 && await page.locator('.ns-kit-effect').count() === 2 && await page.locator('.ns-kit-step').count() >= 2);
    check('generation selects the result tab without navigating away', await page.getByRole('tab', { name: '制作步骤', exact: true }).getAttribute('aria-selected') === 'true');
    check('per-step previews reference generated local SVG files', await page.locator('.ns-kit-template img').evaluateAll(images => images.every(image => image.getAttribute('src').startsWith('/data/node-studio/exports/'))));
    await page.screenshot({ path: path.join(evidence, '02-making-kit.png') });
    const pendingDownload = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载完整制作包 ZIP', exact: true }).click();
    const download = await pendingDownload; await download.saveAs(path.join(evidence, 'verified-making-kit.zip'));
    check('browser downloads an actual nonempty ZIP from generated output', fs.statSync(path.join(evidence, 'verified-making-kit.zip')).size > 1000);
    const files = await page.evaluate(() => makingQA.workflow.nodes.find(n => n.id === 'make').output.files);
    const html = await (await fetch(base + files.find(f => f.kind === 'print').url)).text();
    check('real print page declares A4 and full-scale calibration', html.includes('@page{size:A4') && html.includes('100%'));
    const manual = await (await fetch(base + files.find(f => f.kind === 'manual').url)).text();
    check('downloadable manual contains embedded previews and operation instructions', manual.includes('data:image/svg+xml;base64,') && manual.includes('工具'));
    await page.setViewportSize({ width: 1024, height: 768 });
    check('desktop workspace uses bounded pages without vertical scrolling', await page.evaluate(() => {
      const controls = document.querySelector('.ns-kit-controls');
      return document.documentElement.scrollWidth <= innerWidth + 2 && controls.querySelector('.ns-page-nav') && getComputedStyle(controls).overflowY === 'hidden';
    }));
    await page.screenshot({ path: path.join(evidence, '03-compact-desktop.png') });
    await page.evaluate(() => makingQA.staleConfirmation());
    check('changed mapping clears old scale and blocks generation', await page.getByLabel('整张照片实际宽度（mm）',{exact:true}).inputValue()==='' && await generate.isDisabled());
    await page.evaluate(() => makingQA.missingMapping());
    check('missing mapping blocks rather than borrowing earlier images', await generate.isDisabled() && (await page.locator('.ns-kit-readiness').innerText()).includes('待完成'));
    await page.evaluate(() => makingQA.legacyOutput());
    check('old stencil output is explicitly identified rather than shown as automatic kit', (await page.locator('.ns-kit-results').innerText()).includes('旧版输出'));
    check('no unhandled browser errors or paid/external requests', report.errors.length === 0 && report.modelCalls === 0 && report.externalRequests === 0);
  } catch (error) {
    report.failed = error.stack || String(error); process.exitCode = 1;
    if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  } finally {
    if (browser) await browser.close(); server.kill();
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})();


