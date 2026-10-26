/* Deterministic coverage contract; no network, credentials or project data. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||path.join(root,'work/v0116-blood-check'));
const context=vm.createContext({Math,Date,Uint32Array});
vm.runInContext(fs.readFileSync(path.join(root,'web/blood-engine.js'),'utf8'),context);
const E=context.RelicBloodEngine,plain=value=>JSON.parse(JSON.stringify(value));
const checks=[],check=(name,fn)=>{fn();checks.push(name);};
const config={id:'coverage-check',seed:14719,origin:{x:.22,y:.3},target:{x:.8,y:.65},force:.82,spread:.82,amount:.84,size:.075,opacity:.86,color:'#782c2b',effectSubtype:'splatter',effectParameters:{detail:.55,age:0,wetness:0}};
const narrow=E.createSplatter({...config,coverage:.22},1024,1280),wide=E.createSplatter({...config,coverage:.92},1024,1280);
function extent(s){const p=s.shapes.flatMap(x=>x.points||[{x:x.cx-x.rx,y:x.cy-x.ry},{x:x.cx+x.rx,y:x.cy+x.ry}]);return {w:Math.max(...p.map(q=>q.x))-Math.min(...p.map(q=>q.x)),h:Math.max(...p.map(q=>q.y))-Math.min(...p.map(q=>q.y))};}
function area(s){if(s.kind==='ellipse')return Math.PI*s.rx*s.ry;return Math.abs(s.points.reduce((n,p,i)=>{const q=s.points[(i+1)%s.points.length];return n+p.x*q.y-p.y*q.x;},0))*.5;}
check('coverage increases both axes without changing force, amount or size',()=>{const a=extent(narrow),b=extent(wide);assert(b.w>a.w*2&&b.h>a.h*2);for(const key of ['force','amount'])assert.equal(narrow.bloodParameters[key],wide.bloodParameters[key]);assert.equal(narrow.size,wide.size);});
check('wide strokes contain major stains, medium drops and fine satellites',()=>{const a=wide.shapes.map(area).sort((a,b)=>a-b);assert(a.at(-1)>a[Math.floor(a.length*.5)]*60);assert(a.filter(v=>v>.00002&&v<.0003).length>8);assert(a.filter(v=>v<.000004).length>15);});
check('coverage and seed replay identically after save and regeneration',()=>{const stored=plain(wide),again=E.regenerateSplatter(stored,{},1024,1280);assert.deepEqual(plain(again),stored);assert.equal(again.bloodParameters.coverage,.92);});
check('range changes leave the undo source untouched',()=>{const before=plain(wide),changed=E.regenerateSplatter(wide,{coverage:.3},1024,1280);assert.deepEqual(plain(wide),before);assert.notDeepEqual(plain(changed.shapes),before.shapes);});
check('legacy v2 metadata can be explicitly regenerated without coverage',()=>{const legacy=plain(narrow);delete legacy.bloodParameters.coverage;const next=E.regenerateSplatter(legacy,{},1024,1280);assert.equal(next.bloodParameters.coverage,.55);assert(!('coverage' in legacy.bloodParameters));});
check('wide presets remain within the existing shape and vertex limits',()=>{for(let seed=0;seed<60;seed++){const s=E.createSplatter({...config,seed,coverage:1,amount:1,spread:1,force:1},1024,1280);assert(s.shapes.length<=E.limits.splatterShapes+8);assert(s.shapes.reduce((n,p)=>n+(p.points?.length||0),0)<6000);for(const p of s.shapes)if(p.points)assert(p.points.every(v=>v.x>=0&&v.x<=1&&v.y>=0&&v.y<=1));}});
const soak=E.createSoakStroke({id:'coverage-soak',seed:443,size:.13,opacity:.86,color:config.color,flow:.86,edgeSoftness:.8,effectSubtype:'soak'});
for(let i=0;i<34;i++)E.appendSoakPoint(soak,{x:.3+i*.011,y:.32+Math.sin(i*.07)*.08},1024,1280,.5+i*.014);
const report={checks:checks.length,passed:checks,narrowExtent:extent(narrow),wideExtent:extent(wide),shapes:wide.shapes.length,physicalSimulation:false};
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'coverage-report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(out,'coverage-samples.json'),JSON.stringify({width:1024,height:1280,narrow:plain(narrow),wide:plain(wide),soak:plain(soak)},null,2));console.log(JSON.stringify(report));
