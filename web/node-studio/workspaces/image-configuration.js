import { el, field, actions, notice } from './shared.js';
import { IMAGE_SERVICES, imageServiceLabel } from './image-connection.js';
import { publishAiSettings } from '../core/ai-settings-events.js';

/** The only image connection form, mounted by the global settings dialog. */
export async function imageConfiguration(ws,context) {
  let settings=await context.api('GET','/api/settings/ai');
  if(ws.signal.aborted)return {element:el('div')};
  const provider=field(ws,'imageProvider','图像服务',{persist:false,value:settings.provider||'openai',options:IMAGE_SERVICES});
  const model=field(ws,'imageModel','图像模型',{persist:false});
  const base=field(ws,'imageBase','接口根地址',{persist:false,type:'url',placeholder:'https://服务地址/v1'});
  const quality=field(ws,'imageQuality','默认生成质量',{persist:false,options:[{value:'low',label:'试稿'},{value:'medium',label:'常规'},{value:'high',label:'精细'},{value:'auto',label:'自动'}]});
  const region=field(ws,'imageRegion','百炼地域',{persist:false,options:[{value:'cn-beijing',label:'中国 · 北京'},{value:'ap-southeast-1',label:'新加坡'}]});
  const workspace=field(ws,'imageWorkspace','百炼工作空间 ID',{persist:false});
  const key=el('input',{id:'global-image-secret',type:'password',class:'ns-input',autocomplete:'off',maxlength:1024,spellcheck:'false'});
  const keyGroup=el('div',{class:'ns-ws-field'},el('label',{for:key.id,text:'API Key'}),key);
  const advanced=el('details',{class:'ns-ws-details'},el('summary',{text:'高级设置'}),model.group,base.group,quality.group,region.group);
  const state=el('p',{role:'status',class:'ns-ws-status'});
  const localState=el('p',{role:'status',class:'ns-ws-status'});
  const local=el('section',{class:'ns-ws-details'},notice('本机模型独立安装，启动后供所有图像节点共用'),actions(
    ws.button('启动本机千问生图',async()=>{
      const result=await context.api('POST','/api/local-image/start',{});localState.textContent=result.reason||'正在加载';
      if(!['starting','ready'].includes(result.status))throw Error(result.reason||'本机模型未就绪');
      for(let i=0;i<120&&!ws.signal.aborted;i++) {
        const current=await context.api('GET','/api/local-image/status');if(ws.signal.aborted)return;
        localState.textContent=current.reason||'正在加载';
        if(current.ready){provider.control.value='local_openai';model.control.value=current.model;base.control.value=current.baseUrl;await save();return;}
        if(!['starting','ready'].includes(current.status))throw Error(current.reason||'本机生图未启动');
        await new Promise(resolve=>setTimeout(resolve,2000));
      }
    }),
    ws.button('停止生图模型',async()=>{const result=await context.api('POST','/api/local-image/stop',{});localState.textContent=result.reason;}),
    ws.button('停止本机助手以释放显存',async()=>{const result=await context.api('POST','/api/local-ai/stop',{});localState.textContent=result.reason;})
  ),localState);
  function fill(){
    const name=provider.control.value,current=settings.providers?.[name]||{},isLocal=name==='local_openai',qwen=name==='qwen';
    const custom=name==='openai_compatible';
    model.control.value=current.model||(qwen?'qwen-image-3.0-pro':isLocal?'sd-cpp-local':'gpt-image-2');
    base.control.value=isLocal&&!current.model?'http://127.0.0.1:8190/v1':current.baseUrl||'';
    base.group.hidden=!custom&&!isLocal;
    quality.control.value=current.quality||(isLocal||qwen?'auto':'medium');quality.group.hidden=isLocal||qwen;
    region.control.value=current.region||'cn-beijing';region.group.hidden=!qwen;
    workspace.control.value=current.workspaceId||'';workspace.group.hidden=!qwen;
    key.value='';keyGroup.hidden=isLocal;local.hidden=!isLocal;
    key.placeholder=current.hasKey?'已设置，留空保留本次密钥':'粘贴该图像服务的 API Key';
    advanced.open=custom;
    state.textContent=current.ready?'连接已保存，实际执行时验证图像能力':'连接一次，所有图像生成节点共用';
  }
  function payload(){
    const name=provider.control.value,result={provider:name,model:model.control.value.trim(),quality:['qwen','local_openai'].includes(name)?'auto':quality.control.value};
    if(['openai_compatible','local_openai'].includes(name))result.baseUrl=base.control.value.trim();
    if(name==='qwen'){result.region=region.control.value;result.workspaceId=workspace.control.value.trim();}
    if(key.value.trim())result.apiKey=key.value.trim();return result;
  }
  async function save(){
    const value=payload();
    try{settings=await context.api('POST','/api/settings/ai',value);if(ws.signal.aborted)return;fill();publishAiSettings('image');ws.say('图像连接已保存，所有图像节点可直接使用');}
    finally{key.value='';delete value.apiKey;}
  }
  const element=el('section',{class:'ns-global-image-config'},provider.group,keyGroup,workspace.group,advanced,local,state,
    actions(ws.button('保存图像连接',save,{primary:true}),ws.button('检查连接',async()=>{
      const value=payload();state.textContent='正在读取模型列表';
      try{const result=await context.api('POST','/api/settings/ai/check',value);if(!ws.signal.aborted)state.textContent=result.message||'检查完成';}
      finally{key.value='';delete value.apiKey;}
    })),notice('密钥仅用于本次运行，保存设置不会生图'));
  ws.on(provider.control,'change',fill);ws.cleanup(()=>{key.value='';});fill();return {element};
}
