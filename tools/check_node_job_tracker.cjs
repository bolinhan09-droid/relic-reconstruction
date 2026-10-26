'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');

(async () => {
  const dataModule = file => 'data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '../web/node-studio/core/', file), 'utf8')).toString('base64');
  const source = fs.readFileSync(path.join(__dirname, '../web/node-studio/core/job-tracker.js'), 'utf8').replace("'./image-results.js'", JSON.stringify(dataModule('image-results.js'))).replace("'./graph.js'", JSON.stringify(dataModule('graph.js')));
  const {adoptImageResult, imageVersions} = await import(dataModule('image-results.js'));
  const {GenerationTracker} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const originalTimer = global.setTimeout, originalClear = global.clearTimeout, originalNow = Date.now;
  let clock = 0, serial = 0, timers = new Map();
  global.setTimeout = (fn, delay = 0) => {const id = ++serial; timers.set(id, {fn, at: clock + delay}); return id;};
  global.clearTimeout = id => timers.delete(id);
  Date.now = () => clock;
  async function advance(ms = 0) {
    const target = clock + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      timers.delete(next[0]); clock = next[1].at; await next[1].fn();
    }
    clock = Math.max(clock, target);
  }
  function initial(id = 'flow-a', jobId = 'job-test') {
    return {id, order: ['image', 'precision'], revision: 7, title: 'keep my title', nodes: [
      {id: 'image', status: 'running', output: {kind: 'generation_job', jobId, jobStatus: 'queued', imageUrl: '/data/uploads/original/image.png', projectId: 'project-test'}},
      {id: 'precision', params: {color: 'green'}, output: {imageUrl: '/data/uploads/unrelated/image.png'}}]};
  }
  function fixture(api) {
    let workflow = initial(), writes = 0, updates = [], notices = [];
    const tracker = new GenerationTracker({api, getWorkflow: () => workflow,
      updateWorkflow: next => {workflow = next; writes++;}, onUpdate: (...args) => updates.push(args), notify: message => notices.push(message)});
    return {tracker, get workflow() {return workflow;}, set workflow(value) {workflow = value;}, get writes() {return writes;}, updates, notices};
  }
  const checks = [];
  try {
    let response = {id: 'job-test', status: 'running', progress: .2, message: 'working'}, requests = [];
    const f = fixture(async (method, endpoint) => {requests.push({method, endpoint}); return structuredClone(response);});
    f.tracker.start(); f.tracker.start();
    assert.equal(timers.size, 1); await advance();
    assert.equal(f.writes, 1); assert.equal(f.workflow.nodes[0].output.imageUrl, '/data/uploads/original/image.png');
    await advance(1500); assert.equal(f.writes, 1);
    assert(requests.every(request => request.method === 'GET' && request.endpoint === '/api/jobs/job-test'));
    checks.push('idempotent start, GET-only polling and no repeated identical saves');
    response = {id: 'job-test', status: 'succeeded', progress: 1, outputUrl: '/data/jobs/job-test/result.png', projectId: 'project-test', projectRevision: 2, usage: {total_tokens: 20}};
    await advance(1500);
    assert.equal(f.workflow.nodes[0].status, 'succeeded');
    assert.equal(f.workflow.nodes[0].output.kind, 'garment');
    assert.equal(f.workflow.nodes[0].output.candidateImageUrl, undefined);
    assert.equal(f.workflow.nodes[0].output.imageUrl, '/data/jobs/job-test/result.png');
    assert.equal(f.workflow.nodes[0].versions.at(-1).output.imageUrl, '/data/uploads/original/image.png');
    assert.equal(f.workflow.nodes[1].status, 'stale');
    assert.equal(f.workflow.nodes[1].params.color, 'green');
    assert.equal(f.workflow.nodes[0].output.reference.jobId, 'job-test');
    const callsAfterComplete = requests.length, writesAfterComplete = f.writes;
    await advance(10000); assert.equal(requests.length, callsAfterComplete); assert.equal(f.writes, writesAfterComplete);
    checks.push('success is current, old image is recoverable, downstream stale and terminal polling stops');
    f.tracker.stop(); assert.equal(timers.size, 0);

    const failure = fixture(async () => ({id: 'job-test', status: 'interrupted', message: 'application restarted'}));
    failure.tracker.start(); await advance();
    assert.equal(failure.workflow.nodes[0].status, 'interrupted'); assert.equal(failure.workflow.nodes[0].output.imageUrl, '/data/uploads/original/image.png');
    const written = failure.writes; await advance(4500); assert.equal(failure.writes, written);
    failure.tracker.stop(); checks.push('failed/interrupted work never retries generation or changes original');

    let resolve, pending = new Promise(done => {resolve = done;}), inFlight = 0, maximum = 0;
    const switched = fixture(async () => {inFlight++; maximum = Math.max(maximum, inFlight); const value = await pending; inFlight--; return value;});
    switched.tracker.start(); const round = advance(); await Promise.resolve();
    assert.equal(inFlight, 1); await switched.tracker._tick(); assert.equal(maximum, 1);
    switched.workflow = initial('flow-b', 'job-other');
    resolve({id: 'job-test', status: 'succeeded', outputUrl: '/data/jobs/job-test/result.png'}); await round;
    assert.equal(switched.writes, 0); assert.equal(switched.workflow.id, 'flow-b');
    switched.tracker.stop(); checks.push('one round at a time and stale responses cannot write another project');

    pending = new Promise(done => {resolve = done;});
    const edited = fixture(async () => pending);
    edited.tracker.start(); const editedRound = advance(); await Promise.resolve();
    edited.workflow = {...edited.workflow, revision: 12, title: 'new local title', nodes: edited.workflow.nodes.map(node => node.id === 'precision' ? {...node, params: {color: 'blue'}} : node)};
    resolve({id: 'job-test', status: 'succeeded', outputUrl: '/data/jobs/job-test/result.png'}); await editedRound;
    assert.equal(edited.workflow.revision, 12); assert.equal(edited.workflow.title, 'new local title'); assert.equal(edited.workflow.nodes[1].params.color, 'blue');
    edited.tracker.stop(); checks.push('in-flight completion merges into newest revision and retains other edits');

    const stale = fixture(async () => ({id: 'job-test', status: 'succeeded', outputUrl: '/data/jobs/job-test/result.png'}));
    stale.workflow.nodes[0].status = 'stale'; stale.tracker.start(); await advance();
    assert.equal(stale.workflow.nodes[0].status, 'stale'); assert.equal(stale.workflow.nodes[0].output.basedOnOlderInput, true);
    stale.tracker.stop(); checks.push('old-input success keeps stale warning');

    for (const unsafe of ['https://outside.example/result.png', '/data/../private/result.png', '/data/jobs/job-test/result.png?key=secret', '//outside.example/result.png']) {
      const invalid = fixture(async () => ({id: 'job-test', status: 'succeeded', outputUrl: unsafe}));
      invalid.tracker.start(); await advance();
      assert.equal(invalid.workflow.nodes[0].status, 'failed'); assert.equal(invalid.workflow.nodes[0].output.candidateImageUrl, undefined);
      invalid.tracker.stop();
    }
    checks.push('remote, traversal, signed-query and protocol-relative results rejected');

    let networkCalls = 0;
    const offline = fixture(async (method) => {assert.equal(method, 'GET'); networkCalls++; throw Error('offline');});
    offline.tracker.start(); await advance();
    await advance(120000);
    assert.equal(networkCalls, 6); assert.equal(offline.writes, 0); assert.equal(offline.notices.length, 2);
    offline.tracker.stop(); checks.push('network backoff is bounded and does not create or resubmit jobs');

    pending = new Promise(done => {resolve = done;});
    const stopped = fixture(async () => pending);
    stopped.tracker.start(); const stoppedRound = advance(); await Promise.resolve(); stopped.tracker.stop();
    resolve({id: 'job-test', status: 'succeeded', outputUrl: '/data/jobs/job-test/result.png'}); await stoppedRound;
    assert.equal(stopped.writes, 0); checks.push('stop invalidates in-flight updates');

    const marks = [{id: 'stroke', brush: 'blood'}], snapshot = {brushStrokes: marks};
    const baked = adoptImageResult({kind: 'generation_job', jobId: 'old', imageUrl: '/data/source.png', brushStrokes: marks, projectSnapshot: snapshot, damageItems: [{}], protectedRects: [{}]}, '/data/result.png', {jobId: 'new'});
    assert.deepEqual(baked.brushStrokes, []); assert.equal(baked.projectSnapshot, null);
    assert.deepEqual(baked.sourceBrushStrokes, marks); assert.deepEqual(baked.originalProjectSnapshot, snapshot);
    assert.equal(baked.jobId, undefined); assert.equal(baked.imageSemantics, 'raster_base');
    const history = imageVersions({output: baked, versions: [{id: 'a', output: {imageUrl: '/data/source.png'}}, {id: 'b', output: baked}, {id: 'c', output: {imageUrl: '/data/source.png'}}]}, {imageUrl: '/data/source.png'});
    assert.equal(history.length, 2); assert.equal(history[0].id, 'current'); assert.equal(history[1].id, 'c');
    checks.push('raster adoption clears replayable marks, retains provenance and deduplicates image history');

    const oldResult = {kind: 'garment', imageUrl: '/data/old-result.png', projectId: 'old-project', sourceBrushStrokes: [{id:'old-source'}], originalProjectSnapshot: {id:'old-snapshot', brushStrokes:[{id:'old-source'}]}, reference:{url:'/data/old-result.png'}, view:'front'};
    const taskOutput = {...oldResult, kind:'generation_job', jobId:'job-test', jobStatus:'queued', projectId:'new-job-project',
      generationPreviousOutput: structuredClone(oldResult), generationSource: {imageUrl:'/data/new-input.png',sourceNodeId:'new-source',brushStrokes:[{id:'new-source'}],projectSnapshot:{id:'new-snapshot',brushStrokes:[{id:'new-source'}]}}};
    const provenance = fixture(async () => ({status:'succeeded',outputUrl:'/data/new-result.png',projectId:'new-job-project'}));
    provenance.workflow.nodes[0].output=structuredClone(taskOutput);provenance.tracker.start();await advance();
    const accepted=provenance.workflow.nodes[0].output, previousResult=provenance.workflow.nodes[0].versions.at(-1).output;
    assert.deepEqual(accepted.sourceBrushStrokes,[{id:'new-source'}]);assert.equal(accepted.originalProjectSnapshot.id,'new-snapshot');assert.equal(accepted.sourceImageUrl,'/data/new-input.png');
    assert.deepEqual(previousResult,oldResult);assert.equal(accepted.generationSource,undefined);assert.equal(accepted.generationPreviousOutput,undefined);
    provenance.tracker.stop();checks.push('new source geometry goes only to new result; old version keeps its original snapshot');
    for(const status of ['failed','invalid']) {
      const rollback=fixture(async()=>status==='failed'?{status:'failed',message:'mock failure'}:{status:'succeeded',outputUrl:'https://invalid.example/result.png'});
      rollback.workflow.nodes[0].output=structuredClone(taskOutput);rollback.tracker.start();await advance();
      const restored=rollback.workflow.nodes[0].output;
      for(const [key,value] of Object.entries(oldResult))assert.deepEqual(restored[key],value);
      assert.equal(restored.generationSource,undefined);assert.equal(restored.generationPreviousOutput,undefined);assert.equal(restored.failedGeneration.jobId,'job-test');
      rollback.tracker.stop();
    }
    checks.push('failed and invalid jobs restore old project, image, marks and snapshot without source contamination');
    const emptySource=adoptImageResult({...taskOutput,generationSource:{imageUrl:'/data/clean.png',brushStrokes:[],projectSnapshot:{brushStrokes:[]}}},'/data/clean-result.png');
    assert.deepEqual(emptySource.sourceBrushStrokes,[]);assert.deepEqual(emptySource.originalProjectSnapshot.brushStrokes,[]);
    checks.push('intentionally empty new source cannot inherit old marks');

    console.log(JSON.stringify({passed: checks.length, checks, generationRequests: 0}, null, 2));
  } finally {
    global.setTimeout = originalTimer; global.clearTimeout = originalClear; Date.now = originalNow;
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
