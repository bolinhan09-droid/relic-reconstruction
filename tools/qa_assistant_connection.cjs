/* Real browser controls, fully intercepted local fixtures; no API/model calls. */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const source = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1152, height: 900 } });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://relic.test') throw Error('Unexpected network destination');
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh"><meta charset="UTF-8"><body><main id="mount"></main></body></html>' });
      const file = path.resolve(source, 'web', '.' + url.pathname);
      assert(file.startsWith(path.resolve(source, 'web') + path.sep));
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      await route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : 'text/css', body: fs.readFileSync(file) });
    });
    await page.goto('http://relic.test/');
    await page.evaluate(async () => {
      const { createWorkspace } = await import('/node-studio/workspaces/shared.js');
      const { assistantSettings } = await import('/node-studio/workspaces/assistant-settings.js');
      window.calls = [];
      const context = { node: { id: 'assistant-check', type: 'agent_execute' }, updateNode() { throw Error('Connection must not persist to node'); }, async api(method, url, payload) {
        window.calls.push({ method, url, payload: payload ? structuredClone(payload) : null });
        if (method === 'GET') return { provider: 'local_openai', baseUrl: 'http://127.0.0.1:8188/v1', model: 'my-existing-local-model', vision: true, ready: false };
        return { ...payload, apiKey: undefined, hasKey: Boolean(payload.apiKey), ready: Boolean(payload.apiKey) };
      } };
      const ws = createWorkspace(document.querySelector('#mount'), context);
      ws.body.append((await assistantSettings(ws, context)).element);
    });
    await page.getByLabel('助手服务', { exact: true }).selectOption('deepseek');
    assert.equal(await page.getByLabel('模型名称', { exact: true }).inputValue(), 'deepseek-flash');
    assert.equal(await page.getByLabel('接口地址', { exact: true }).inputValue(), 'https://api.deepseek.com/v1');
    assert.equal(await page.getByLabel('模型名称', { exact: true }).isVisible(), false);
    assert.equal(await page.getByLabel('助手 API 密钥', { exact: true }).isVisible(), true);
    await page.getByLabel('助手 API 密钥', { exact: true }).fill('fake-key-no-model-call');
    await page.getByRole('button', { name: '保存连接', exact: true }).click();
    await page.waitForFunction(() => calls.some(item => item.method === 'POST'));
    assert.equal(await page.getByLabel('助手 API 密钥', { exact: true }).inputValue(), '');
    assert(await page.evaluate(() => calls.at(-1).payload.model === 'deepseek-flash' && calls.at(-1).payload.vision === true));
    await page.getByLabel('助手服务', { exact: true }).selectOption('openai_compatible');
    assert.equal(await page.getByLabel('模型名称', { exact: true }).isVisible(), true);
    assert.equal(await page.getByLabel('模型名称', { exact: true }).inputValue(), '');
    assert.equal(await page.getByLabel('接口地址', { exact: true }).inputValue(), '');
    await page.getByLabel('助手服务', { exact: true }).selectOption('deepseek');
    assert(await page.evaluate(() => calls.every(item => item.url === '/api/assistant/settings')));

    // The role-research node has its own consent flow; its settings must share
    // the same defaults without triggering identification on save.
    await page.evaluate(async () => {
      document.querySelector('#mount').replaceChildren();
      const { characterResearch } = await import('/node-studio/workspaces/character-research.js');
      const workflow = { id: 'check-workflow', nodes: [], context: {} };
      window.calls = [];
      window.researchSettings = { provider: 'local_openai', baseUrl: 'http://127.0.0.1:8188/v1', model: 'my-existing-local-model', vision: true, ready: false, visionReady: false };
      const context = { node: { id: 'research-check', type: 'character_research', params: {} }, workflow, getInput: () => ({}), updateNode() {}, async api(method, url, payload) {
        window.calls.push({ method, url, payload: payload ? structuredClone(payload) : null });
        if (method === 'POST') window.researchSettings = { ...payload, apiKey: undefined, hasKey: true, ready: true, visionReady: true };
        return structuredClone(window.researchSettings);
      } };
      await characterResearch(document.querySelector('#mount'), context);
    });
    await page.getByLabel('助手服务', { exact: true }).selectOption('deepseek');
    assert.equal(await page.getByLabel('模型名称', { exact: true }).inputValue(), 'deepseek-flash');
    assert.equal(await page.getByLabel('模型名称', { exact: true }).isVisible(), false);
    await page.getByLabel('API Key', { exact: true }).fill('fake-research-key');
    await page.getByRole('button', { name: '保存连接', exact: true }).click();
    await page.waitForFunction(() => calls.some(item => item.method === 'POST'));
    assert(await page.evaluate(() => calls.every(item => ['/api/assistant/settings', '/api/node-research/settings'].includes(item.url))));
    assert.equal(await page.getByRole('button', { name: '允许并识别角色', exact: true }).count(), 1);

    await page.evaluate(() => {
      document.querySelector('#mount').replaceChildren();
      window.escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
      window.calls = [];
      window.api = async (url, options) => {
        const payload = JSON.parse(options.body);
        window.calls.push({ url, payload });
        return { ...payload, apiKey: undefined, ready: true, hasKey: true };
      };
    });
    await page.addScriptTag({ url: '/co-design.js' });
    await page.evaluate(() => openCoAssistantSettings(new MouseEvent('click')));
    assert.equal(await page.locator('#coAssistantProvider').inputValue(), 'deepseek');
    assert.equal(await page.locator('#coAssistantModel').isVisible(), false);
    await page.locator('#coAssistantKey').fill('fake-legacy-key');
    await page.getByRole('button', { name: '保存连接', exact: true }).click();
    await page.waitForFunction(() => calls.length === 1);
    assert(await page.evaluate(() => calls[0].payload.model === 'deepseek-flash' && calls[0].payload.vision === true));
    assert.equal(await page.locator('#coAssistantKey').inputValue(), '');
    console.log(JSON.stringify({ ok: true, entryPoints: ['assistant nodes', 'character research', 'legacy co-design'],
      keyOnlyUserFlow: true, advancedCollapsed: true, providerSwitchResets: true,
      researchConsentPreserved: true, automaticModelCalls: 0, externalNetworkRequests: 0 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
