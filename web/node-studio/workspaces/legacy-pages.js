import { pagePanel, installWorkbenchStyle } from './paged-workbench.js';

/** The editor's canvas coordinate system is untouched; only surrounding UI is rearranged. */
export function arrangeLegacyWorkbench(doc, mode) {
  installWorkbenchStyle(doc);
  const cleanups = [], win = doc.defaultView;
  const make = (tag, cls, text) => {const node=doc.createElement(tag);node.className=cls;if(text)node.textContent=text;return node;};
  if (mode !== 'mapping') {
    const controls=doc.querySelector('.control-panel');
    if(controls){const pager=pagePanel(controls,{label:'笔刷'});cleanups.push(()=>pager.destroy());}
  } else {
    const dialog=doc.getElementById('garmentMappingDialog'),body=dialog?.querySelector('.gm-body');
    if(body&&!dialog.classList.contains('gm-paged')){
      dialog.classList.add('gm-paged');
      const stage=make('section','gm-main-stage'), controls=make('aside','gm-paged-controls');
      const tabs=make('nav','ns-result-tabs'),position=make('button','ns-button','对应位置'),result=make('button','ns-button','映射结果');
      position.type=result.type='button';tabs.append(position,result);
      const boards=body.querySelector('.gm-boards'), resultPanel=make('section','gm-result-page');
      resultPanel.append(doc.getElementById('gmResult')); stage.append(tabs,boards,resultPanel);
      const footer=make('div','ns-fixed-actions');footer.append(body.querySelector('.gm-submit'));
      controls.append(...body.childNodes);body.replaceChildren(stage,controls);
      const settingPager=pagePanel(controls,{label:'映射设置',footer});
      const resultPager=pagePanel(resultPanel,{label:'映射结果'});
      function choose(showResult){boards.hidden=showResult;resultPanel.hidden=!showResult;position.setAttribute('aria-selected',String(!showResult));result.setAttribute('aria-selected',String(showResult));resultPager.refresh();}
      const showPositions=()=>choose(false),showResults=()=>choose(true);
      position.addEventListener('click',showPositions); result.addEventListener('click',showResults);
      const output=doc.getElementById('gmResult');
      const observer=new win.MutationObserver(()=>{result.disabled=output.hidden;if(output.hidden)choose(false);});
      observer.observe(output,{attributes:true,attributeFilter:['hidden']});
      output.addEventListener('mapping:result',showResults);result.disabled=output.hidden;choose(!output.hidden);
      cleanups.push(()=>{settingPager.destroy();resultPager.destroy();observer.disconnect();output.removeEventListener('mapping:result',showResults);});
    }
  }
  const destroy=()=>{cleanups.forEach(fn=>fn());};win.addEventListener('pagehide',destroy,{once:true});return destroy;
}
