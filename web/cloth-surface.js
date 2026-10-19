(function (global) {
  'use strict';
  // Real image-space UV displacement, not recovered metric height or physics.
  // Keep arithmetic/rounding in step with cloth_surface.py for saved exports.
  const VERSION='cloth-surface-v1', clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
  const LINEAR=Float64Array.from({length:256},(_,v)=>v/255<=.04045?v/255/12.92:((v/255+.055)/1.055)**2.4);
  function blur(values,w,h,radius) {
    const horizontal=new Float64Array(w*h),out=new Float64Array(w*h);
    for(let y=0;y<h;y++){const prefix=new Float64Array(w+1);for(let x=0;x<w;x++)prefix[x+1]=prefix[x]+values[y*w+x];for(let x=0;x<w;x++){const lo=Math.max(0,x-radius),hi=Math.min(w,x+radius+1);horizontal[y*w+x]=(prefix[hi]-prefix[lo])/(hi-lo);}}
    for(let x=0;x<w;x++){const prefix=new Float64Array(h+1);for(let y=0;y<h;y++)prefix[y+1]=prefix[y]+horizontal[y*w+x];for(let y=0;y<h;y++){const lo=Math.max(0,y-radius),hi=Math.min(h,y+radius+1);out[y*w+x]=(prefix[hi]-prefix[lo])/(hi-lo);}}
    return out;
  }
  function sample(a,w,h,x,y){x=clamp(x,0,w-1);y=clamp(y,0,h-1);const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(w-1,x0+1),y1=Math.min(h-1,y0+1),fx=x-x0,fy=y-y0;return (a[y0*w+x0]*(1-fx)+a[y0*w+x1]*fx)*(1-fy)+(a[y1*w+x0]*(1-fx)+a[y1*w+x1]*fx)*fy;}
  function image(value){if(!value||!Number.isInteger(value.width)||!Number.isInteger(value.height)||value.width<1||value.height<1||!value.data||value.data.length!==value.width*value.height*4)throw new Error('Surface input must be RGBA ImageData.');return value;}
  function buildField(source,options={}) {
    image(source);const sw=source.width,sh=source.height;
    if(sw*sh>40000000)throw new Error('Surface source exceeds 40 megapixels.');
    for(const candidate of [options.foreground,options.relativeDepth])if(candidate&&(image(candidate).width!==sw||candidate.height!==sh))throw new Error('Surface mask/depth must match source dimensions.');
    const edge=clamp(Math.trunc(options.maxEdge||256),32,512),scale=Math.min(1,edge/Math.max(sw,sh)),w=Math.max(1,Math.floor(sw*scale+.5)),h=Math.max(1,Math.floor(sh*scale+.5));
    const luma=new Float64Array(w*h),cr=new Float64Array(w*h),cb=new Float64Array(w*h),foreground=new Float64Array(w*h),depth=new Float64Array(w*h);
    for(let y=0;y<h;y++){const sy=Math.min(sh-1,Math.floor((y+.5)*sh/h));for(let x=0;x<w;x++){const sx=Math.min(sw-1,Math.floor((x+.5)*sw/w)),j=(sy*sw+sx)*4,i=y*w+x,r=LINEAR[source.data[j]],g=LINEAR[source.data[j+1]],b=LINEAR[source.data[j+2]],total=r+g+b+.08;luma[i]=Math.log(.04+.2126*r+.7152*g+.0722*b);cr[i]=r/total;cb[i]=b/total;foreground[i]=options.foreground?options.foreground.data[j]/255:1;depth[i]=options.relativeDepth?options.relativeDepth.data[j]/255:0;}}
    const smooth=blur(luma,w,h,Math.max(1,Math.floor(Math.min(w,h)*.006+.5))),base=blur(smooth,w,h,Math.max(3,Math.floor(Math.min(w,h)*.045+.5))),chromaR=blur(cr,w,h,1),chromaB=blur(cb,w,h,1),rd=blur(depth,w,h,Math.max(2,Math.floor(Math.min(w,h)*.025+.5)));
    let sum=0,weighted=0;for(let i=0;i<w*h;i++){sum+=foreground[i];weighted+=rd[i]*foreground[i];}const centre=weighted/(sum||1),dx=new Float64Array(w*h),dy=new Float64Array(w*h),light=new Float64Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=y*w+x,left=y*w+Math.max(0,x-1),right=y*w+Math.min(w-1,x+1),above=Math.max(0,y-1)*w+x,below=Math.min(h-1,y+1)*w+x;
      const colourEdge=Math.abs(chromaR[right]-chromaR[left])+Math.abs(chromaB[right]-chromaB[left])+Math.abs(chromaR[below]-chromaR[above])+Math.abs(chromaB[below]-chromaB[above]),gate=1/(1+18*colourEdge),detail=clamp((smooth[i]-base[i])*.8,-.8,.8),gx=(smooth[right]-smooth[left])*.5,gy=(smooth[below]-smooth[above])*.5,ddx=(rd[right]-rd[left])*.5,ddy=(rd[below]-rd[above])*.5,d=options.relativeDepth?rd[i]-centre:0,attenuation=foreground[i]*Math.min(foreground[left],foreground[right],foreground[above],foreground[below]);
      dx[i]=clamp((.007*detail+.005*Math.tanh(gx*5))*gate+.012*ddx,-.015,.015)*attenuation;
      dy[i]=clamp((.011*detail+.005*Math.tanh(gy*5))*gate+.006*d+.012*ddy,-.015,.015)*attenuation;
      if(Math.abs(dx[i])<1e-12)dx[i]=0;if(Math.abs(dy[i])<1e-12)dy[i]=0;
      light[i]=clamp(Math.exp(detail*gate*.65),.68,1.28);
    }
    return {width:w,height:h,dx,dy,light,foreground,metadata:{version:VERSION,algorithm:'bounded-multiscale-photo-displacement',sourceSize:[sw,sh],fieldSize:[w,h],relativeDepthProvided:!!options.relativeDepth,metricHeight:false,geometryReconstruction:false,physicalSimulation:false,illuminationHeuristic:true,foregroundProvided:!!options.foreground,warning:'光影与印花、反光或投影可能混淆；仅提供可关闭的近似表面贴合，不表示真实褶皱高度。'}};
  }
  function fromPayload(payload) {
    const w=payload?.width,h=payload?.height;if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w>512||h>512)throw new Error('Invalid surface field dimensions.');
    const out={width:w,height:h,metadata:{...(payload.metadata||{})}};
    for(const [key,lo,hi]of [['dx',-.015,.015],['dy',-.015,.015],['light',.5,1.5],['foreground',0,1]]){const values=payload[key];if(!values||values.length!==w*h||Array.from(values).some(v=>!Number.isFinite(v)||v<lo||v>hi))throw new Error('Invalid surface field values.');out[key]=Float64Array.from(values);}
    return out;
  }
  function apply(layer,field,options={}) {
    image(layer);const w=layer.width,h=layer.height,src=layer.data,out=new Uint8ClampedArray(src.length),fw=field.width,fh=field.height,strength=clamp(options.strength===undefined?.65:Number(options.strength),0,1),shade=clamp(options.shade===undefined?.45:Number(options.shade),0,1);
    if(!Number.isFinite(strength)||!Number.isFinite(shade))throw new Error('Surface strength/shade must be finite.');
    let x0=w,y0=h,x1=0,y1=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(src[(y*w+x)*4+3]){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x+1);y1=Math.max(y1,y+1);}
    const margin=Math.ceil(Math.max(w,h)*.015*strength)+2;x0=Math.max(0,x0-margin);y0=Math.max(0,y0-margin);x1=Math.min(w,x1+margin);y1=Math.min(h,y1+margin);
    for(let y=y0;y<y1;y++){
      const fy=(y+.5)*fh/h-.5;
      for(let x=x0;x<x1;x++){
        const fx=(x+.5)*fw/w-.5,sx=x+sample(field.dx,fw,fh,fx,fy)*w*strength,sy=y+sample(field.dy,fw,fh,fx,fy)*h*strength;
        if(sx<0||sy<0||sx>w-1||sy>h-1)continue;
        const ix=Math.floor(sx),iy=Math.floor(sy),ix1=Math.min(w-1,ix+1),iy1=Math.min(h-1,iy+1),tx=sx-ix,ty=sy-iy;
        const j0=(iy*w+ix)*4,j1=(iy*w+ix1)*4,j2=(iy1*w+ix)*4,j3=(iy1*w+ix1)*4,a0=src[j0+3]*(1-tx)*(1-ty),a1=src[j1+3]*tx*(1-ty),a2=src[j2+3]*(1-tx)*ty,a3=src[j3+3]*tx*ty,a=a0+a1+a2+a3;
        if(a<.5)continue;
        const factor=options.maskOnly?1:1+(sample(field.light,fw,fh,fx,fy)-1)*shade,coverage=options.clipForeground===false?1:sample(field.foreground,fw,fh,fx,fy),alpha=Math.floor(a*coverage+.5),j=(y*w+x)*4;
        if(alpha){for(let c=0;c<3;c++)out[j+c]=Math.floor(clamp((src[j0+c]*a0+src[j1+c]*a1+src[j2+c]*a2+src[j3+c]*a3)/a*factor,0,255)+.5);out[j+3]=alpha;}
      }
    }
    return typeof global.ImageData==='function'?new global.ImageData(out,w,h):{data:out,width:w,height:h};
  }
  function draw(canvas,field,options={}){const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw new Error('2D canvas required.');const input=context.getImageData(0,0,canvas.width,canvas.height),output=apply(input,field,options);context.putImageData(output,0,0);return canvas;}
  global.ClothSurface=Object.freeze({version:VERSION,buildField,apply,draw,fromPayload});
  if(typeof module!=='undefined'&&module.exports)module.exports=global.ClothSurface;
})(typeof window!=='undefined'?window:globalThis);
