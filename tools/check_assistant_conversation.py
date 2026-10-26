"""Conversation + direct adoption through real registered routes, no paid models."""
from __future__ import annotations
import copy
import json
import unittest
from unittest.mock import patch
from fastapi import FastAPI, HTTPException
from check_node_assistant import AssistantTests
from check_node_studio_backend import LocalRouteClient
import co_design
from node_studio import assistant_conversation as dialogue
from node_studio import assistant_engine as engine
from node_studio.routes import register_node_studio_routes


class ConversationTests(unittest.TestCase):
    setUp = AssistantTests.setUp
    tearDown = AssistantTests.tearDown
    run_engine = AssistantTests.run_engine

    def routes(self):
        app = FastAPI(); self.store = register_node_studio_routes(app, self.core)
        self.client = LocalRouteClient(app)
        self.saved = self.store.create(self.workflow)
        self.path = f"/api/node-studio/workflows/{self.saved['id']}/nodes/{self.node['id']}/run"

    def request(self, **payload):
        response = self.client.post(self.path, json={'expectedRevision': self.saved['revision'], **payload})
        if response.status_code == 200: self.saved = response.json()['workflow']
        return response

    def test_route_execute_conversation_and_version_switch(self):
        self.routes()
        first = self.request(assistantAction='execute', params={'confirmedConstraints':'领巾和徽记必须保留'})
        self.assertEqual(first.status_code,200,first.text)
        output = first.json()['result']; self.assertTrue(output['adopted'])
        self.assertFalse(output['requiresExplicitAdoption']); self.assertEqual(len(self.calls),1)
        target = next(n for n in self.saved['nodes'] if n['id']=='target-1')
        self.assertEqual(target['output']['brushStrokes'][0]['opacity'],.4)
        self.assertEqual(output['imageUrl'],target['output']['imageUrl'])
        self.assertEqual(len(output['conversation']['messages']),2)
        self.assertIn('领巾和徽记必须保留',self.calls[-1]['payload']['messages'][0]['content'])
        original_version = target['versions'][0]['id']
        self.answer = {'message':'沿用上一轮要求，再减淡这笔血迹', 'toolCalls':[{'name':'adjust_strokes','arguments':{'strokeIds':['stroke-1'],'opacityScale':.5}}]}
        second = self.request(assistantAction='execute',params={'intent':'再淡一点'})
        self.assertEqual(second.status_code,200,second.text)
        history = self.calls[-1]['payload']['messages']
        self.assertEqual([entry['role'] for entry in history], ['system','user','assistant','user'])
        self.assertIn('降低这笔血迹',history[1]['content']); self.assertIn('已保存',history[2]['content'])
        self.assertEqual(second.json()['result']['conversation']['messages'][-2]['content'],'再淡一点')
        target = next(n for n in self.saved['nodes'] if n['id']=='target-1')
        self.assertEqual(target['output']['brushStrokes'][0]['opacity'],.2)
        count = len(self.saved['nodes'])
        switched = self.request(assistantAction='switch_version',versionId=original_version)
        self.assertEqual(switched.status_code,200,switched.text)
        self.assertEqual(len(self.calls),2)
        self.assertEqual(len(self.saved['nodes']),count)
        target = next(n for n in self.saved['nodes'] if n['id']=='target-1')
        self.assertEqual(target['output']['brushStrokes'][0]['opacity'],.8)
        self.assertEqual(len(target['versions']),3)
        self.assertEqual(self.source.read_bytes(),self.source_bytes)
        persisted = self.store.get(self.saved['id'])
        assistant = next(n for n in persisted['nodes'] if n['id']=='assistant-1')
        self.assertEqual(len(assistant['output']['conversation']['messages']),6)
        self.assertEqual(assistant['output']['conversation']['messages'][-1]['state'],'restored')

    def test_failed_followup_keeps_prior_work_and_request_once(self):
        self.routes(); self.assertEqual(self.request(assistantAction='execute').status_code,200)
        before = copy.deepcopy(self.saved); calls=[]
        def fail_request(*args,**kwargs):
            calls.append(kwargs); raise HTTPException(503,'模拟本地模型暂不可用')
        with patch.object(co_design,'_request',fail_request):
            response = self.request(assistantAction='execute',params={'intent':'再淡一点'})
        self.assertEqual(response.status_code,503); self.assertEqual(len(calls),1)
        self.assertEqual(self.store.get(self.saved['id']),before)

    def test_history_isolated_by_workflow_node_host_and_branch(self):
        self.node['type']='design_advice'; self.answer={'message':'只讨论这个方案','suggestions':[{'title':'下摆','detail':'可以减淡'}]}
        output = self.run_engine(); self.node['output']=output
        self.run_engine(); self.assertEqual(len(self.calls[-1]['payload']['messages']),4)
        scope = output['conversation']['scope']
        for key in ('workflowId','nodeId','targetNodeId','laneId'):
            other = copy.deepcopy(output); other['conversation']['scope'][key] += '-other'
            self.node['output']=other; self.run_engine()
            self.assertEqual(len(self.calls[-1]['payload']['messages']),2,key)
        self.assertEqual(scope['targetNodeId'],'target-1')

    def test_bounded_text_only_history_and_secret_redaction(self):
        scope = {'workflowId':'w','nodeId':'n','targetNodeId':'t','laneId':'main'}
        output={}; secret='sk-test-key-with-enough-letters'
        for number in range(30):
            conversation=dialogue.append(output,scope,f'第{number}轮 '+secret+' 用户要求'*500,{'message':'具体建议'*800,'apiKey':'must-not-copy'},(secret,))
            output={'conversation':conversation}
        messages = conversation['messages']; blob=json.dumps(conversation,ensure_ascii=False)
        self.assertLessEqual(len(messages),16)
        self.assertLessEqual(sum(len(m['content']) for m in messages),dialogue.MAX_HISTORY_CHARS)
        self.assertNotIn(secret,blob); self.assertNotIn('must-not-copy',blob); self.assertNotIn('apiKey',blob)
        self.assertEqual(messages[0]['role'],'user')
        for entry in messages: self.assertEqual(set(entry),{'id','role','content','state'})
        for malformed in ([],True,{'conversation':{'scope':scope,'messages':None}},{'conversation':{'scope':scope,'messages':'bad'}}):
            self.assertEqual(dialogue.read(malformed,scope)['messages'],[])

    def test_unavailable_retains_conversation_without_fake_turn(self):
        self.node['type']='design_advice'; self.answer={'message':'已有建议','suggestions':[{'title':'下摆','detail':'减淡'}]}
        self.node['output']=self.run_engine(); before=copy.deepcopy(self.node['output']['conversation'])
        co_design._SETTINGS['local_openai']['model']=''
        result=self.run_engine()
        self.assertFalse(result['semanticAI']); self.assertEqual(result['conversation'],before)

    def test_version_is_recorded_on_target_not_supplied_by_client(self):
        self.routes(); self.assertEqual(self.request(assistantAction='execute').status_code,200)
        before=copy.deepcopy(self.saved)
        result=self.request(assistantAction='switch_version',versionId='unknown',imageUrl='/data/uploads/other.png')
        self.assertEqual(result.status_code,404); self.assertEqual(self.store.get(self.saved['id']),before)
        self.assertEqual(len(self.calls),1)

    def test_questions_stay_discussion_and_do_not_apply(self):
        self.answer={'message':'我需要知道你指哪一片衣服','questions':['请圈选你想调整的位置'],'toolCalls':[]}
        result=self.run_engine({'assistantAction':'execute'})
        self.assertEqual(result['kind'],'assistant_plan'); self.assertNotIn('workflowPatch',result)
        self.assertEqual(result['conversation']['messages'][-1]['state'],'discussion')
        self.assertEqual(self.workflow,self.original_workflow)

if __name__=='__main__': unittest.main(verbosity=2)
