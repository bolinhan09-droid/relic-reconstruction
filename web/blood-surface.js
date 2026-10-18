/* V2 pigment follows the reference photograph's light and fine surface detail. */
(function(global){
  'use strict';
  const previous=global.BattleBrushEngine;
  const sourceCache=new WeakMap(),strokeCache=new WeakMap();
  function canvas(w,h){const c=document.createElement('canvas');c.width=w;c.height=h;return c;}
  function sourcePixels(image,w,h){
    let cached=sourceCache.get(image);
    const key=(image.currentSrc||image.src||'')+'|'+w+'|'+h;
    if(!cached||cached.key!==key){
      const c=canvas(w,h),ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0,w,h);
      cached={key,pixels:ctx.getImageData(0,0,w,h).data};sourceCache.set(image,cached);
    }
    return cached;
  }
  function bounds(stroke,w,h){
    let left=w,top=h,right=0,bottom=0;
    for(const s of stroke.shapes||[]){
      if(!(s.alpha>0))continue;
      const points=s.kind==='ellipse'?[{x:s.cx-s.rx,y:s.cy-s.ry},{x:s.cx+s.rx,y:s.cy+s.ry}]:s.points||[];
      for(const p of points){left=Math.min(left,p.x*w);right=Math.max(right,p.x*w);top=Math.min(top,p.y*h);bottom=Math.max(bottom,p.y*h);}
    }
    left=Math.max(0,Math.floor(left)-2);top=Math.max(0,Math.floor(top)-2);
    right=Math.min(w,Math.ceil(right)+2);bottom=Math.min(h,Math.ceil(bottom)+2);
    return [left,top,Math.max(0,right-left),Math.max(0,bottom-top)];
  }
  function pigmentLayer(stroke,w,h,source){
    const isSurface=stroke.type==='blood'&&stroke.bloodVersion===2;
    let cached=strokeCache.get(stroke);
    const key=w+'|'+h+'|'+(isSurface?source.key:'legacy')+'|'+stroke.shapes.length;
    if(cached?.key===key)return cached;
    const layer=canvas(w,h);
    previous.draw(layer,[stroke]);
    const [x,y,bw,bh]=bounds(stroke,w,h);
    if(isSurface){
      if(bw&&bh){
        const ctx=layer.getContext('2d',{willReadFrequently:true}),data=ctx.getImageData(x,y,bw,bh),p=data.data;
        for(let yy=0;yy<bh;yy++)for(let xx=0;xx<bw;xx++){
          const i=(yy*bw+xx)*4;if(!p[i+3])continue;
          const b=((y+yy)*w+x+xx)*4,base=source.pixels;
          const luma=Math.floor((77*base[b]+150*base[b+1]+29*base[b+2]+128)/256);
          const factor=7140+72*luma;
          for(let channel=0;channel<3;channel++)p[i+channel]=Math.floor((p[i+channel]*factor+12750)/25500);
        }
        ctx.putImageData(data,x,y);
      }
    }
    const cropped=canvas(Math.max(1,bw),Math.max(1,bh));
    if(bw&&bh)cropped.getContext('2d').drawImage(layer,x,y,bw,bh,0,0,bw,bh);
    layer.width=layer.height=1;
    const result={key,layer:cropped,x,y};
    // A draft is appended in place while drawing; do not retain a stale cache.
    if(!stroke._bloodDraft)strokeCache.set(stroke,result);
    return result;
  }
  function drawWithSource(destination,strokes,options,image){
    const list=Array.isArray(strokes)?strokes.slice():[];
    if(options.draftStroke&&!list.some(s=>s.id===options.draftStroke.id))list.push(options.draftStroke);
    if(!list.some(s=>s.bloodVersion===2&&s.type==='blood')||!image?.complete||!image.naturalWidth)return previous.draw(destination,strokes,options);
    const w=destination.width,h=destination.height,ctx=destination.getContext('2d'),source=sourcePixels(image,w,h);
    ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';ctx.clearRect(0,0,w,h);
    for(const stroke of list){
      if(stroke.type==='erase'){
        const eraser={...stroke,type:'blood',shapes:stroke.shapes.map(s=>({...s,alpha:s.alpha>0?1:0,color:'#ffffff'}))};
        const layer=pigmentLayer(eraser,w,h,source);ctx.globalCompositeOperation='destination-out';ctx.drawImage(layer.layer,layer.x,layer.y);ctx.globalCompositeOperation='source-over';
      }else {const layer=pigmentLayer(stroke,w,h,source);ctx.drawImage(layer.layer,layer.x,layer.y);}
    }
    ctx.globalCompositeOperation='destination-out';ctx.fillStyle='#000000';
    for(const item of options.protectedRects||[]){const r=item.rect||item;ctx.fillRect(r.x*w,r.y*h,r.w*w,r.h*h);}
    ctx.restore();return destination;
  }
  function draw(destination,strokes,options={}){
    const image=options.image||document.getElementById('garmentImage');
    return drawWithSource(destination,strokes,options,image);
  }
  function renderGuide(image,strokes,protectedRects=[]){
    const w=image.naturalWidth||image.width,h=image.naturalHeight||image.height;
    const out=canvas(w,h),overlay=canvas(w,h);out.getContext('2d').drawImage(image,0,0,w,h);
    drawWithSource(overlay,strokes,{protectedRects},image);out.getContext('2d').drawImage(overlay,0,0);return out;
  }
  global.BattleBrushEngine=Object.freeze({...previous,draw,renderGuide});
})(window);
