/* Warp the original pigment layer once, then reapply screen-space protection. */
(function(global){
  'use strict';
  const previous=global.BattleBrushEngine;
  if(!previous)return;
  function active(image){
    const workspace=global.RelicSurfaceWorkspace,options=workspace?.getOptions?.(),surface=workspace?.getActiveSurface?.();
    if(!options?.enabled||!surface?.field||!image)return null;
    try{const a=new URL(image.currentSrc||image.src,location.origin),b=new URL(surface.sourceUrl,location.origin);if(a.origin!==b.origin||a.pathname!==b.pathname)return null;}catch{return null;}
    return {field:surface.field,strength:options.strength,foregroundImage:surface.foregroundImage};
  }
  function protect(canvas,rects){const context=canvas.getContext('2d');context.save();context.setTransform(1,0,0,1,0,0);context.globalCompositeOperation='destination-out';context.globalAlpha=1;context.fillStyle='#000';for(const item of rects||[]){const r=item.rect||item;context.fillRect(r.x*canvas.width,r.y*canvas.height,r.w*canvas.width,r.h*canvas.height);}context.restore();}
  function warp(canvas,options,image,maskOnly=false){const surface=active(image);if(surface&&global.ClothSurface){global.ClothSurface.draw(canvas,surface.field,{strength:surface.strength,shade:.35,maskOnly,clipForeground:!surface.foregroundImage});if(surface.foregroundImage){const context=canvas.getContext('2d');context.save();context.setTransform(1,0,0,1,0,0);context.globalCompositeOperation='destination-in';context.globalAlpha=1;context.drawImage(surface.foregroundImage,0,0,canvas.width,canvas.height);context.restore();}protect(canvas,options.protectedRects);}return canvas;}
  function draw(canvas,strokes,options={}){canvas.getContext('2d',{willReadFrequently:true});previous.draw(canvas,strokes,options);return warp(canvas,options,options.image||document.getElementById('garmentImage'));}
  function maskCanvas(width,height,strokes,protectedRects=[]){const canvas=previous.maskCanvas(width,height,strokes,protectedRects),image=document.getElementById('garmentImage');if(!active(image))return canvas;const context=canvas.getContext('2d',{willReadFrequently:true}),input=context.getImageData(0,0,width,height);for(let i=0;i<input.data.length;i+=4){input.data[i+3]=input.data[i];input.data[i]=input.data[i+1]=input.data[i+2]=255;}context.putImageData(input,0,0);warp(canvas,{protectedRects},image,true);const output=context.getImageData(0,0,width,height);for(let i=0;i<output.data.length;i+=4){const v=output.data[i+3]?255:0;output.data[i]=output.data[i+1]=output.data[i+2]=v;output.data[i+3]=255;}context.putImageData(output,0,0);return canvas;}
  function renderGuide(image,strokes,protectedRects=[]){const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height,out=document.createElement('canvas'),layer=document.createElement('canvas');out.width=layer.width=width;out.height=layer.height=height;out.getContext('2d').drawImage(image,0,0);draw(layer,strokes,{protectedRects,image});out.getContext('2d').drawImage(layer,0,0);return out;}
  global.BattleBrushEngine=Object.freeze({...previous,draw,maskCanvas,renderGuide});
  global.addEventListener('relic:surface-changed',()=>{if(typeof scheduleBrushRender==='function')scheduleBrushRender();});
})(window);
