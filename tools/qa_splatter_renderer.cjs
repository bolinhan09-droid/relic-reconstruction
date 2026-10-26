/* Synthetic folded fabric rendered by the application's real canvas pipeline. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.RELIC_QA_PLAYWRIGHT||'C:/Users/lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||path.join(root,'work/v0116-blood-check'));
const samples=JSON.parse(fs.readFileSync(path.join(out,'coverage-samples.json'),'utf8'));
(async()=>{let browser;try{
  browser=await chromium.launch({executablePath:process.env.RELIC_QA_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:920},deviceScaleFactor:1});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>body{margin:0;background:#f1eee6;color:#282f2e;font:16px "Microsoft YaHei",sans-serif;padding:28px}h1{margin:0 0 8px;font-size:27px}p{margin:0 0 22px;color:#697472}main{display:flex;gap:22px}article{flex:1}h2{font-size:18px;font-weight:500}canvas{width:100%;height:690px;object-fit:contain;background:#dedfd9}</style></head><body><h1>飞溅范围与布面融合</h1><p>合成褶皱测试布 · 同一方向、力度、血量与种子 · 本地画笔实时结果</p><main></main></body></html>');
  for(const file of ['brush-engine.js','blood-engine.js','blood-surface.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,'web',file),'utf8')});
  const result=await page.evaluate(async s=>{
    const source=document.createElement('canvas');source.width=s.width;source.height=s.height;
    const ctx=source.getContext('2d'),data=ctx.createImageData(s.width,s.height);
    for(let y=0;y<s.height;y++)for(let x=0;x<s.width;x++){
      const fold=(x/s.width*5.4+Math.sin(y/s.height*3.3)*.4)*Math.PI*2;
      const luma=186+Math.sin(fold)*31+Math.sin(fold*2+.45)*12+Math.sin(x*2.2)*1.4+Math.sin(y*2.1)*1.1;
      const i=(y*s.width+x)*4;data.data[i]=luma+8;data.data[i+1]=luma+5;data.data[i+2]=luma;data.data[i+3]=255;
    }
    ctx.putImageData(data,0,0);const image=new Image();image.src=source.toDataURL();await image.decode();
    const outputs={source:image.src};
    for(const [key,title] of [['narrow','22% 覆盖 · 局部细溅'],['wide','92% 覆盖 · 大范围飞溅'],['soak','连续浸染 · 保留原有模式']]){
      const canvas=BattleBrushEngine.renderGuide(image,[s[key]],[]),card=document.createElement('article');card.innerHTML='<h2>'+title+'</h2>';card.append(canvas);document.querySelector('main').append(card);outputs[key]=canvas.toDataURL();
    }
    const replay=BattleBrushEngine.renderGuide(image,[JSON.parse(JSON.stringify(s.wide))],[]);
    const first=BattleBrushEngine.renderGuide(image,[s.wide],[]);
    outputs.deterministicReplay=first.toDataURL()===replay.toDataURL();
    const protection=[{x:.2,y:.27,w:.08,h:.07}],protectedCanvas=BattleBrushEngine.renderGuide(image,[s.wide],protection);
    const px=protectedCanvas.getContext('2d').getImageData(0,0,s.width,s.height).data,base=ctx.getImageData(0,0,s.width,s.height).data;
    let difference=0;for(let y=Math.ceil(.27*s.height)+1;y<Math.floor(.34*s.height)-1;y++)for(let x=Math.ceil(.2*s.width)+1;x<Math.floor(.28*s.width)-1;x++){const i=(y*s.width+x)*4;for(let c=0;c<4;c++)difference+=Math.abs(px[i+c]-base[i+c]);}
    outputs.protectedDifference=difference;
    const eraser={id:'qa-erase',type:'erase',size:.1,opacity:1,seed:1,points:[],shapes:[{kind:'ellipse',cx:.23,cy:.31,rx:.05,ry:.05,alpha:1,color:'#ffffff'}]};
    const erased=BattleBrushEngine.renderGuide(image,[s.wide,eraser],[]),center=erased.getContext('2d').getImageData(Math.round(.23*s.width),Math.round(.31*s.height),1,1).data,original=ctx.getImageData(Math.round(.23*s.width),Math.round(.31*s.height),1,1).data;
    outputs.eraserPreserved=Array.from(center).every((v,i)=>v===original[i]);
    return outputs;
  },samples);
  assert(result.deterministicReplay);assert.equal(result.protectedDifference,0);assert(result.eraserPreserved);
  for(const key of ['source','narrow','wide','soak'])fs.writeFileSync(path.join(out,`renderer-${key}.png`),Buffer.from(result[key].split(',')[1],'base64'));
  await page.screenshot({path:path.join(out,'splatter-comparison.png')});
  const report={renderer:'BattleBrushEngine with blood-surface.js',syntheticSource:true,deterministicReplay:result.deterministicReplay,protectedDifference:result.protectedDifference,eraserPreserved:result.eraserPreserved};
  fs.writeFileSync(path.join(out,'renderer-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser?.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
