"""Isolated browser harness for the collaboration workspace and actual run routes."""
from pathlib import Path
import re
import sys
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
from check_node_assistant import AssistantTests
from node_studio.routes import register_node_studio_routes
import co_design

ROOT=Path(__file__).resolve().parents[1]
fixture=AssistantTests(); fixture.setUp()
app=FastAPI(); store=register_node_studio_routes(app,fixture.core); flow=store.create(fixture.workflow)
app.mount('/web',StaticFiles(directory=ROOT/'web'),name='web')
app.mount('/data',StaticFiles(directory=fixture.core.DATA),name='data')
flags={'fail':False}; transport=co_design._request

def mock_transport(*args,**kwargs):
    if flags.pop('fail',False): raise HTTPException(503,'模拟模型暂时不可用')
    fixture.answer={'message':'已减淡当前血迹，保留领巾。你可以接着调整分布和颜色。','toolCalls':[{'name':'adjust_strokes','arguments':{'strokeIds':['stroke-1'],'opacityScale':.6}}]}
    return transport(*args,**kwargs)
co_design._request=mock_transport

@app.get('/api/assistant/settings')
def settings(): return {'provider':'local_openai','ready':True}
@app.get('/qa/fixture')
def workflow(): return store.get(flow['id'])
@app.post('/qa/reset')
def reset():
    global flow
    flow=store.create(fixture.workflow); fixture.calls.clear(); flags['fail']=False
    return {'ready':True}
@app.get('/qa/requests')
def requests(): return {'count':len(fixture.calls),'roles':[[m['role'] for m in c['payload']['messages']] for c in fixture.calls]}
@app.post('/qa/fail')
def fail(): flags['fail']=True; return {'ready':True}
@app.post('/qa/long')
def long_discussion():
    saved=store.get(flow['id']); node=next(n for n in saved['nodes'] if n['id']=='assistant-1')
    node['output']['conversation']['messages'].append({'id':'long-message','role':'assistant','content':'\n'.join(f'第{n}点：保留领巾，减淡下摆血迹' for n in range(1,80)),'state':'discussion'})
    store.save(saved['id'],saved,saved['revision']); return {'ready':True}

links=''.join(re.findall(r'<link[^>]+rel="stylesheet"[^>]*>',(ROOT/'web/node-studio/index.html').read_text(encoding='utf-8')))
HTML='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">LINKS<style>html,body{height:100%;overflow:hidden;margin:0}#mount{height:calc(100vh - 88px)}header{height:88px;display:flex;align-items:center;padding:0 28px;gap:24px;box-sizing:border-box;background:#f7f6ee;border-bottom:1px solid #ccd1c8}header h2{margin:0;font-size:19px}#header{margin-left:auto}</style></head><body><header><h2>遗迹重构 · 协作执行</h2><div id="header"></div></header><main id="mount"></main><script type="module">
import {assistantWorkspace} from '/web/node-studio/workspaces/assistants.js';
import {arrangeWorkspace} from '/web/node-studio/workspaces/layout.js';
let flow=await(await fetch('/qa/fixture')).json();
const activeId='assistant-1';
async function api(method,path,data){const response=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw Error(result.detail||'请求失败');return result;}
const context={node:flow.nodes.find(n=>n.id===activeId),workflow:flow,headerActions:document.querySelector('#header'),definition:{label:'协作执行'},api,
getWorkflow:()=>flow,getInput:()=>flow.nodes.find(n=>n.id==='target-1').output,
updateNode:change=>Object.assign(flow.nodes.find(n=>n.id===activeId).params,change),
saveWorkflow:async()=>{flow=(await api('PUT',`/api/node-studio/workflows/${flow.id}`,{workflow:flow,expectedRevision:flow.revision})).workflow},
runNode:async opts=>{await context.saveWorkflow();const result=await api('POST',`/api/node-studio/workflows/${flow.id}/nodes/${activeId}/run`,{expectedRevision:flow.revision,...opts});flow=result.workflow;return result},
commitOutput:async value=>{flow.nodes.find(n=>n.id===activeId).output=value;await context.saveWorkflow()},setStatus:()=>{}};
window.qa={context,flow:()=>flow}; const ws=await assistantWorkspace(document.querySelector('#mount'),context); arrangeWorkspace(ws,context); window.qa.workspace=ws;
</script></body></html>'''.replace('LINKS',links)
@app.get('/')
def page(): return HTMLResponse(HTML)

if __name__=='__main__':
    try: uvicorn.run(app,host='127.0.0.1',port=int(sys.argv[1]) if len(sys.argv)>1 else 17917,log_level='warning')
    finally: fixture.tearDown()
