/* Exercise the real novice flow with isolated local data and real pointer input.
 * External traffic and model execution are blocked; no credentials are needed.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.RELIC_QA_PLAYWRIGHT ||
  'C:/Users/lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'work/v0117-onboarding-qa');
const port = Number(process.env.RELIC_QA_PORT || 18114);
const base = `http://127.0.0.1:${port}`;
fs.mkdirSync(out, { recursive: true });
const data = fs.mkdtempSync(path.join(out, 'isolated-'));
const python = process.env.RELIC_QA_PYTHON || path.join(root, '.desktop-build/Scripts/python.exe');
const server = spawn(python, ['-B', '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'], {
  cwd: root, env: { ...process.env, RELIC_DATA_DIR: data, PYTHONUTF8: '1' }, windowsHide: true,
});
let serverLog = '';
server.stderr.on('data', value => { serverLog += value.toString(); });
const report = { checks: [], errors: [], externalRequests: 0, modelCalls: 0, isolatedData: data };
let browser, page;
function check(name, value, detail) {
  report.checks.push({ name, passed: Boolean(value), ...(detail ? { detail } : {}) });
  assert(value, name);
}
async function waitReady() {
  await page.waitForFunction(() => window.RelicNodeStudio?.getCatalog().length >= 20);
  await page.locator('#entrySplash').waitFor({ state: 'hidden' });
}
async function step(name) {
  await page.waitForFunction(wanted => {
    const guide = document.querySelector('#practiceGuide');
    return guide && !guide.hidden && guide.dataset.step === wanted;
  }, name, { timeout: 20000 });
}
async function viewportCheck(label, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(180);
  const metrics = await page.evaluate(() => {
    const root = document.scrollingElement;
    const guide = document.querySelector('#practiceGuide');
    const g = guide && !guide.hidden ? guide.getBoundingClientRect() : null;
    return {
      scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight,
      width: innerWidth, height: innerHeight,
      guide: g ? { x: g.x, y: g.y, right: g.right, bottom: g.bottom } : null,
    };
  });
  check(`${label} fits ${width}x${height} without document scrolling`,
    metrics.scrollWidth <= width + 2 && metrics.scrollHeight <= height + 2, metrics);
  if (metrics.guide) check(`${label} teaching controls remain inside the viewport`,
    metrics.guide.x >= 0 && metrics.guide.y >= 0 && metrics.guide.right <= width + 1 && metrics.guide.bottom <= height + 1);
}
async function snapshot(name) { await page.screenshot({ path: path.join(out, `${name}.png`) }); }
async function reopenFromList(id) {
  await page.locator('#projectsButton').click();
  await page.locator(`[data-project="${id}"]`).click();
  await page.waitForFunction(value => RelicNodeStudio.getWorkflow()?.id === value, id);
}
async function nodeId(type) {
  return page.evaluate(wanted => RelicNodeStudio.getWorkflow().nodes.find(n => n.type === wanted)?.id, type);
}
async function doubleClickNode(id) {
  await page.locator(`[data-node="${id}"]`).dblclick();
  await page.locator('#workspace').waitFor({ state: 'visible' });
}
async function readyPrecisionFrame() {
  await page.waitForFunction(() => document.querySelector('#workspace iframe')?.contentWindow?.RelicNodeWorkspace?.getPracticeState?.().ready);
  const frame = page.frames().find(f => f.url().includes('nodeEmbed=1'));
  assert(frame, 'precision editor frame is loaded');
  return frame;
}
async function savedWorkflow(id) {
  const response = await fetch(`${base}/api/node-studio/workflows/${encodeURIComponent(id)}`);
  assert(response.ok, 'saved workflow can be read');
  const result = await response.json(); return result.workflow || result;
}
async function panelState(panel) {
  return panel.evaluate(element => {
    const viewport = element.querySelector('.ns-page-viewport'), view = viewport.getBoundingClientRect();
    const visibleControls = [...viewport.querySelectorAll('button,input,select,textarea,summary')].filter(control => {
      const box = control.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.top >= view.top && box.bottom <= view.bottom;
    }).map(control => control.id || control.getAttribute('aria-label') || control.textContent.trim());
    return {page:Number(element.dataset.page), pages:Number(element.dataset.pages), outerScroll:element.scrollTop,
      offset:viewport.scrollTop, overflow:getComputedStyle(viewport).overflowY, visibleControls};
  });
}

(async () => {
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 180; attempt++) {
      try { healthy = (await fetch(`${base}/api/health`)).ok; if (healthy) break; } catch {}
      if (server.exitCode !== null) throw new Error('Isolated backend exited before becoming ready');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(healthy, 'isolated backend is ready');
    browser = await chromium.launch({ executablePath: process.env.RELIC_QA_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 940 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('dialog', dialog => dialog.dismiss());
    await page.route('**/*', route => {
      const request = route.request(), url = request.url();
      if (!url.startsWith(base) && !url.startsWith('data:') && !url.startsWith('blob:')) {
        report.externalRequests++; return route.abort();
      }
      if (request.method() === 'POST' && /\/api\/(?:node-research\/(?:identify|scenes)|assistant\/chat|node-studio\/workflows\/[^/]+\/nodes\/[^/]+\/run|jobs|generate)/.test(url)) {
        report.modelCalls++; return route.fulfill({ status: 418, contentType: 'application/json', body: '{"detail":"QA blocks model execution"}' });
      }
      return route.continue();
    });
    await page.goto(base); await waitReady();
    await page.locator('#startPracticeButton').waitFor({ state: 'visible' });
    check('entry offers a visible practice without configuring a model', await page.locator('#startPracticeButton').isEnabled());
    await viewportCheck('entry', 1024, 700); await snapshot('entry-1024');
    await viewportCheck('entry', 1440, 940); await snapshot('entry-1440');

    await page.locator('#startPracticeButton').click(); await step('open');
    const practice = await page.evaluate(() => RelicNodeStudio.getWorkflow());
    check('practice creates a dedicated offline workflow', practice.context?.guidedPractice === 'v1' &&
      practice.order.map(id => practice.nodes.find(n => n.id === id)?.type).join(',') === 'garment_input,precision_edit,production_guide');
    check('practice starts with a real bundled garment', Boolean(practice.nodes.find(n => n.type === 'garment_input')?.output?.imageUrl));
    const practiceId = practice.id, refineId = practice.nodes.find(n => n.type === 'precision_edit').id;
    await viewportCheck('practice overview', 1024, 700); await snapshot('practice-1024');
    await viewportCheck('practice overview', 1440, 940); await snapshot('practice-1440');
    await page.locator('#practiceSkip').click();
    await page.locator('#practiceGuide').waitFor({ state: 'hidden' });
    check('tutorial can be skipped without losing its project', await page.evaluate(id => RelicNodeStudio.getWorkflow()?.id === id, practiceId));

    await page.locator('#newButton').click(); await page.locator('#entry').waitFor({ state: 'visible' });
    await page.locator('#sampleButton').click(); await page.waitForFunction(() => !document.getElementById('startButton').disabled);
    await page.locator('#startButton').click(); await page.locator('#studio').waitFor({ state: 'visible' });
    await page.evaluate(() => RelicNodeStudio.save());
    const original = await page.evaluate(() => RelicNodeStudio.getWorkflow());
    await page.locator('#helpButton').click(); await page.locator('#restartPracticeButton').click(); await step('open');
    check('help resumes the existing practice', await page.evaluate(id => RelicNodeStudio.getWorkflow()?.id === id, practiceId));
    const stillOriginal = await savedWorkflow(original.id);
    check('switching to practice preserves the original project', stillOriginal.id === original.id &&
      JSON.stringify(stillOriginal.nodes) === JSON.stringify(original.nodes) && !stillOriginal.context?.guidedPractice);

    await doubleClickNode(refineId); await step('draw');
    let frame = await readyPrecisionFrame();
    assert(frame, 'precision opens the real embedded editor');
    await frame.waitForFunction(() => window.RelicNodeWorkspace?.getPracticeState?.().ready);
    await frame.locator('#brushCanvas').waitFor({ state: 'visible' });
    check('double click directly opens the drawing workbench', await frame.locator('#brushCanvas').isVisible());
    await page.locator('#saveWorkspace').focus(); await page.keyboard.press('Escape');
    await page.locator('#workspace').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#practiceAction')?.textContent.includes('回到精修') && !document.querySelector('#practiceAction').disabled);
    await page.locator('#practiceAction').click(); await page.locator('#workspace').waitFor({ state: 'visible' });
    frame = await readyPrecisionFrame();
    await frame.waitForFunction(() => window.RelicNodeWorkspace?.getPracticeState?.().ready);
    check('leaving the drawing step can resume the same teaching workspace', await frame.locator('#brushCanvas').isVisible());
    await viewportCheck('precision workspace', 1024, 700); await snapshot('precision-1024');
    const fixedCanvas = await frame.locator('#brushCanvas').boundingBox();
    const precisionPanel = frame.locator('.control-panel.ns-paged-panel');
    await frame.waitForFunction(() => Number(document.querySelector('.control-panel')?.dataset.pages) > 1);
    const firstPage = await panelState(precisionPanel);
    await precisionPanel.getByRole('button', {name:'笔刷下一页',exact:true}).click();
    const secondPage = await panelState(precisionPanel), pagedCanvas = await frame.locator('#brushCanvas').boundingBox();
    check('precision next page exposes different usable controls without document scrolling', firstPage.page === 1 && secondPage.page === 2 &&
      secondPage.offset > firstPage.offset && secondPage.outerScroll === 0 && secondPage.overflow === 'hidden' && secondPage.visibleControls.length > 0 &&
      JSON.stringify(firstPage.visibleControls) !== JSON.stringify(secondPage.visibleControls), {firstPage,secondPage});
    check('precision pagination keeps the garment canvas fixed', Math.abs(fixedCanvas.x - pagedCanvas.x) < 1 && Math.abs(fixedCanvas.y - pagedCanvas.y) < 1 &&
      Math.abs(fixedCanvas.width - pagedCanvas.width) < 1 && Math.abs(fixedCanvas.height - pagedCanvas.height) < 1);
    await precisionPanel.getByRole('button', {name:'笔刷上一页',exact:true}).click();
    check('precision previous page restores initial controls', (await panelState(precisionPanel)).page === 1 &&
      await precisionPanel.getByRole('button', {name:'笔刷上一页',exact:true}).isDisabled());
    await viewportCheck('precision workspace', 1440, 940);
    const canvas = frame.locator('#brushCanvas'), bounds = await canvas.boundingBox();
    assert(bounds && bounds.width > 100 && bounds.height > 100, 'brush canvas has usable dimensions');
    await page.mouse.move(bounds.x + bounds.width * .45, bounds.y + bounds.height * .53);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .58, bounds.y + bounds.height * .64, { steps: 9 });
    await page.mouse.up(); await step('save');
    check('real pointer stroke automatically advances teaching', await frame.evaluate(() => RelicNodeWorkspace.getPracticeState().strokeCount > 0));
    await snapshot('precision-drawn');
    await page.locator('#saveWorkspace').click(); await step('return');
    const painted = await page.evaluate(id => RelicNodeStudio.getWorkflow().nodes.find(n => n.id === id), refineId);
    check('saving produces actual editable strokes and an image output', Boolean(painted.output?.imageUrl) && painted.output?.brushStrokes?.length > 0);
    const preview = await fetch(base + painted.output.imageUrl);
    check('saved preview is available from local storage', preview.ok && Number(preview.headers.get('content-length')) > 0);
    await page.locator('#saveWorkspace').focus(); await page.keyboard.press('Escape');
    await page.locator('#workspace').waitFor({ state: 'hidden' }); await step('result');
    check('Escape returns to the same practice canvas', await page.evaluate(id => RelicNodeStudio.getWorkflow().id === id, practiceId));
    await doubleClickNode(await nodeId('production_guide')); await step('done'); await snapshot('production-guide');
    await viewportCheck('production workspace', 1024, 700);
    await page.locator('#practiceAction').click(); await page.locator('#practiceGuide').waitFor({ state: 'hidden' });
    check('completion is remembered', await page.evaluate(() => JSON.parse(localStorage.getItem('relic-guided-practice-v1') || '{}').completed === true));

    await page.reload(); await waitReady();
    check('completed teaching does not interrupt the next launch', await page.locator('#practiceGuide').count() === 0 || !await page.locator('#practiceGuide').isVisible());
    await reopenFromList(practiceId); await doubleClickNode(refineId);
    const reopened = await readyPrecisionFrame();
    await reopened.waitForFunction(() => window.RelicNodeWorkspace?.getPracticeState?.().strokeCount > 0);
    check('practice retains editable strokes after reopening', await reopened.evaluate(() => RelicNodeWorkspace.getPracticeState().strokeCount > 0));
    await page.locator('#leaveWorkspace').click(); await page.locator('#workspace').waitFor({ state: 'hidden' });
    await reopenFromList(original.id);
    await viewportCheck('standard workflow', 1440, 940);
    await doubleClickNode(await nodeId('image_generate'));
    await viewportCheck('image generation workspace', 1024, 700); await snapshot('generation-1024');
    const generationPanel = page.locator('.ns-ws-inspector.ns-paged-panel');
    await page.waitForFunction(() => Number(document.querySelector('.ns-ws-inspector')?.dataset.pages) > 1);
    const generationCanvas = await page.locator('.ns-ws-stage').boundingBox(), generationPages = [];
    const nextPage = generationPanel.getByRole('button', {name:'设置下一页',exact:true});
    for (let index = 0; index < 30; index++) {
      const currentPage = await panelState(generationPanel);
      const action = await generationPanel.locator('.ns-fixed-actions [data-generation-action]').evaluate(button => {
        const box = button.getBoundingClientRect(), parent = button.closest('.ns-ws-inspector').getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.top >= parent.top && box.bottom <= parent.bottom && box.bottom <= innerHeight;
      });
      generationPages.push({...currentPage,primaryActionVisible:action});
      if (await nextPage.isDisabled()) break;
      await nextPage.click();
    }
    const finalGenerationCanvas = await page.locator('.ns-ws-stage').boundingBox();
    check('generation settings paginate and keep the primary action visible on every page', generationPages.length > 1 &&
      generationPages.every((item,index) => item.page === index + 1 && item.primaryActionVisible && item.outerScroll === 0 && item.overflow === 'hidden') &&
      generationPages.at(-1).page === generationPages.at(-1).pages && await nextPage.isDisabled(), generationPages);
    check('generation pagination leaves the main result stage fixed', Math.abs(generationCanvas.y - finalGenerationCanvas.y) < 1 &&
      Math.abs(generationCanvas.height - finalGenerationCanvas.height) < 1 && await page.locator('.ns-ws-stage [data-current-generation]').isVisible());
    check('image generation retains global configuration access', await page.locator('#workspaceAiSettingsButton').isVisible());
    await page.locator('#workspaceAiSettingsButton').click();
    await page.locator('.ns-global-ai-dialog').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    check('Escape closes settings without leaving the workspace', await page.locator('#workspace').isVisible() && !await page.locator('.ns-global-ai-dialog').isVisible());
    check('no external traffic, model execution or browser errors', report.externalRequests === 0 && report.modelCalls === 0 && report.errors.length === 0);
    report.passed = true;
  } catch (error) {
    report.passed = false; report.failure = error.stack; report.serverLog = serverLog.slice(-4000); process.exitCode = 1;
    if (page) await snapshot('failure').catch(() => {});
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})();
