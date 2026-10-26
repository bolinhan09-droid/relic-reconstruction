import { el, field, actions, notice } from './shared.js';
import { ASSISTANT_PRESETS } from './assistant-settings.js';
import { publishAiSettings } from '../core/ai-settings-events.js';

const PRESETS = ASSISTANT_PRESETS;

/** Credentials stay in the runtime form, never in node parameters. */
export async function assistantConfiguration(ws, context) {
  let settings = {};
  try { settings = await context.api('GET', '/api/assistant/settings'); } catch (error) { ws.say(error.message, true); }
  const summary = el('summary', { text: '助手连接' });
  const element = el('section', { class: 'ns-assistant-service' });
  const selected = settings.provider || 'deepseek', preset = PRESETS[selected] || PRESETS.deepseek;
  const provider = field(ws, '_assistantProvider', '助手服务', { persist: false, value: selected, options: [{ value: 'deepseek', label: 'DeepSeek · 官方服务' }, { value: 'local_openai', label: '本机千问 · 离线助手' }, { value: 'openai_compatible', label: '其他兼容服务' }] });
  const address = field(ws, '_assistantAddress', '接口地址', { persist: false, value: settings.baseUrl || preset.baseUrl });
  const model = field(ws, '_assistantModel', '模型名称', { persist: false, value: settings.model || preset.model });
  const vision = field(ws, '_assistantVision', '启用图片理解', { persist: false, type: 'checkbox', value: settings.vision ?? preset.vision });
  const keyId = `assistant-key-${context.node.id}`;
  const key = el('input', { id: keyId, type: 'password', class: 'ns-input', autocomplete: 'off', maxlength: 1024, spellcheck: 'false', 'aria-label': '助手 API 密钥', placeholder: '粘贴所选服务的 API Key' });
  const keyGroup = el('div', { class: 'ns-ws-field' }, el('label', { text: 'API Key', for: keyId }), key);
  const presetHint = notice('已选官方视觉模型，只需粘贴 API Key');
  const advanced = el('details', { class: 'ns-ws-details' }, el('summary', { text: '高级设置' }), address.group, model.group, vision.group);
  advanced.open = selected === 'openai_compatible';
  const state = el('p', { class: 'ns-ws-notice', role: 'status' });
  const start = ws.button('启动本机千问', async () => {
    const result = await context.api('POST', '/api/local-ai/start', {}); state.textContent = result.reason || result.message || '本机模型正在加载';
    if (!['ready', 'starting'].includes(result.status)) throw Error(state.textContent);
    for (let i = 0; i < 90 && !ws.signal.aborted; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000)); if (ws.signal.aborted) return;
      const status = await context.api('GET', '/api/local-ai/status'); state.textContent = status.reason || (status.ready ? '本机助手已就绪' : '模型正在加载…');
      if (status.ready) { provider.control.value = 'local_openai'; address.control.value = status.baseUrl || PRESETS.local_openai.baseUrl; model.control.value = status.model || PRESETS.local_openai.model; vision.control.checked = true; await save(); return; }
      if (!['starting', 'ready'].includes(status.status)) throw Error(status.reason || '本机助手未能启动');
    }
    if (!ws.signal.aborted) state.textContent = '模型仍在加载，可稍后查看状态';
  });
  const stop = ws.button('停止本机助手', async () => { const status = await context.api('POST', '/api/local-ai/stop', {}); state.textContent = status.reason; });
  function refreshSelection() {
    const local = provider.control.value === 'local_openai', deepseek = provider.control.value === 'deepseek';
    keyGroup.hidden = local; start.hidden = stop.hidden = !local; presetHint.hidden = !deepseek;
    key.placeholder = settings.provider === provider.control.value && settings.hasKey ? '已设置，留空保留本次密钥' : '粘贴所选服务的 API Key';
    state.textContent = local ? '图片与对话在本机处理' : '执行时会发送当前作品缩略图与设定，按服务商标准计费';
  }
  function refresh() {
    refreshSelection();
    summary.textContent = `${settings.provider === 'local_openai' ? '本机助手' : settings.provider === 'deepseek' ? 'DeepSeek' : '助手连接'} · ${settings.ready ? '已设置' : '待设置'}`;
  }
  async function save() {
    const selectedPreset = PRESETS[provider.control.value];
    const payload = { provider: provider.control.value, baseUrl: address.control.value.trim() || selectedPreset.baseUrl, model: model.control.value.trim() || selectedPreset.model, vision: vision.control.checked };
    if (key.value.trim()) payload.apiKey = key.value.trim();
    try { settings = await context.api('POST', '/api/assistant/settings', payload); address.control.value = settings.baseUrl; model.control.value = settings.model; refresh(); publishAiSettings('assistant'); ws.say('已保存，所有协作节点共用'); }
    finally { key.value = ''; delete payload.apiKey; }
  }
  ws.on(provider.control, 'change', () => {
    const selectedPreset = PRESETS[provider.control.value];
    address.control.value = selectedPreset.baseUrl; model.control.value = selectedPreset.model; vision.control.checked = selectedPreset.vision;
    advanced.open = provider.control.value === 'openai_compatible';
    key.value = ''; refreshSelection();
  });
  element.append(provider.group, keyGroup, presetHint, advanced, state, actions(start, stop, ws.button('保存连接', save, {primary:true})), notice('密钥仅用于本次运行，不进入作品或导出文件'));
  ws.cleanup(() => { key.value = ''; }); refresh(); return { element, isExternal: () => settings.provider !== 'local_openai', settings: () => settings };
}
