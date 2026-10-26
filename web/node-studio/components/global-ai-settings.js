import { el } from '../workspaces/shared.js';
import { assistantConfiguration } from '../workspaces/assistant-configuration.js';
import { imageConfiguration } from '../workspaces/image-configuration.js';
import { createApiSettingsHint } from './api-guide.js';

/** One shell-owned settings dialog; nodes request it without sending secrets. */
export function mountGlobalAiSettings({api,notify=()=>{}}) {
  const sheet=el('link',{rel:'stylesheet',href:new URL('../styles/global-ai-settings.css',import.meta.url).href});
  document.head.append(sheet);
  let session=null,returnFocus=null,disposed=false;
  const title=el('h2',{id:'globalAiTitle',text:'AI 设置'});
  const closeButton=el('button',{type:'button',class:'ns-button',text:'关闭', 'aria-label':'关闭 AI 设置'});
  const tabs=el('div',{class:'ns-global-ai-tabs',role:'tablist','aria-label':'AI 服务用途'});
  const panels=el('div',{class:'ns-global-ai-panels'});
  const status=el('p',{class:'ns-ws-status',role:'status','aria-live':'polite'});
  const hint=createApiSettingsHint();
  const dialog=el('dialog',{class:'ns-global-ai-dialog','aria-labelledby':'globalAiTitle'},
    el('header',{},el('div',{},title,el('p',{text:'配置一次，节点直接使用'})),closeButton),hint.element,tabs,panels,status);
  document.body.append(dialog);
  const buttons={};
  function formHost(section,controller){
    const root=el('div',{dataset:{workspace:`global-${section}`}}),cleanups=[];
    const host={root,params:{},signal:controller.signal,
      on(target,event,handler){target.addEventListener(event,handler,{signal:controller.signal});},
      patch(){throw Error('全局设置不能写入作品');},save:async()=>{},
      say(message,error=false){if(controller.signal.aborted)return;status.textContent=message;status.classList.toggle('is-error',error);},
      cleanup(fn){cleanups.push(fn);},
      button(label,action,{primary=false,disabled=false,className=''}={}){
        const button=el('button',{type:'button',class:`ns-button ${primary?'is-primary':''} ${className}`,text:label,disabled});
        button.addEventListener('click',async()=>{
          if(button.disabled)return;button.disabled=true;
          try{await action();}catch(error){host.say(error.message||'设置未保存',true);}
          finally{if(!controller.signal.aborted)button.disabled=false;}
        },{signal:controller.signal});return button;
      }
    };
    controller.signal.addEventListener('abort',()=>cleanups.forEach(fn=>fn()),{once:true});return host;
  }
  async function select(section){
    section=section==='image'?'image':'assistant';
    if(!session)return;const active=session;status.textContent='';
    for(const [name,button] of Object.entries(buttons)){
      button.setAttribute('aria-selected',String(name===section));button.tabIndex=name===section?0:-1;
      active.panels[name].hidden=name!==section;
    }
    if(active.loaded.has(section))return;
    active.loaded.add(section);const panel=active.panels[section];panel.textContent='正在读取连接';
    try{
      const ws=formHost(section,active.controller),context={api,node:{id:`global-${section}`}};
      const view=await(section==='image'?imageConfiguration(ws,context):assistantConfiguration(ws,context));
      if(active!==session||active.controller.signal.aborted)return;
      if(section==='assistant'){view.element.open=true;view.element.querySelector(':scope > summary')?.remove();}
      panel.replaceChildren(view.element);
    }catch(error){if(active===session){panel.textContent=error.message||'无法读取连接';active.loaded.delete(section);}}
  }
  for(const [section,label] of [['assistant','协作助手'],['image','图像生成']]){
    const button=el('button',{type:'button',role:'tab',id:`global-ai-tab-${section}`,'aria-controls':`global-ai-panel-${section}`,text:label});
    button.addEventListener('click',()=>select(section));buttons[section]=button;tabs.append(button);
  }
  tabs.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    const current=document.activeElement===buttons.image?'image':'assistant';
    const next=event.key==='Home'?'assistant':event.key==='End'?'image':current==='image'?'assistant':'image';
    select(next);buttons[next].focus();
  });
  function release(){
    session?.controller.abort();session=null;panels.replaceChildren();status.textContent='';
    const target=returnFocus;returnFocus=null;if(target?.isConnected)target.focus();
  }
  function close(){if(dialog.open)dialog.close();else release();}
  function open(section='assistant'){
    if(disposed)return;
    if(!dialog.open){
      returnFocus=document.activeElement;session={controller:new AbortController(),panels:{},loaded:new Set()};
      for(const name of ['assistant','image']){
        const panel=el('section',{id:`global-ai-panel-${name}`,role:'tabpanel','aria-labelledby':`global-ai-tab-${name}`});
        session.panels[name]=panel;panels.append(panel);
      }
      dialog.showModal();
      hint.onOpen();
    }
    select(section);buttons[section==='image'?'image':'assistant'].focus();
  }
  const request=event=>open(event.detail?.section);
  const iframeRequest=event=>{
    if(event.origin!==location.origin||event.data?.type!=='relic-open-ai-settings')return;
    if(![...document.querySelectorAll('iframe')].some(frame=>frame.contentWindow===event.source))return;
    open(event.data.section);
  };
  const relay=event=>{
    // Only a public change signal crosses into embedded editors, never keys/settings.
    for(const frame of document.querySelectorAll('iframe'))frame.contentWindow?.postMessage({type:'relic-ai-settings-changed',section:event.detail?.section},location.origin);
  };
  closeButton.addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{event.preventDefault();event.stopPropagation();close();});
  dialog.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();}});
  dialog.addEventListener('close',release);
  window.addEventListener('relic-open-ai-settings',request);
  window.addEventListener('message',iframeRequest);
  window.addEventListener('relic-ai-settings-changed',relay);
  return {open,close,isOpen:()=>dialog.open,destroy(){disposed=true;close();window.removeEventListener('relic-open-ai-settings',request);window.removeEventListener('message',iframeRequest);window.removeEventListener('relic-ai-settings-changed',relay);hint.destroy();dialog.remove();sheet.remove();}};
}
