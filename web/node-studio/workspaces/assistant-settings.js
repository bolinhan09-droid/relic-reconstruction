import { el, field, actions, notice } from './shared.js';

/** Credentials stay in the runtime form, never in node parameters. */
export async function assistantSettings(ws, context) {
  let settings = {};
  try { settings = await context.api('GET', '/api/assistant/settings'); } catch (error) { ws.say(error.message, true); }
  const summary = el('summary', { text: '助手连接' });
  const element = el('details', { class: 'ns-ws-details ns-assistant-service' }, summary); element.open = !settings.ready;
  const provider = field(ws, '_assistantProvider', '助手服务', { persist: false, value: settings.provider || 'local_openai', options: [{ value: 'local_openai', label: '本机千问 · 离线视觉助手' }, { value: 'deepseek', label: 'DeepSeek · 云端视觉助手' }, { value: 'openai_compatible', label: '其他兼容视觉服务' }] });
  const address = field(ws, '_assistantAddress', '接口地址', { persist: false, value: settings.baseUrl || 'http://127.0.0.1:8188/v1' });
  const model = field(ws, '_assistantModel', '模型', { persist: false, value: settings.model || 'qwen3.5-4b-local' });
  const vision = field(ws, '_assistantVision', '启用图片理解', { persist: false, type: 'checkbox', value: settings.vision === true });
  const key = el('input', { type: 'password', class: 'ns-input', autocomplete: 'off', 'aria-label': '助手 API 密钥', placeholder: '留空沿用当前服务的密钥' });
  const keyGroup = el('div', { class: 'ns-ws-field' }, el('label', { text: 'API 密钥' }), key);
  const state = el('p', { class: 'ns-ws-notice', role: 'status' });
  const start = ws.button('启动本机千问', async () => {
    const result = await context.api('POST', '/api/local-ai/start', {}); state.textContent = result.reason || result.message || '本机模型正在加载。';
    if (!['ready', 'starting'].includes(result.status)) throw Error(state.textContent);
    for (let i = 0; i < 90 && !ws.signal.aborted; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000)); if (ws.signal.aborted) return;
      const status = await context.api('GET', '/api/local-ai/status'); state.textContent = status.reason || (status.ready ? '本机助手已就绪。' : '模型正在加载…');
      if (status.ready) { provider.control.value = 'local_openai'; address.control.value = status.baseUrl || 'http://127.0.0.1:8188/v1'; model.control.value = status.model || 'qwen3.5-4b-local'; vision.control.checked = true; await save(); return; }
      if (!['starting', 'ready'].includes(status.status)) throw Error(status.reason || '本机助手未能启动。');
    }
    if (!ws.signal.aborted) state.textContent = '模型仍在加载，可稍后查看状态。';
  });
  const stop = ws.button('停止本机助手', async () => { const status = await context.api('POST', '/api/local-ai/stop', {}); state.textContent = status.reason; });
  function refresh() {
    keyGroup.hidden = provider.control.value === 'local_openai'; start.hidden = stop.hidden = !keyGroup.hidden;
    summary.textContent = `${settings.provider === 'local_openai' ? '本机' : settings.provider === 'deepseek' ? 'DeepSeek' : '兼容服务'} · ${settings.model || '待配置'}${settings.ready ? '' : ' · 未连接'}`;
    state.textContent = settings.localOnly ? '图片与对话交给本机模型处理。' : '点击执行时，当前作品缩略图和相关设定会发送给所选助手服务。';
  }
  async function save() {
    const payload = { provider: provider.control.value, baseUrl: address.control.value.trim(), model: model.control.value.trim(), vision: vision.control.checked };
    if (key.value.trim()) payload.apiKey = key.value.trim();
    try { settings = await context.api('POST', '/api/assistant/settings', payload); refresh(); ws.say('助手设置已应用，所有 AI 协作节点共用。'); }
    finally { key.value = ''; delete payload.apiKey; }
  }
  ws.on(provider.control, 'change', () => {
    const local = provider.control.value === 'local_openai', deepseek = provider.control.value === 'deepseek';
    address.control.value = local ? 'http://127.0.0.1:8188/v1' : deepseek ? 'https://api.deepseek.com/v1' : '';
    model.control.value = local ? 'qwen3.5-4b-local' : deepseek ? 'deepseek-flash' : ''; vision.control.checked = local || deepseek;
    key.value = ''; keyGroup.hidden = local; start.hidden = stop.hidden = !local;
  });
  element.append(provider.group, address.group, model.group, keyGroup, vision.group, state, actions(start, stop, ws.button('应用助手设置', save)), notice('本机模型按需启动。使用本机生图前，可停止助手释放显存。密钥不进入项目或导出文件。'));
  ws.cleanup(() => { key.value = ''; }); refresh(); return { element, isExternal: () => settings.provider !== 'local_openai', settings: () => settings };
}
