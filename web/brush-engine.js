(function (global) {
  'use strict';

  // Native guide textures, not AI output. Geometry is persisted so the same
  // normalized shapes can be rendered at preview and source resolutions.
  const TYPES = new Set(['blood', 'slash', 'wear', 'burn', 'erase']);
  const LIMITS = Object.freeze({ pointsPerStroke: 1200, shapesPerStroke: 3500, stampsPerAppend: 48 });
  const runtime = new WeakMap();
  const TAU = Math.PI * 2;
  const EFFECTS = Object.freeze({blood:['splatter','soak','drip','contact'],slash:['slit','frayed','hole'],wear:['scuff','fade','mud_splatter','mud_smear','dust','water_stain'],burn:['char','smoke','scorched_edge']});
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const unitPoint = point => ({ x: clamp(number(point && point.x, 0), 0, 1), y: clamp(number(point && point.y, 0), 0, 1) });
  const hexColor = value => /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : null;
  function colorRamp(value) {
    const base = hexColor(value) || '#641c25';
    const rgb = [1, 3, 5].map(i => parseInt(base.slice(i, i + 2), 16));
    // A screen-color tonal family, not a prediction of mixed pigments.
    return [0.58, 0.78, 1, 1.12].map(scale => '#' + rgb.map(c => Math.round(clamp(c * scale, 0, 255)).toString(16).padStart(2, '0')).join(''));
  }
  function recolorStroke(stroke, color) {
    const chosen = hexColor(color);
    if (!chosen || !stroke || !Array.isArray(stroke.shapes) || stroke.type === 'erase') throw new Error('请选择有效的痕迹图层和十六进制颜色。');
    const previous = hexColor(stroke.color) || { blood: '#641c25', burn: '#463326', wear: '#877e6e', slash: '#211c1c' }[stroke.type] || '#641c25';
    const channels = value => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
    const luminance = value => { const [r, g, b] = channels(value); return r * .2126 + g * .7152 + b * .0722; };
    const base = channels(chosen), before = Math.max(1, luminance(previous));
    // Return a new stroke so callers can retain the original layer in undo history.
    return { ...stroke, color: chosen, points: stroke.points.map(p => ({ ...p })),
      ...(stroke.region ? { region: { points: stroke.region.points.map(p => ({ ...p })) } } : {}),
      shapes: stroke.shapes.map(shape => ({ ...shape,
        ...(shape.points ? { points: shape.points.map(p => ({ ...p })) } : {}),
        color: '#' + base.map(c => Math.round(clamp(c * luminance(shape.color) / before, 0, 255)).toString(16).padStart(2, '0')).join('') })) };
  }

  function randomFor(seed, index) {
    let state = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
    return function () {
      state = (state + 0x6d2b79f5) >>> 0;
      let result = Math.imul(state ^ state >>> 15, 1 | state);
      result ^= result + Math.imul(result ^ result >>> 7, 61 | result);
      return ((result ^ result >>> 14) >>> 0) / 4294967296;
    };
  }

  function newSeed() {
    if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
      return global.crypto.getRandomValues(new Uint32Array(1))[0];
    }
    return (Date.now() ^ Math.floor(Math.random() * 4294967296)) >>> 0;
  }

  function createStroke(options = {}) {
    const type = TYPES.has(options.type) ? options.type : 'blood';
    const seed = options.seed === undefined ? newSeed() : number(options.seed, 0) >>> 0;
    const stroke = {
      id: String(options.id || `brush-${seed.toString(16)}`),
      type,
      size: clamp(number(options.size, 0.055), 0.003, 0.5),
      opacity: clamp(number(options.opacity, 0.8), 0, 1),
      seed,
      points: [],
      shapes: []
    };
    if (hexColor(options.color)) stroke.color = hexColor(options.color);
    if (['free', 'edge', 'area'].includes(options.mode)) stroke.mode = options.mode;
    if (options.spread !== undefined) stroke.spread = clamp(number(options.spread, 0.45), 0, 1);
    if (options.direction !== undefined) stroke.direction = clamp(number(options.direction, 0), -TAU, TAU);
    if (options.region && Array.isArray(options.region.points)) stroke.region = { points: options.region.points.map(unitPoint) };
    if (EFFECTS[type]?.includes(options.effectSubtype)) {
      stroke.effectSubtype=options.effectSubtype;
      stroke.effectParameters=Object.fromEntries(['detail','age','wetness'].map(k=>[k,clamp(number(options.effectParameters?.[k],k==='detail'?.55:0),0,1)]));
    }
    runtime.set(stroke, { last: null, lastStamp: null, carry: 0, index: 0, width: 0, height: 0 });
    return stroke;
  }

  // Sutherland-Hodgman clipping keeps every persisted polygon vertex in 0..1.
  function clippedPolygon(points) {
    let result = points;
    const boundaries = [
      [p => p.x >= 0, (a, b) => ({ x: 0, y: a.y + (b.y - a.y) * (-a.x / (b.x - a.x)) })],
      [p => p.x <= 1, (a, b) => ({ x: 1, y: a.y + (b.y - a.y) * ((1 - a.x) / (b.x - a.x)) })],
      [p => p.y >= 0, (a, b) => ({ x: a.x + (b.x - a.x) * (-a.y / (b.y - a.y)), y: 0 })],
      [p => p.y <= 1, (a, b) => ({ x: a.x + (b.x - a.x) * ((1 - a.y) / (b.y - a.y)), y: 1 })]
    ];
    for (const [inside, intersection] of boundaries) {
      if (!result.length) break;
      const output = [];
      let previous = result[result.length - 1];
      for (const current of result) {
        const currentInside = inside(current), previousInside = inside(previous);
        if (currentInside !== previousInside) output.push(intersection(previous, current));
        if (currentInside) output.push(current);
        previous = current;
      }
      result = output;
    }
    return result.map(unitPoint);
  }

  function emitters(stroke, width, height) {
    const add = shape => {
      if (stroke.shapes.length >= LIMITS.shapesPerStroke || shape.alpha <= 0) return;
      stroke.shapes.push(shape);
    };
    const alpha = value => stroke.type === 'erase' ? 1 : clamp(value * stroke.opacity, 0, 1);
    return {
      ellipse(x, y, rx, ry, color, strength) {
        const cx = x / width, cy = y / height;
        if (cx < 0 || cx > 1 || cy < 0 || cy > 1 || rx <= 0 || ry <= 0) return;
        add({ kind: 'ellipse', cx, cy, rx: clamp(rx / width, 0, 1), ry: clamp(ry / height, 0, 1), color, alpha: alpha(strength) });
      },
      polygon(points, color, strength) {
        const clipped = clippedPolygon(points.map(p => ({ x: p.x / width, y: p.y / height })));
        if (clipped.length < 3) return;
        add({ kind: 'polygon', points: clipped, color, alpha: alpha(strength) });
      }
    };
  }

  function detailStamp(stroke,point,previous,angle,width,height,index) {
    const kind=stroke.effectSubtype;
    if(!kind||stroke.type==='blood'||stroke.type==='erase')return false;
    const rand=randomFor(stroke.seed,index),emit=emitters(stroke,width,height),r=stroke.size*Math.min(width,height)*.5;
    const detail=number(stroke.effectParameters?.detail,.55),x=point.x*width,y=point.y*height;
    if(previous)angle=Math.atan2((point.y-previous.y)*height,(point.x-previous.x)*width);
    const dx=Math.cos(angle),dy=Math.sin(angle),nx=-dy,ny=dx;
    const at=(a,b)=>({x:x+dx*a+nx*b,y:y+dy*a+ny*b});
    const line=(a,b,half,color,strength)=>{const vx=b.x-a.x,vy=b.y-a.y,n=Math.hypot(vx,vy)||1,px=-vy/n*half,py=vx/n*half;emit.polygon([{x:a.x+px,y:a.y+py},{x:b.x+px,y:b.y+py},{x:b.x-px,y:b.y-py},{x:a.x-px,y:a.y-py}],color,strength);};
    const blob=(cx,cy,rx,ry,color,a,n=18,phase=rand()*TAU)=>emit.polygon(Array.from({length:n},(_,i)=>{const t=i/n*TAU,w=1+(.08+detail*.18)*(Math.sin(t*3+phase)*.6+Math.sin(t*7-phase)*.3+(rand()-.5)*.3);return {x:cx+dx*Math.cos(t)*rx*w+nx*Math.sin(t)*ry*w,y:cy+dy*Math.cos(t)*rx*w+ny*Math.sin(t)*ry*w};}),color,a);
    const cloud=(radius,color,strength)=>{for(let k=0;k<12;k++){const t=k/11;blob(x,y,radius*(1.15-t*.85),radius*(1.15-t*.85),color,strength*(.025+Math.sin(t*Math.PI)*.016),22,.8+stroke.seed%17);}};
    if(stroke.type==='slash') {
      if(kind==='slit')return false; // Retain the narrow, tapered original cut.
      if(kind==='hole') {
        blob(x,y,r*(.7+detail*.25),r*.48,'#aa9c87',.48,24);
        blob(x,y,r*.64,r*.4,'#171a1a',.88,24);
        for(let j=0;j<Math.round(10+detail*16);j++){const a=rand()*TAU,p=at(Math.cos(a)*r*.67,Math.sin(a)*r*.44),v=.1+rand()*.25;line(p,{x:p.x+Math.cos(a)*r*v,y:p.y+Math.sin(a)*r*v},r*.009,['#dfd9c9','#bdb5a1','#8c8677'][j%3],.4+rand()*.4);}
      }else if(kind==='frayed') {
        if(!previous){blob(x,y,r*.06,r*.08,'#2b2b26',.5,8);return true;}
        const a=previous?{x:previous.x*width,y:previous.y*height}:at(-r*.7,0),b=previous?{x,y}:at(r*.7,0),w=r*(.13+detail*.13);
        const vx=b.x-a.x,vy=b.y-a.y;line(a,b,w*1.35,'#b3a991',.42);
        emit.polygon([...Array.from({length:5},(_,i)=>{const t=i/4,rough=.7+rand()*.5;return {x:a.x+vx*t+nx*w*rough,y:a.y+vy*t+ny*w*rough};}),...Array.from({length:5},(_,i)=>{const t=1-i/4,rough=.7+rand()*.5;return {x:a.x+vx*t-nx*w*rough,y:a.y+vy*t-ny*w*rough};})],'#1e2020',.85);
        for(let j=0;j<Math.round(4+detail*11);j++){const t=rand(),side=rand()>.5?1:-1,p={x:a.x+(b.x-a.x)*t+nx*w*side,y:a.y+(b.y-a.y)*t+ny*w*side},length=r*(.08+rand()*(.15+detail*.32));line(p,{x:p.x+nx*side*length+dx*length*(rand()-.5),y:p.y+ny*side*length+dy*length*(rand()-.5)},Math.max(.16,r*.006),j%3===0?'#e0dac8':'#ada38f',.4+rand()*.45);}
      }else return false;
      return true;
    }
    if(stroke.type==='wear') {
      if(kind==='scuff') {
        for(let j=0;j<Math.round(8+detail*18);j++){const p=at((rand()-.5)*r*1.5,(rand()-.5)*r*1.6),length=r*(.06+rand()*.45),t=angle+(rand()-.5)*.25;line({x:p.x-Math.cos(t)*length,y:p.y-Math.sin(t)*length},{x:p.x+Math.cos(t)*length,y:p.y+Math.sin(t)*length},r*(.002+rand()*.01),['#d2cdbf','#aca99d','#e6e1d4'][j%3],.14+rand()*.42);}
      }else if(kind==='fade') {
        cloud(r,'#c8c2ac',.9);for(let j=0;j<Math.round(4+detail*13);j++){const p=at((rand()-.5)*r*1.6,(rand()-.5)*r*1.6);emit.ellipse(p.x,p.y,r*.04,r*.014,'#e6dfcd',.06+rand()*.11);}
      }else if(kind==='mud_splatter') {
        for(let j=0;j<Math.round(8+detail*15);j++){const a=rand()*TAU,d=r*Math.sqrt(rand())*1.6,p={x:x+Math.cos(a)*d,y:y+Math.sin(a)*d},s=r*(.025+Math.pow(rand(),3)*.21);blob(p.x,p.y,s,s*(.65+rand()*.45),['#5e4a32','#796144','#9c8058'][j%3],.34+rand()*.48,9);}
      }else if(kind==='mud_smear') {
        blob(x,y,r,r*.7,'#73583a',.18,24);for(let j=0;j<Math.round(8+detail*13);j++){const across=(rand()-.5)*r*1.2,a=at(-r*(.2+rand()*.7),across),b=at(r*(.1+rand()*.6),across);line(a,b,r*(.018+rand()*.055),['#60462f','#856a47','#a28b61'][j%3],.16+rand()*.38);}
      }else if(kind==='dust') {
        cloud(r,'#b8a88a',.55);for(let j=0;j<Math.round(12+detail*24);j++){const a=rand()*TAU,d=r*Math.sqrt(rand()),s=r*(.004+rand()*.016);emit.ellipse(x+Math.cos(a)*d,y+Math.sin(a)*d,s,s*.8,'#d7c6a2',.08+rand()*.25);}
      }else if(kind==='water_stain') {
        // Thin irregular boundary segments form a drying tide-line; the centre
        // remains translucent rather than a dark solid disc.
        const phase=rand()*TAU,edge=Array.from({length:28},(_,i)=>{const a=i/28*TAU,w=1+.1*Math.sin(a*3+phase)+.06*Math.sin(a*7-phase);return at(Math.cos(a)*r*w,Math.sin(a)*r*.72*w);});
        for(let j=0;j<edge.length;j++)line(edge[j],edge[(j+1)%edge.length],r*(.008+rand()*.016),'#716e5b',.08+rand()*.1);
        blob(x,y,r*.84,r*.6,'#626762',.025,26,phase);
        for(let j=0;j<Math.round(4+detail*9);j++){const a=rand()*TAU,p=at(Math.cos(a)*r*.92,Math.sin(a)*r*.66);emit.ellipse(p.x,p.y,r*(.015+rand()*.04),r*.008,'#b2ae98',.07+rand()*.09);}
      }else return false;
      return true;
    }
    if(stroke.type==='burn') {
      if(kind==='char')return false; // Existing connected nested burnt ribbons.
      if(kind==='smoke') {
        cloud(r*(1.3+number(stroke.spread,.55)*.6),'#353633',.48);
        for(let j=0;j<Math.round(3+detail*8);j++){const p=at((rand()-.5)*r*1.7,(rand()-.5)*r*1.5);blob(p.x,p.y,r*(.03+rand()*.14),r*(.03+rand()*.12),'#33332f',.03+rand()*.08,12);}
      }else if(kind==='scorched_edge') {
        const a=previous?{x:previous.x*width,y:previous.y*height}:at(-r*.6,0),b=previous?{x,y}:at(r*.6,0);
        const range=r*(.35+number(stroke.spread,.55)*.9);
        for(let k=0;k<11;k++){const off=range*(.95-k*.085),pa={x:a.x+nx*off,y:a.y+ny*off},pb={x:b.x+nx*off,y:b.y+ny*off};line(pa,pb,range*.085,k<4?'#967148':k<8?'#64462e':'#29261f',.025+k*.008);}
        for(let j=0;j<Math.round(3+detail*9);j++){const p=at((rand()-.5)*r*1.5,(rand()-.5)*r*.12);line(p,{x:p.x+nx*r*(.04+rand()*.2),y:p.y+ny*r*(.04+rand()*.2)},r*.008,'#a6977d',.3);}
      }else return false;
      return true;
    }
    return false;
  }

  function stamp(stroke, point, previous, angle, width, height, index) {
    if(detailStamp(stroke,point,previous,angle,width,height,index))return;
    const rand = randomFor(stroke.seed, index), emit = emitters(stroke, width, height);
    const x = point.x * width, y = point.y * height;
    const radius = stroke.size * Math.min(width, height) * 0.5;
    const dx = Math.cos(angle), dy = Math.sin(angle), nx = -dy, ny = dx;
    const oriented = (along, across) => ({ x: x + dx * along + nx * across, y: y + dy * along + ny * across });
    const choose = colors => colors[Math.floor(rand() * colors.length)];
    const ragged = (cx, cy, rx, ry, count = 9) => Array.from({ length: count }, (_, i) => {
      const theta = i / count * TAU, rough = 0.62 + rand() * 0.38;
      const along = Math.cos(theta) * rx * rough, across = Math.sin(theta) * ry * rough;
      return { x: cx + dx * along + nx * across, y: cy + dy * along + ny * across };
    });

    if (stroke.type === 'blood') {
      const colors = colorRamp(stroke.color);
      // Separate matte droplets with slender oval tails; no broad triangle or fill.
      for (let i = 0; i < 11; i++) {
        const forward = radius * (Math.pow(rand(), 0.7) * 2.25 - 0.18);
        const lateral = (rand() - 0.5) * radius * (0.5 + Math.max(0, forward / radius) * 0.75);
        const p = oriented(forward, lateral), drop = radius * (0.012 + Math.pow(rand(), 3) * 0.071);
        if (i % 4 === 0) {
          const half = drop * (1.7 + rand() * 1.5);
          emit.polygon(Array.from({ length: 10 }, (_, j) => {
            const t = j / 10 * TAU;
            return { x: p.x + dx * Math.cos(t) * half + nx * Math.sin(t) * drop, y: p.y + dy * Math.cos(t) * half + ny * Math.sin(t) * drop };
          }), choose(colors), 0.55 + rand() * 0.3);
        } else emit.ellipse(p.x, p.y, drop, drop * (0.72 + rand() * 0.24), choose(colors), 0.45 + rand() * 0.4);
      }
    } else if (stroke.type === 'slash') {
      // A continuous tapered slit plus separate frayed fabric fibres.
      const start = previous ? { x: previous.x * width, y: previous.y * height } : oriented(-radius * 0.7, 0);
      const end = previous ? { x, y } : oriented(radius * 0.7, 0);
      const vx = end.x - start.x, vy = end.y - start.y, length = Math.hypot(vx, vy) || 1;
      const tx = vx / length, ty = vy / length, px = -ty, py = tx;
      const fine=stroke.effectSubtype==='slit'?number(stroke.effectParameters?.detail,.55):null;
      const half = radius * (0.085 + rand() * 0.065) * (fine===null?1:.65+fine*.65);
      const strip = scale => [
        { x: start.x + px * half * scale * (previous ? 0.8 : 0), y: start.y + py * half * scale * (previous ? 0.8 : 0) },
        { x: start.x + vx * 0.3 + px * half * scale, y: start.y + vy * 0.3 + py * half * scale },
        { x: start.x + vx * 0.75 + px * half * scale * 0.75, y: start.y + vy * 0.75 + py * half * scale * 0.75 },
        { x: end.x + px * half * scale * (previous ? 0.8 : 0), y: end.y + py * half * scale * (previous ? 0.8 : 0) },
        { x: end.x - px * half * scale * (previous ? 0.8 : 0), y: end.y - py * half * scale * (previous ? 0.8 : 0) },
        { x: start.x + vx * 0.72 - px * half * scale, y: start.y + vy * 0.72 - py * half * scale },
        { x: start.x + vx * 0.25 - px * half * scale * 0.65, y: start.y + vy * 0.25 - py * half * scale * 0.65 },
        { x: start.x - px * half * scale * (previous ? 0.8 : 0), y: start.y - py * half * scale * (previous ? 0.8 : 0) }
      ];
      emit.polygon(strip(2), '#aaa18f', 0.52);
      emit.polygon(strip(1), '#211c1c', 0.96);
      const fibreCount = fine===null?1+Math.floor(rand()*3):1+Math.floor(fine*7+rand()*2);
      for (let i = 0; i < fibreCount; i++) {
        const fraction = 0.05 + rand() * 0.9, side = rand() > 0.5 ? 1 : -1;
        const p = { x: start.x + vx * fraction + px * half * side, y: start.y + vy * fraction + py * half * side };
        const fibre = radius * (0.1 + rand() * 0.19), thin = Math.max(0.25, radius * 0.018);
        emit.polygon([
          { x: p.x - tx * thin, y: p.y - ty * thin },
          { x: p.x + px * fibre * side + tx * fibre * 0.3, y: p.y + py * fibre * side + ty * fibre * 0.3 },
          { x: p.x + tx * thin, y: p.y + ty * thin }
        ], choose(['#c4bdad', '#9c9487', '#ddd5c1']), 0.6 + rand() * 0.3);
      }
    } else if (stroke.type === 'wear') {
      const colors = ['#877e6e', '#afa795', '#c3beb0', '#635c51'];
      for (let i = 0; i < 9; i++) {
        const theta = rand() * TAU, distance = radius * Math.sqrt(rand());
        const p = { x: x + Math.cos(theta) * distance, y: y + Math.sin(theta) * distance };
        if (i % 3 === 0) {
          const speck = radius * (0.02 + rand() * 0.055);
          emit.ellipse(p.x, p.y, speck, speck * (0.4 + rand() * 0.6), choose(colors), 0.25 + rand() * 0.4);
        } else {
          const tilt = angle + (rand() - 0.5) * 0.9, fx = Math.cos(tilt), fy = Math.sin(tilt);
          const halfLength = radius * (0.06 + rand() * 0.18), halfWidth = Math.max(0.2, radius * (0.008 + rand() * 0.014));
          emit.polygon([
            { x: p.x - fx * halfLength, y: p.y - fy * halfLength },
            { x: p.x - fy * halfWidth, y: p.y + fx * halfWidth },
            { x: p.x + fx * halfLength, y: p.y + fy * halfLength },
            { x: p.x + fy * halfWidth, y: p.y - fx * halfWidth }
          ], choose(colors), 0.35 + rand() * 0.45);
        }
      }
    } else if (stroke.type === 'burn') {
      const spread = number(stroke.spread, 0.45), edge = stroke.mode === 'edge';
      const sx = previous ? previous.x * width : x, sy = previous ? previous.y * height : y;
      const wave = 0.86 + Math.sin(index * 0.29 + stroke.seed % 19) * 0.1;
      const band = radius * (0.5 + spread * 0.9) * wave;
      // Connected ribbons and low-alpha nested halos avoid isolated polygon stamps.
      const layers = [[1.25, '#8a704e', .035], [1.05, '#806440', .055], [.85, '#705333', .065], [.63, '#604329', .09], [.43, '#463326', .12], [.22, '#211e1a', .3]];
      for (const [scale, color, alpha] of layers) {
        const half = band * scale, shift = edge ? band * 0.42 : 0;
        const ax = sx + nx * shift, ay = sy + ny * shift, bx = x + nx * shift, by = y + ny * shift;
        if (previous) emit.polygon([{ x: ax + nx * half, y: ay + ny * half }, { x: bx + nx * half, y: by + ny * half }, { x: bx - nx * half, y: by - ny * half }, { x: ax - nx * half, y: ay - ny * half }], color, alpha);
        // Once the path is moving, the connected ribbon supplies the core.
        // Repeated opaque round caps would create a beaded/stamped appearance.
        if (!previous) emit.ellipse(bx, by, half, half, color, alpha);
        else if (scale >= 1.05) emit.ellipse(bx, by, half, half, color, alpha * .32);
      }
      const charDetail=stroke.effectSubtype==='char'?number(stroke.effectParameters?.detail,.55):null;
      for (let i = 0; i < (charDetail===null?3:Math.round(2+charDetail*11)); i++) {
        const p = oriented((rand() - .5) * radius * .35, (rand() - .5) * band * .65);
        const fibre = radius * (.03 + rand() * .09), thin = Math.max(.18, radius * .006);
        emit.polygon([{ x: p.x - dx * fibre, y: p.y - dy * fibre }, { x: p.x + nx * thin, y: p.y + ny * thin }, { x: p.x + dx * fibre, y: p.y + dy * fibre }, { x: p.x - nx * thin, y: p.y - ny * thin }], choose(['#211e1a', '#443b2d', '#8e8069']), .17 + rand() * .3);
      }
    } else if (stroke.type === 'erase') {
      // Full removal only. A swept polygon avoids gaps even on a fast gesture.
      if (previous) {
        const sx = previous.x * width, sy = previous.y * height;
        emit.polygon([
          { x: sx + nx * radius, y: sy + ny * radius },
          { x: x + nx * radius, y: y + ny * radius },
          { x: x - nx * radius, y: y - ny * radius },
          { x: sx - nx * radius, y: sy - ny * radius }
        ], '#000000', 1);
      }
      emit.ellipse(x, y, radius, radius, '#000000', 1);
    }
  }

  function strokeRuntime(stroke, width, height) {
    let current = runtime.get(stroke);
    if (!current) {
      const shadow = createStroke(stroke);
      for (const point of stroke.points || []) appendPoint(shadow, point, width, height);
      current = runtime.get(shadow);
      runtime.set(stroke, current);
    }
    if (current.width && (current.width !== width || current.height !== height)) {
      // Carry is stored in pixels; keep the same relative sampling distance.
      current.carry *= Math.min(width, height) / Math.min(current.width, current.height);
    }
    current.width = width;
    current.height = height;
    return current;
  }

  function appendPoint(stroke, point, width, height) {
    if (!stroke || !TYPES.has(stroke.type) || !Array.isArray(stroke.points) || !Array.isArray(stroke.shapes)) throw new TypeError('Invalid brush stroke.');
    width = Math.max(1, number(width, 1));
    height = Math.max(1, number(height, 1));
    if (stroke.points.length >= LIMITS.pointsPerStroke || stroke.shapes.length >= LIMITS.shapesPerStroke) return [];
    const p = unitPoint(point), current = strokeRuntime(stroke, width, height), before = stroke.shapes.length;
    if (current.last && Math.hypot((p.x - current.last.x) * width, (p.y - current.last.y) * height) < 0.05) return [];
    stroke.points.push(p);
    if (!current.last) {
      const angle = stroke.direction === undefined ? randomFor(stroke.seed, 0)() * TAU : stroke.direction;
      stamp(stroke, p, null, angle, width, height, current.index++);
      current.last = p;
      current.lastStamp = p;
      return stroke.shapes.slice(before);
    }
    const dx = (p.x - current.last.x) * width, dy = (p.y - current.last.y) * height;
    const distance = Math.hypot(dx, dy), angle = stroke.direction === undefined ? Math.atan2(dy, dx) : stroke.direction;
    const spacing = Math.max(0.4, stroke.size * Math.min(width, height) * (stroke.type === 'blood' ? 0.28 : stroke.type === 'wear' ? 0.22 : 0.18));
    let offset = spacing - current.carry, count = 0;
    // Long jumps are sampled at a bounded number of positions per pointer event.
    const jumpStep = Math.max(spacing, distance / LIMITS.stampsPerAppend);
    while (offset <= distance + 1e-7 && count < LIMITS.stampsPerAppend && stroke.shapes.length < LIMITS.shapesPerStroke) {
      const fraction = offset / distance;
      const sample = { x: current.last.x + (p.x - current.last.x) * fraction, y: current.last.y + (p.y - current.last.y) * fraction };
      stamp(stroke, sample, current.lastStamp, angle, width, height, current.index++);
      current.lastStamp = sample;
      offset += jumpStep;
      count++;
    }
    current.carry = count ? Math.max(0, distance - (offset - jumpStep)) % spacing : (current.carry + distance) % spacing;
    if (jumpStep > spacing && (stroke.type === 'erase' || stroke.type === 'slash')) {
      stamp(stroke, p, current.lastStamp, angle, width, height, current.index++);
      current.lastStamp = p;
      current.carry = 0;
    }
    current.last = p;
    return stroke.shapes.slice(before);
  }

  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  function polygonArea(points) {
    return points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y; }, 0) / 2;
  }
  function inTriangle(p, a, b, c) { return cross(a, b, p) >= -1e-10 && cross(b, c, p) >= -1e-10 && cross(c, a, p) >= -1e-10; }
  function trianglesFor(points) {
    const vertices = polygonArea(points) < 0 ? points.slice().reverse() : points.slice(), triangles = [];
    let guard = vertices.length * vertices.length;
    while (vertices.length > 3 && guard-- > 0) {
      let removed = false;
      for (let i = 0; i < vertices.length; i++) {
        const a = vertices[(i + vertices.length - 1) % vertices.length], b = vertices[i], c = vertices[(i + 1) % vertices.length];
        if (cross(a, b, c) <= 1e-12 || vertices.some(p => p !== a && p !== b && p !== c && inTriangle(p, a, b, c))) continue;
        triangles.push([a, b, c]); vertices.splice(i, 1); removed = true; break;
      }
      if (!removed) throw new Error('圈选范围需为不自交的简单多边形，请重新圈选。');
    }
    if (vertices.length === 3 && Math.abs(polygonArea(vertices)) > 1e-12) triangles.push(vertices);
    return triangles;
  }
  function clipToTriangle(points, triangle) {
    let result = points;
    for (let i = 0; i < 3; i++) {
      const a = triangle[i], b = triangle[(i + 1) % 3], next = [];
      if (!result.length) break;
      let prev = result[result.length - 1], prevSide = cross(a, b, prev);
      for (const p of result) {
        const side = cross(a, b, p);
        if ((side >= 0) !== (prevSide >= 0)) {
          const t = prevSide / (prevSide - side);
          next.push(unitPoint({ x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t }));
        }
        if (side >= 0) next.push(p);
        prev = p; prevSide = side;
      }
      result = next;
    }
    return result;
  }
  function createAreaStroke(options = {}, width = 1, height = 1) {
    width = Math.max(1, number(width, 1)); height = Math.max(1, number(height, 1));
    if (!['blood', 'wear', 'burn'].includes(options.type)) throw new Error('圈区支持血迹、磨损和熏色。');
    if (!Array.isArray(options.points) || options.points.length < 3 || options.points.length > 256) throw new Error('请圈出至少三个点、最多256点的范围。');
    const points = options.points.map(unitPoint).filter((p, i, list) => !i || Math.hypot(p.x - list[i - 1].x, p.y - list[i - 1].y) > 1e-7);
    if (points.length > 3 && Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y) < 1e-7) points.pop();
    if (points.length < 3 || Math.abs(polygonArea(points)) < 1e-7) throw new Error('圈选范围太小，请重新圈选。');
    const triangles = trianglesFor(points), stroke = createStroke({ ...options, mode: 'area', region: { points } });
    stroke.points = points.map(p => ({ ...p }));
    if(stroke.type==='wear'&&stroke.effectSubtype==='water_stain'){
      const rand=randomFor(stroke.seed,991),emit=emitters(stroke,width,height),center={x:points.reduce((n,p)=>n+p.x,0)/points.length,y:points.reduce((n,p)=>n+p.y,0)/points.length};
      emit.polygon(points.map(p=>({x:p.x*width,y:p.y*height})),'#73776e',.028);
      const detail=number(stroke.effectParameters?.detail,.55);
      for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length],shade=.035+rand()*.08*(.3+detail*.7),scale=.992-(.005+detail*.018)*(.5+rand()*.5);emit.polygon([{x:a.x*width,y:a.y*height},{x:b.x*width,y:b.y*height},{x:(center.x+(b.x-center.x)*scale)*width,y:(center.y+(b.y-center.y)*scale)*height},{x:(center.x+(a.x-center.x)*scale)*width,y:(center.y+(a.y-center.y)*scale)*height}],'#776d56',shade);}
      return stroke;
    }
    const rand = randomFor(stroke.seed, 100000), minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
    const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
    const radius = stroke.size * Math.min(width, height) * .5;
    const count = Math.round(clamp(Math.abs(polygonArea(points)) * width * height / Math.max(1, radius * radius * 7), 12, 96));
    const angle = options.direction === undefined ? -.35 : stroke.direction;
    for (let i = 0, attempts = 0; i < count && attempts < count * 25 && stroke.shapes.length < LIMITS.shapesPerStroke; attempts++) {
      const p = { x: minX + rand() * (maxX - minX), y: minY + rand() * (maxY - minY) };
      if (!triangles.some(t => inTriangle(p, ...t))) continue;
      const sample = createStroke({ ...stroke, mode: 'free' });
      stamp(sample, p, null, angle, width, height, i++);
      for (const shape of sample.shapes) {
        const outline = shape.kind === 'polygon' ? shape.points : Array.from({ length: 16 }, (_, j) => ({ x: shape.cx + Math.cos(j / 16 * TAU) * shape.rx, y: shape.cy + Math.sin(j / 16 * TAU) * shape.ry }));
        for (const triangle of triangles) {
          const clipped = clipToTriangle(outline, triangle);
          if (clipped.length >= 3 && Math.abs(polygonArea(clipped)) > 1e-12 && stroke.shapes.length < LIMITS.shapesPerStroke) stroke.shapes.push({ kind: 'polygon', points: clipped, color: shape.color, alpha: shape.alpha });
        }
      }
    }
    return stroke;
  }

  function paintShape(context, shape, width, height, mask) {
    if (!shape || number(shape.alpha, 0) <= 0) return;
    context.globalAlpha = mask ? 1 : clamp(number(shape.alpha, 1), 0, 1);
    context.fillStyle = mask ? '#ffffff' : (/^#[0-9a-f]{6}$/i.test(shape.color) ? shape.color : '#641c25');
    context.beginPath();
    if (shape.kind === 'ellipse') {
      context.ellipse(shape.cx * width, shape.cy * height, shape.rx * width, shape.ry * height, 0, 0, TAU);
    } else if (shape.kind === 'polygon' && Array.isArray(shape.points) && shape.points.length >= 3) {
      context.moveTo(shape.points[0].x * width, shape.points[0].y * height);
      for (let i = 1; i < shape.points.length; i++) context.lineTo(shape.points[i].x * width, shape.points[i].y * height);
      context.closePath();
    } else return;
    context.fill();
  }

  function subtractProtected(context, rects, width, height, mask) {
    context.globalAlpha = 1;
    context.globalCompositeOperation = mask ? 'source-over' : 'destination-out';
    context.fillStyle = '#000000';
    for (const item of rects || []) {
      const rect = item && (item.rect || item);
      if (!rect) continue;
      const x = clamp(number(rect.x, 0), 0, 1), y = clamp(number(rect.y, 0), 0, 1);
      const w = clamp(number(rect.w, 0), 0, 1 - x), h = clamp(number(rect.h, 0), 0, 1 - y);
      if (w && h) context.fillRect(x * width, y * height, w * width, h * height);
    }
  }

  function paint(canvas, strokes, protectedRects, draftStroke, mask) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('A 2D canvas is required.');
    const width = canvas.width, height = canvas.height;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.clearRect(0, 0, width, height);
    if (mask) { context.fillStyle = '#000000'; context.fillRect(0, 0, width, height); }
    const list = Array.isArray(strokes) ? strokes.slice() : [];
    if (draftStroke && !list.some(stroke => stroke === draftStroke || stroke.id === draftStroke.id)) list.push(draftStroke);
    for (const stroke of list) {
      if (!stroke || !Array.isArray(stroke.shapes)) continue;
      context.globalCompositeOperation = stroke.type === 'erase' && !mask ? 'destination-out' : 'source-over';
      for (const shape of stroke.shapes) {
        if (stroke.type === 'erase') {
          // Both guide and mask remove the whole covered area, never half erase.
          if (number(shape && shape.alpha, 0) > 0) paintShape(context, { ...shape, color: '#000000', alpha: 1 }, width, height, false);
        } else paintShape(context, shape, width, height, mask);
      }
    }
    subtractProtected(context, protectedRects, width, height, mask);
    context.restore();
    return canvas;
  }

  function newCanvas(width, height) {
    const canvas = global.document && global.document.createElement ? global.document.createElement('canvas') : new global.OffscreenCanvas(width, height);
    canvas.width = Math.max(1, Math.round(number(width, 1)));
    canvas.height = Math.max(1, Math.round(number(height, 1)));
    return canvas;
  }

  function draw(canvas, strokes, options = {}) {
    return paint(canvas, strokes, options.protectedRects || [], options.draftStroke || null, false);
  }

  function renderGuide(image, strokes, protectedRects = []) {
    const width = image.naturalWidth || image.videoWidth || image.width;
    const height = image.naturalHeight || image.videoHeight || image.height;
    if (!(width > 0 && height > 0)) throw new Error('The source image must finish loading before rendering.');
    const canvas = newCanvas(width, height), overlay = newCanvas(width, height), context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, width, height);
    draw(overlay, strokes, { protectedRects });
    context.drawImage(overlay, 0, 0);
    return canvas;
  }

  function maskCanvas(width, height, strokes, protectedRects = []) {
    return paint(newCanvas(width, height), strokes, protectedRects, null, true);
  }

  global.BattleBrushEngine = Object.freeze({ createStroke, createAreaStroke, recolorStroke, appendPoint, draw, renderGuide, maskCanvas, limits: LIMITS, effects:EFFECTS });
})(typeof window !== 'undefined' ? window : globalThis);
