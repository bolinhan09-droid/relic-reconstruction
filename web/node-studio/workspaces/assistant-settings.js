import { el, actions } from './shared.js';
import { requestAiSettings } from '../core/ai-settings-events.js';

export const ASSISTANT_PRESETS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', vision: true },
  local_openai: { baseUrl: 'http://127.0.0.1:8188/v1', model: 'qwen3.5-4b-local', vision: true },
  openai_compatible: { baseUrl: '', model: '', vision: false },
};

const providerLabel = value => ({deepseek:'DeepSeek',local_openai:'本机千问',openai_compatible:'兼容助手'})[value] || '协作助手';

/** Node views show the shared connection; credentials belong to global settings. */
export async function assistantSettings(ws, context) {
  let settings = {}, serial = 0;
  const status = el('span', {class:'ns-ai-connection-status', role:'status'});
  const element = el('section', {class:'ns-ai-connection'}, status,
    actions(ws.button('AI 设置', () => requestAiSettings('assistant'))));
  async function refresh() {
    const turn = ++serial;
    try {
      const next = await context.api('GET','/api/assistant/settings');
      if (ws.signal.aborted || turn !== serial) return;
      settings = next;
      status.textContent = `${providerLabel(settings.provider)} · ${settings.ready ? '使用全局连接' : '尚未连接'}`;
    } catch (error) { if(!ws.signal.aborted) { status.textContent='连接状态暂不可用'; ws.say(error.message,true); } }
  }
  ws.on(window, 'relic-ai-settings-changed', event => { if(event.detail?.section==='assistant') refresh(); });
  await refresh();
  return {element, isExternal:()=>settings.provider!=='local_openai', settings:()=>settings, refresh};
}
