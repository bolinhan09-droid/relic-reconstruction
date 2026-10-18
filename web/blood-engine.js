/* Procedural screen marks. They do not simulate blood, cloth or impact physics. */
(function (global) {
  'use strict';
  const TAU=Math.PI*2;
  const LIMITS=Object.freeze({pointsPerStroke:1200,shapesPerStroke:3500,splatterShapes:600,pathChunkPoints:96});
  const live=new WeakMap();
  const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
  const finite=(v,f)=>Number.isFinite(Number(v))?Number(v):f;
  const unit=p=>({x:clamp(finite(p?.x,0)),y:clamp(finite(p?.y,0))});
  function dimensions(width,height){width=Number(width);height=Number(height);if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new TypeError('Blood preview requires finite, positive dimensions.');return {width,height,short:Math.min(width,height)};}
  function color(value){if(/^#[0-9a-f]{3}$/i.test(value||''))return '#'+[...value.slice(1)].map(c=>c+c).join('').toLowerCase();return /^#[0-9a-f]{6}$/i.test(value||'')?value.toLowerCase():'#782c2b';}
  function tones(value){const channels=[1,3,5].map(i=>parseInt(value.slice(i,i+2),16));return [.56,.74,.94,1.05].map(scale=>'#'+channels.map(c=>Math.round(clamp(c*scale,0,255)).toString(16).padStart(2,'0')).join(''));}
  function random(seed,index=0){let state=(seed^Math.imul(index+1,0x9e3779b1))>>>0;return ()=>{state=(state+0x6d2b79f5)>>>0;let v=Math.imul(state^state>>>15,1|state);v^=v+Math.imul(v^v>>>7,61|v);return ((v^v>>>14)>>>0)/4294967296;};}
  function newSeed(){if(global.crypto?.getRandomValues)return global.crypto.getRandomValues(new Uint32Array(1))[0];return (Date.now()^Math.floor(Math.random()*4294967296))>>>0;}
  function baseStroke(options,behavior){const seed=options.seed===undefined?newSeed():finite(options.seed,0)>>>0;const id=String(options.id||'blood-v2-'+seed.toString(16));if(!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw new TypeError('Blood stroke ID must contain 1–100 letters, numbers, underscores or hyphens.');const stroke={id,type:'blood',mode:'free',size:clamp(finite(options.size,.06),.003,.5),opacity:clamp(finite(options.opacity,.78)),color:color(options.color),seed,points:[],shapes:[],bloodBehavior:behavior,bloodVersion:2,bloodParameters:{}};if(['splatter','soak','drip','contact'].includes(options.effectSubtype)){stroke.effectSubtype=behavior==='splatter'?'splatter':options.effectSubtype==='splatter'?'soak':options.effectSubtype;stroke.effectParameters=Object.fromEntries(['detail','age','wetness'].map(k=>[k,clamp(finite(options.effectParameters?.[k],k==='detail'?.55:0))]));}return stroke;}

  // Persisted geometry uses the old ellipse/polygon contract and final alpha.
  // Only the polygon outline is clipped; an ellipse can extend past the canvas.
  function clipPolygon(points){let output=points;const edges=[
    [p=>p.x>=0,(a,b)=>({x:0,y:a.y+(b.y-a.y)*(-a.x/(b.x-a.x))})],
    [p=>p.x<=1,(a,b)=>({x:1,y:a.y+(b.y-a.y)*((1-a.x)/(b.x-a.x))})],
    [p=>p.y>=0,(a,b)=>({x:a.x+(b.x-a.x)*(-a.y/(b.y-a.y)),y:0})],
    [p=>p.y<=1,(a,b)=>({x:a.x+(b.x-a.x)*((1-a.y)/(b.y-a.y)),y:1})]
  ];for(const [inside,intersection] of edges){if(!output.length)break;const next=[];let previous=output[output.length-1];for(const p of output){if(inside(p)!==inside(previous))next.push(intersection(previous,p));if(inside(p))next.push(p);previous=p;}output=next;}return output.map(unit);}
  function emitters(stroke,d,limit=LIMITS.shapesPerStroke){
    const add=shape=>{if(stroke.shapes.length<limit&&shape.alpha>0)stroke.shapes.push(shape);};
    const alpha=v=>clamp(v*stroke.opacity);
    return {
      ellipse(x,y,rx,ry,c,a){const cx=x/d.width,cy=y/d.height;if(cx<0||cx>1||cy<0||cy>1||rx<=0||ry<=0)return;add({kind:'ellipse',cx,cy,rx:clamp(rx/d.width),ry:clamp(ry/d.height),color:c,alpha:alpha(a)});},
      polygon(points,c,a){const clipped=clipPolygon(points.map(p=>({x:p.x/d.width,y:p.y/d.height})));if(clipped.length<3)return;const area=Math.abs(clipped.reduce((sum,p,i)=>{const q=clipped[(i+1)%clipped.length];return sum+p.x*q.y-q.x*p.y;},0));if(area<1e-15)return;add({kind:'polygon',points:clipped,color:c,alpha:alpha(a)});}
    };
  }
  function rotatedOutline(cx,cy,rx,ry,angle,rand,rough=.08,count=16,taper=0){const dx=Math.cos(angle),dy=Math.sin(angle),nx=-dy,ny=dx;const phase=rand()*TAU;return Array.from({length:count},(_,i)=>{const t=i/count*TAU,wave=1+rough*(Math.sin(t*3+phase)*.55+Math.sin(t*7-phase)*.3+(rand()-.5)*.3);const a=Math.cos(t)*rx*wave,b=Math.sin(t)*ry*wave*(1-taper*(1-Math.cos(t))*.5);return {x:cx+dx*a+nx*b,y:cy+dy*a+ny*b};});}
  function drop(emit,x,y,r,angle,elongation,rand,palette,strength,softThreshold,major=false){
    // Only a few primary marks get layered interiors. Most satellites are tiny,
    // single irregular marks, avoiding repeated concentric "tadpole" stamps.
    if(major){
      if(r>softThreshold*1.7)emit.polygon(rotatedOutline(x,y,r*elongation*1.13,r*1.13,angle,rand,.13,18),palette[2],strength*.055);
      emit.polygon(rotatedOutline(x,y,r*elongation,r,angle,rand,.2,20,.12),palette[2],strength*.8);
      if(rand()>.55){const offset=(rand()-.5)*r*.65;emit.polygon(rotatedOutline(x+Math.cos(angle)*offset,y+Math.sin(angle)*offset,r*elongation*(.29+rand()*.23),r*(.31+rand()*.23),angle+.25,rand,.22,14),palette[1],strength*.36);}
    }else if(r<softThreshold*.62&&rand()>.45){
      emit.ellipse(x,y,r,r*(.68+rand()*.34),palette[rand()>.25?2:1],strength);
    }else{
      const count=7+Math.floor(rand()*5);
      emit.polygon(rotatedOutline(x,y,r*elongation,r,angle,rand,.13+rand()*.15,count,elongation>2?.28:0),palette[rand()>.25?2:1],strength);
    }
  }
  function appearance(stroke,d){
    if(!stroke.effectSubtype)return;
    const {age=0,wetness=0}=stroke.effectParameters||{};
    // Screen appearance only: ageing lowers saturation/value; wetness adds sparse
    // narrow highlights. Neither option predicts fluid age, drying or absorbency.
    if(age>0)for(const s of stroke.shapes){const rgb=[1,3,5].map(i=>parseInt(s.color.slice(i,i+2),16)),gray=rgb[0]*.3+rgb[1]*.59+rgb[2]*.11;s.color='#'+rgb.map(c=>Math.round(clamp((c*(1-age*.4)+gray*age*.4)*(1-age*.28),0,255)).toString(16).padStart(2,'0')).join('');}
    if(wetness>0&&stroke.shapes.length){
      const originals=stroke.shapes.slice(),emit=emitters(stroke,d),rand=random(stroke.seed,9823);
      const count=Math.min(8,Math.max(1,Math.round(originals.length/20)));
      const sorted=originals.map(s=>{const ps=s.kind==='polygon'?s.points:[{x:s.cx-s.rx,y:s.cy-s.ry},{x:s.cx+s.rx,y:s.cy+s.ry}];return {s,left:Math.min(...ps.map(p=>p.x)),right:Math.max(...ps.map(p=>p.x)),top:Math.min(...ps.map(p=>p.y)),bottom:Math.max(...ps.map(p=>p.y))};}).sort((a,b)=>(b.right-b.left)*(b.bottom-b.top)-(a.right-a.left)*(a.bottom-a.top));
      const rgb=[1,3,5].map(i=>parseInt(stroke.color.slice(i,i+2),16));const shine='#'+rgb.map(c=>Math.round(c*.4+178*.6).toString(16).padStart(2,'0')).join('');
      for(let i=0;i<count&&i<sorted.length;i++){const b=sorted[i],x=(b.left+(b.right-b.left)*(.35+rand()*.3))*d.width,y=(b.top+(b.bottom-b.top)*(.3+rand()*.2))*d.height;emit.polygon(rotatedOutline(x,y,(b.right-b.left)*d.width*.21,Math.max(d.short*.00018,(b.bottom-b.top)*d.height*.012),-.25,rand,.08,10),shine,wetness*(.12+rand()*.15));}
    }
  }
  function createSplatter(options={},width=1,height=1){
    const d=dimensions(width,height),stroke=baseStroke(options,'splatter'),origin=unit(options.origin),target=unit(options.target||options.origin);
    const vx=(target.x-origin.x)*d.width,vy=(target.y-origin.y)*d.height,pull=Math.hypot(vx,vy)/d.short;
    const force=clamp(finite(options.force,pull/.35)),spread=clamp(finite(options.spread,.32)),amount=clamp(finite(options.amount,.5));
    const angle=pull>1e-9?Math.atan2(vy,vx):0;
    stroke.points=[{...origin},{...target}];stroke.direction=angle;stroke.spread=spread;
    stroke.bloodParameters={origin:{...origin},target:{...target},force,spread,amount};
    if(!amount||!stroke.opacity)return stroke;
    const emit=emitters(stroke,d,LIMITS.splatterShapes),rand=random(stroke.seed),palette=tones(stroke.color);
    const x=origin.x*d.width,y=origin.y*d.height,dx=Math.cos(angle),dy=Math.sin(angle),nx=-dy,ny=dx;
    const reach=d.short*(.017+Math.pow(force,.92)*.46),cone=(.065+spread*.92)*(.68+force*.32);
    const detail=stroke.effectSubtype?(stroke.effectParameters?.detail??.55):null;
    const mainRadius=d.short*stroke.size*(.17+amount*.08),count=Math.round((20+amount*98+force*28)*(detail===null?1:.65+detail*.65)),primaryCount=1+Math.round(amount*2.7);
    // One irregular impact group anchors the spray. No repeated stroke stamps.
    for(let k=0;k<primaryCount;k++){
      const along=(rand()-.25)*mainRadius*1.5,across=(rand()-.5)*mainRadius*1.25,cx=x+dx*along+nx*across,cy=y+dy*along+ny*across;
      const radius=mainRadius*(k===0?.62+rand()*.22:.16+rand()*.35);
      drop(emit,cx,cy,radius,angle+(rand()-.5)*.55,1.02+rand()*.4+force*.24,rand,palette,.46+rand()*.25,d.short*.0014,true);
    }
    for(let i=0;i<count;i++){
      const group=i%7,travel=group<2?.025+rand()*.22:group<5?.13+Math.pow(rand(),1.3)*.44:.42+Math.pow(rand(),.8)*.58;
      // A sum of uniform deviates concentrates droplets in a loose directional fan.
      const theta=(rand()+rand()+rand()-1.5)*cone*.68;
      const forward=reach*travel*Math.cos(theta),lateral=reach*travel*Math.sin(theta);
      const cx=x+dx*forward+nx*lateral,cy=y+dy*forward+ny*lateral;
      const near=1-travel,r=d.short*stroke.size*(.0035+Math.pow(rand(),3.8)*(.015+near*.024))*(.76+amount*.3);
      const elongation=rand()<.72?(.78+rand()*.68):(1.3+force*(.35+travel*1.8));
      const dropAngle=angle+theta+(rand()-.5)*.55;
      drop(emit,cx,cy,r,dropAngle,elongation,rand,palette,.48+rand()*.4,d.short*.0014);
      // Sparse fine streak fragments vary in length; they are not a tail on every drop.
      if(i%13===4&&force>.2){
        const tx=Math.cos(dropAngle),ty=Math.sin(dropAngle),length=d.short*stroke.size*(.035+force*.18)*(.35+rand()*.65),thin=d.short*stroke.size*(.0018+rand()*.0035);
        emit.polygon(rotatedOutline(cx-tx*length*.28,cy-ty*length*.28,length*.52,thin,dropAngle,rand,.08,12,.48),palette[2],.32+rand()*.25);
      }
      // Small local companions make clusters rather than uniformly scattered dots.
      if(group<4&&rand()>.6){const a=rand()*TAU,distance=r*(1.7+rand()*3),tiny=r*(.22+rand()*.2);emit.ellipse(cx+Math.cos(a)*distance,cy+Math.sin(a)*distance,tiny,tiny*(.8+rand()*.2),palette[2],.4+rand()*.25);}
    }
    appearance(stroke,d);return stroke;
  }
  function regenerateSplatter(stroke,params={},width=1,height=1){if(!stroke||stroke.type!=='blood'||stroke.bloodBehavior!=='splatter')throw new TypeError('Only a version-two splatter can be regenerated.');return createSplatter({...stroke,...stroke.bloodParameters,...params,id:stroke.id},width,height);}

  function createSoakStroke(options={}){
    const stroke=baseStroke(options,'soak');
    stroke.bloodParameters={flow:clamp(finite(options.flow,.65)),edgeSoftness:clamp(finite(options.edgeSoftness,.58)),pressures:[]};
    live.set(stroke,{aspect:null});return stroke;
  }
  function soakGeometry(stroke,d){
    // Rebuild continuous band outlines, not a row of adjacent stamped segments.
    // Persist every final shape. Callers can redraw this single layer unchanged.
    stroke.shapes=[];
    if(!stroke.opacity||!stroke.bloodParameters.flow||!stroke.points.length)return;
    if(['drip','contact'].includes(stroke.effectSubtype)){pathEffect(stroke,d);appearance(stroke,d);return;}
    const flow=stroke.bloodParameters.flow,soft=stroke.bloodParameters.edgeSoftness,palette=tones(stroke.color),emit=emitters(stroke,d);
    const path=stroke.points.map((p,i)=>({x:p.x*d.width,y:p.y*d.height,pressure:stroke.bloodParameters.pressures[i]}));
    const samples=path.map((p,i)=>{
      const before=path[Math.max(0,i-1)],after=path[Math.min(path.length-1,i+1)],angle=Math.atan2(after.y-before.y,after.x-before.x);
      const detail=stroke.effectSubtype?(stroke.effectParameters?.detail??.55):null;
      const wave=detail===null?.92+Math.sin(i*.31+stroke.seed%31)*.055+Math.sin(i*.67-stroke.seed%13)*.025:.92+(Math.sin(i*.31+stroke.seed%31)*.055+Math.sin(i*.67-stroke.seed%13)*.025)*(.4+detail*1.3);
      return {...p,angle,r:p.pressure<=0?0:d.short*stroke.size*.5*(.24+.76*Math.sqrt(p.pressure))*wave};
    });
    const intensity=.18+flow*.66;
    // Many low-alpha nested contours approximate a soft edge without persisted
    // gradients or visibly separated five-step bands. This is screen geometry.
    const layers=Array.from({length:18},(_,i)=>{const t=i/17;return [(1+soft*.3)*(1-t)+.04*t,.023+Math.sin(t*Math.PI)*.017,palette[1]];});
    function band(list,scale){
      if(list.length===1){const p=list[0],rand=random(stroke.seed,5000);return rotatedOutline(p.x,p.y,p.r*scale,p.r*scale*.92,p.angle,rand,.065,24);}
      const outline=list.map(p=>({x:p.x-Math.sin(p.angle)*p.r*scale,y:p.y+Math.cos(p.angle)*p.r*scale}));
      const end=list[list.length-1];
      for(let k=1;k<10;k++){const angle=end.angle+Math.PI*.5-k*Math.PI/10;outline.push({x:end.x+Math.cos(angle)*end.r*scale,y:end.y+Math.sin(angle)*end.r*scale});}
      for(let i=list.length-1;i>=0;i--){const p=list[i];outline.push({x:p.x+Math.sin(p.angle)*p.r*scale,y:p.y-Math.cos(p.angle)*p.r*scale});}
      const start=list[0];
      for(let k=1;k<10;k++){const angle=start.angle-Math.PI*.5-k*Math.PI/10;outline.push({x:start.x+Math.cos(angle)*start.r*scale,y:start.y+Math.sin(angle)*start.r*scale});}
      return outline;
    }
    // At most 96 centre points per band keeps each shape below 256 vertices.
    // Chunk boundaries overlap once, so an exceptionally long path remains joined.
    for(let start=0;start<samples.length;start+=95){const group=samples.slice(start,start+96);for(const [scale,a,c] of layers)emit.polygon(band(group,scale),c,a*intensity);if(start+96>=samples.length)break;}
    for(let i=0;i<samples.length;i++){
      const p=samples[i];if(!p.r)continue;
      const rand=random(stroke.seed,i+10000),dx=Math.cos(p.angle),dy=Math.sin(p.angle),nx=-dy,ny=dx;
      // Overlapping interior clouds stay within the wipe, with no satellite spray.
      if(i%2===0){const along=(rand()-.5)*p.r*.6,across=(rand()-.5)*p.r*.6;emit.polygon(rotatedOutline(p.x+dx*along+nx*across,p.y+dy*along+ny*across,p.r*(.18+rand()*.18),p.r*(.12+rand()*.16),p.angle+(rand()-.5)*.6,rand,.13,14),palette[rand()>.5?0:2],(.025+rand()*.045)*intensity);}
      // Sparse fibres texture the edge without repeating a mechanical comb.
      if(i%5===0){for(const side of [-1,1]){const along=(rand()-.5)*p.r,edge=p.r*(.83+soft*.15),cx=p.x+dx*along+nx*edge*side,cy=p.y+dy*along+ny*edge*side;emit.polygon(rotatedOutline(cx,cy,p.r*(.08+rand()*.16),p.r*.009,p.angle+(rand()-.5)*.7,rand,.025,10),palette[2],.13*intensity);}}
    }
    appearance(stroke,d);
  }
  function pathEffect(stroke,d){
    const emit=emitters(stroke,d),palette=tones(stroke.color),detail=stroke.effectParameters?.detail??.55,flow=stroke.bloodParameters.flow,soft=stroke.bloodParameters.edgeSoftness;
    const path=stroke.points.map((p,i)=>{const before=stroke.points[Math.max(0,i-1)],after=stroke.points[Math.min(stroke.points.length-1,i+1)],a=Math.atan2((after.y-before.y)*d.height,(after.x-before.x)*d.width),pressure=stroke.bloodParameters.pressures[i]??1;return {x:p.x*d.width,y:p.y*d.height,a,r:d.short*stroke.size*(.14+.16*Math.sqrt(pressure))};});
    const ribbon=(list,offset,scale,phase)=>{const edge=(p,i,side)=>{const wave=1+Math.sin(i*.67+phase)*.12+Math.sin(i*.23-phase)*.07,normal=offset+p.r*scale*wave*side;return {x:p.x-Math.sin(p.a)*normal,y:p.y+Math.cos(p.a)*normal};};if(list.length===1){const p=list[0];return rotatedOutline(p.x-Math.sin(p.a)*offset,p.y+Math.cos(p.a)*offset,p.r*scale,p.r*scale*.7,p.a,random(stroke.seed,phase+500),.18,20);}return [...list.map((p,i)=>edge(p,i,1)),...list.map((p,i)=>edge(p,i,-1)).reverse()];};
    // Keep polygons under the 256-vertex validation limit and overlap chunks.
    const groups=[];for(let i=0;i<path.length;i+=95){groups.push(path.slice(i,i+96));if(i+96>=path.length)break;}
    if(stroke.effectSubtype==='drip'){
      for(let k=0;k<7;k++){const t=k/6;for(const group of groups)emit.polygon(ribbon(group,0,.42*(1+soft*.4)*(1-t)+.025*t,stroke.seed%19),palette[k<2?2:1],flow*(.045+t*.1));}
      const end=path.at(-1),rand=random(stroke.seed,189);drop(emit,end.x,end.y,end.r*.3,end.a,1.3,rand,palette,.48*flow,d.short*.001,true);
      for(let j=0;j<Math.round(detail*3);j++){const index=Math.min(path.length-1,Math.floor(rand()*path.length)),p=path[index],offset=p.r*(.5+rand()*.7)*(j%2?1:-1);emit.polygon(rotatedOutline(p.x-Math.sin(p.a)*offset,p.y+Math.cos(p.a)*offset,p.r*(.3+rand()*.8),p.r*.035,p.a,rand,.15,12),palette[2],.1+flow*.15);}
    }else{
      const rand=random(stroke.seed,431),lanes=Math.round(5+detail*8),radius=path[0].r;
      for(let j=0;j<lanes;j++){
        const offset=(j/Math.max(1,lanes-1)-.5)*radius*2.4,scale=.025+rand()*.11;
        // Contact leaves unequal, interrupted parallel streaks instead of dots.
        const paintRun=run=>{if(!run.length)return;const a=flow*(.08+rand()*.18);if(soft>0)for(let k=0;k<3;k++)emit.polygon(ribbon(run,offset,scale*(1+soft*(1-k*.24)),j),palette[j%3],a*soft*.11);emit.polygon(ribbon(run,offset,scale,j),palette[j%3],a);};
        for(const group of groups){let run=[];for(let i=0;i<group.length;i++){if(i>0&&i%9===0&&rand()<.25){paintRun(run);run=[];}else run.push(group[i]);}paintRun(run);}
      }
      for(let i=0;i<path.length;i+=7){const p=path[i];emit.polygon(rotatedOutline(p.x,p.y,p.r*.8,p.r*.65,p.a,rand,.24,18),palette[1],.04*flow);}
    }
  }
  function appendSoakPoint(stroke,point,width,height,pressure=1){
    if(!stroke||stroke.type!=='blood'||stroke.bloodBehavior!=='soak'||stroke.bloodVersion!==2||!Array.isArray(stroke.points)||!Array.isArray(stroke.shapes)||!Array.isArray(stroke.bloodParameters?.pressures))throw new TypeError('A version-two soak stroke is required.');
    const d=dimensions(width,height),aspect=d.width/d.height;
    if(stroke.points.length>=LIMITS.pointsPerStroke)return [];
    const current=live.get(stroke)||{aspect:null};
    if(current.aspect!==null&&Math.abs(current.aspect-aspect)>1e-8)throw new TypeError('Keep the canvas aspect ratio when continuing a soak stroke.');
    current.aspect=aspect;live.set(stroke,current);
    const p=unit(point),last=stroke.points[stroke.points.length-1],distance=last?Math.hypot((p.x-last.x)*d.width,(p.y-last.y)*d.height)/d.short:Infinity;
    // Capture a true gesture path at bounded spacing instead of depending on event rate.
    if(distance<stroke.size*.012)return [];
    stroke.points.push(p);stroke.bloodParameters.pressures.push(clamp(finite(pressure,1)));
    soakGeometry(stroke,d);
    // Shapes are replaced as one continuous layer; this is the changed layer, not a delta.
    return stroke.shapes;
  }
  function regenerateSoak(stroke,params={},width=1,height=1){if(!stroke||stroke.bloodBehavior!=='soak')throw new TypeError('Only a version-two soak can be regenerated.');const d=dimensions(width,height),next=createSoakStroke({...stroke,...stroke.bloodParameters,...params,id:stroke.id});next.points=stroke.points.slice(0,LIMITS.pointsPerStroke).map(unit);next.bloodParameters.pressures=next.points.map((_,i)=>clamp(finite(stroke.bloodParameters.pressures[i],1)));soakGeometry(next,d);live.set(next,{aspect:d.width/d.height});return next;}
  global.RelicBloodEngine=Object.freeze({createSplatter,createSoakStroke,appendSoakPoint,regenerateSplatter,updateSplatter:regenerateSplatter,regenerateSoak,limits:LIMITS});
})(typeof window!=='undefined'?window:globalThis);
