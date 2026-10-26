/* Full application-shell verification using a real isolated mapping workflow.
 * Opens history, uses production workspaceContext/runNode, reloads and reopens.
 */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require(process.env.RELIC_QA_PLAYWRIGHT || 'C:/Users/lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const root = path.resolve(__dirname, '..'), evidence = path.join(root, 'work/making-app-browser');
fs.mkdirSync(evidence, { recursive: true });
const data = fs.mkdtempSync(path.join(evidence, 'isolated-'));
const python = process.env.RELIC_QA_PYTHON || path.join(root, '.desktop-build/Scripts/python.exe');
const base = `http://127.0.0.1:${Number(process.env.RELIC_QA_PORT || 18127)}`;
const env = { ...process.env, RELIC_DATA_DIR: data, PYTHONUTF8: '1' };
const fixtureCode = `import json,sys
from pathlib import Path
sys.path.insert(0,str(Path.cwd()/'tools'))
import app as core
from check_making_routes import build_fixture
sample=build_fixture(core,core.DATA)['workflow']
next(n for n in sample['nodes'] if n['id']=='make')['params']={}
saved=core.app.state.node_studio_store.create(sample)
(core.DATA/'fixture.json').write_text(json.dumps({'workflowId':saved['id']},ensure_ascii=False),encoding='utf-8')
`;
const setup = spawnSync(python, ['-B', '-c', fixtureCode], { cwd: root, env, windowsHide: true, encoding: 'utf8' });
if (setup.status !== 0) throw Error(setup.stderr || setup.stdout || 'Fixture construction failed');
const fixture = JSON.parse(fs.readFileSync(path.join(data, 'fixture.json'), 'utf8'));
const server = spawn(python, ['-B', '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', base.split(':').pop(), '--log-level', 'warning'], { cwd: root, env, windowsHide: true });
let serverLog = '', browser, page;
server.stderr.on('data', chunk => serverLog += chunk.toString()); server.stdout.on('data', chunk => serverLog += chunk.toString()); server.on('error', error => serverLog += error.message);
const report = { checks: [], errors: [], externalRequests: 0, modelCalls: 0, fixture: 'synthetic real mapping and full app shell', data };
function check(label, condition) { report.checks.push({ label, passed: !!condition }); assert(condition, label); }
(async () => {
  try {
    let ready = false;
    for (let i = 0; i < 300; i++) {
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
    async function openHistory() {
      await page.waitForFunction(() => window.RelicNodeStudio?.getCatalog().length > 10);
      await page.locator('#entrySplash').waitFor({ state: 'hidden' });
      const card = page.locator(`[data-history-id="${fixture.workflowId}"]`); await card.waitFor(); await card.click();
      await page.waitForFunction(id => window.RelicNodeStudio?.getWorkflow()?.id === id, fixture.workflowId);
      await page.locator('#studio').waitFor({ state: 'visible' });
    }
    await page.goto(base); await openHistory();
    check('real homepage opens saved synthetic workflow', await page.evaluate(id => RelicNodeStudio.getWorkflow().id === id, fixture.workflowId));
    await page.evaluate(() => RelicNodeStudio.openNode('make'));
    await page.locator('.ns-making-kit').waitFor();
    check('production context inspects the direct mapped input', (await page.locator('.ns-kit-readiness').innerText()).includes('笔刷可追溯'));
    await page.getByLabel('整张照片实际宽度（mm）', {exact:true}).evaluate(el=>el.dispatchEvent(new CustomEvent('relic:reveal',{bubbles:true}))); 
    await page.getByLabel('整张照片实际宽度（mm）', { exact: true }).fill('180');
    await page.getByRole('button', { name: '按照片比例计算高度', exact: true }).click();

    await page.getByRole('button', { name: '生成模板与制作说明', exact: true }).click();
    await page.waitForFunction(() => RelicNodeStudio.getWorkflow().nodes.find(n => n.id === 'make').output?.kind === 'making_kit', null, { timeout: 60000 });
    await page.getByRole('heading', { name: '你的制作包', exact: true }).waitFor();
    check('result replaces preview without a second stacked canvas', await page.locator('[id^=making-preview-]').evaluate(el=>getComputedStyle(el).display==='none'));
    const before = await page.evaluate(() => {
      const n = RelicNodeStudio.getWorkflow().nodes.find(n => n.id === 'make');
      return { mappingId: n.output.mappingId, downloadUrl: n.output.downloadUrl, stageCount: n.output.stages.length, status: n.status };
    });
    check('real app runNode saves a succeeded making kit', before.stageCount > 0 && ['completed', 'succeeded'].includes(before.status));
    const persisted = await (await fetch(`${base}/api/node-studio/workflows/${fixture.workflowId}`)).json();
    check('generated output is persisted by production save path', persisted.workflow.nodes.find(n => n.id === 'make').output.downloadUrl === before.downloadUrl);
    await page.screenshot({ path: path.join(evidence, '01-full-app-generated.png') });
    await page.reload(); await openHistory(); await page.evaluate(() => RelicNodeStudio.openNode('make'));
    await page.getByRole('heading', { name: '你的制作包', exact: true }).waitFor();
    const restored = await page.evaluate(() => RelicNodeStudio.getWorkflow().nodes.find(n => n.id === 'make').output);
    check('reload and reopening preserve artifact URL mapping and steps', restored.downloadUrl === before.downloadUrl && restored.mappingId === before.mappingId && restored.stages.length === before.stageCount);
    check('dimensions remain bound to same mapping after reopen', await page.evaluate(()=>{const n=RelicNodeStudio.getWorkflow().nodes.find(n=>n.id==='make');return n.params.widthMm===180 && n.params.scaleConfirmed && n.params.sourceMappingId===n.output.mappingId}));
    const pendingDownload = page.waitForEvent('download'); await page.getByRole('link', { name: '下载完整制作包 ZIP', exact: true }).click();
    const download = await pendingDownload; await download.saveAs(path.join(evidence, 'reopened-kit.zip'));
    check('persisted kit downloads after full reload', fs.statSync(path.join(evidence, 'reopened-kit.zip')).size > 1000);
    await page.getByRole('button', { name: '返回前一步核对', exact: true }).evaluate(el=>el.dispatchEvent(new CustomEvent('relic:reveal',{bubbles:true})));
    await page.getByRole('button', { name: '返回前一步核对', exact: true }).click();
    await page.locator('iframe[title="衣片展平与痕迹映射工作区"]').waitFor({ state: 'visible' });
    check('openNode context navigates to the actual mapping workbench', await page.locator('.ns-making-kit').count() === 0);
    await page.screenshot({ path: path.join(evidence, '02-returned-mapping.png') });
    await page.locator('#leaveWorkspace').click(); await page.locator('#workspace').waitFor({ state: 'hidden' });
    await page.evaluate(() => RelicNodeStudio.openNode('make')); await page.getByRole('heading', { name: '你的制作包', exact: true }).waitFor();
    check('returning from mapping preserves the kit without duplicate workspaces', await page.locator('.ns-making-kit').count() === 1 && await page.evaluate(url => RelicNodeStudio.getWorkflow().nodes.find(n => n.id === 'make').output.downloadUrl === url, before.downloadUrl));
    check('no page errors external requests or paid model calls', report.errors.length === 0 && report.externalRequests === 0 && report.modelCalls === 0);
  } catch (error) {
    report.failed = error.stack || String(error); process.exitCode = 1;
    if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  } finally {
    if (browser) await browser.close(); server.kill();
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  }
})();

