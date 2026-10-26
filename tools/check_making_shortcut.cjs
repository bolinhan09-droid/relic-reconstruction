'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
(async()=>{
 const core=path.join(__dirname,'../web/node-studio/core'),url=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
 const graph=url(fs.readFileSync(path.join(core,'graph.js'),'utf8')),model=url(fs.readFileSync(path.join(core,'model.js'),'utf8').replaceAll('./graph.js',graph));
 const m=await import(model),{appendMakingRoute}=await import(url(fs.readFileSync(path.join(core,'making-route.js'),'utf8').replaceAll('./model.js',model)));
 const catalog=['garment_input','precision_edit','production_guide','garment_flatten','flatten_map','stencil_export','branch_create','branch_merge'].map(type=>({type,label:type,placement:'main'}));
 const input=m.makeNode('garment_input',catalog,{front:{url:'/data/uploads/source.png'}}),edit=m.makeNode('precision_edit',catalog),guide=m.makeNode('production_guide',catalog),suffix=m.makeNode('precision_edit',catalog);
 edit.output={kind:'garment',imageUrl:'/data/edit.png',projectSnapshot:{brushStrokes:[{id:'kept'}]},reference:{url:'/data/uploads/source.png'}};edit.status='succeeded';guide.output={imageUrl:'/data/edit.png',report:{}};suffix.output={imageUrl:'/data/later.png'};suffix.status='succeeded';
 const w={nodes:[input,edit,guide,suffix],order:[input.id,edit.id,guide.id,suffix.id],stash:[]};
 const a=appendMakingRoute(w,guide.id,catalog),photo=m.findNode(a.workflow,a.firstId);
 assert(a.created);assert.equal(w.nodes.length,4);assert.equal(a.workflow.order.at(-1),suffix.id);assert.equal(m.findNode(a.workflow,suffix.id).status,'stale');
 assert.deepEqual(m.upstreamOutput(a.workflow,photo.id),edit.output);
 const b=appendMakingRoute(a.workflow,guide.id,catalog);assert(!b.created);assert.equal(b.firstId,a.firstId);assert.equal(b.workflow.nodes.length,a.workflow.nodes.length);
 const branched=m.createBranchGroup(w,edit.id,catalog),route=m.laneForNode(branched,guide.id),before=m.copy(branched),c=appendMakingRoute(branched,guide.id,catalog);
 assert.equal(m.laneForNode(c.workflow,c.firstId).id,route.id);assert.deepEqual(c.workflow.order,before.order);assert.deepEqual(c.workflow.branches[1],before.branches[1]);
 assert.throws(()=>appendMakingRoute(w,input.id,catalog));m.assertWorkflow(c.workflow);
 console.log(JSON.stringify({passed:6,checks:['idempotent preparation route','preserves suffix and marks stale','keeps editable source through guide','isolates branch insertion','does not mutate source workflow','rejects non-production host'],externalCalls:0}));
})().catch(e=>{console.error(e);process.exitCode=1});
