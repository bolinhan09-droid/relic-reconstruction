import { el, field, actions, notice } from './shared.js';
import { requestAiSettings } from '../core/ai-settings-events.js';

export const IMAGE_SERVICES = [
  {value:'openai',label:'GPT 图像'}, {value:'qwen',label:'千问图像'},
  {value:'openai_compatible',label:'兼容图像服务'}, {value:'local_openai',label:'本机图像服务'}
];
export const imageServiceLabel = value => IMAGE_SERVICES.find(item=>item.value===value)?.label || '图像服务';

/** Per-node routing uses saved global connections; it never configures a service. */
export async function imageConnection(ws, context) {
  let settings = {}, serial=0;
  const provider = field(ws, 'provider', '本节点使用的服务', {value:ws.params.provider || '',
    options:[{value:'',label:'跟随全局设置'}, ...IMAGE_SERVICES]});
  const status = el('span',{role:'status',class:'ns-ai-connection-status'});
  const advanced = el('details',{class:'ns-ws-details'}, el('summary',{text:'单独选择服务'}),provider.group);
  const element = el('section',{class:'ns-ai-connection'},
    el('div',{class:'ns-ai-connection-row'}, status, actions(ws.button('AI 设置',()=>requestAiSettings('image')))),advanced);
  function selected() { return provider.control.value || settings.provider || 'openai'; }
  function snapshot() { return settings.providers?.[selected()] || (settings.provider===selected()?settings:{}); }
  function render() {
    const current=snapshot();
    status.textContent=`${imageServiceLabel(selected())} · ${current.ready ? (provider.control.value?'本节点指定服务':'使用全局连接') : '尚未连接'}`;
    if (ws.params.model) {
      if(!element.querySelector('[data-legacy-model]')) {
        const legacy=el('div',{'data-legacy-model':'true'},notice(`此方案曾单独指定模型：${ws.params.model}`),
          actions(ws.button('改为跟随全局',()=>{provider.control.value='';ws.patch({provider:'',model:'',quality:''});legacy.remove();render();})));
        element.append(legacy);
      }
    }
    element.dispatchEvent(new CustomEvent('connectionchange',{detail:{provider:selected(),external:selected()!=='local_openai'}}));
  }
  async function refresh() {
    const turn=++serial,next=await context.api('GET','/api/settings/ai');
    if(ws.signal.aborted || turn!==serial)return;
    settings=next;render();
  }
  ws.on(provider.control,'change',()=>{ws.patch({model:''});render();});
  ws.on(window,'relic-ai-settings-changed',event=>{
    if(event.detail?.section==='image')refresh().catch(error=>ws.say(error.message,true));
  });
  try { await refresh(); } catch(error) {status.textContent='图像连接状态暂不可用';ws.say(error.message,true);}
  return {element,provider:()=>provider.control.value,settings:()=>settings,effectSnapshot:snapshot,
    isExternal:()=>selected()!=='local_openai',
    async prepareGeneration(){await refresh();if(!snapshot().ready)throw Error('先在左上角 AI 设置中连接图像服务');return snapshot();}};
}
