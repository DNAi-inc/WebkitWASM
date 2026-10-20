// Real-engine compatibility probe. A homepage load is not a playback result.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const origin=process.env.BIB_ORIGIN||'http://127.0.0.1:14830';
const target=process.argv[2]||'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const output=process.env.BIB_RESULTS||'build/compatibility/site-probe';
const playSeconds=Math.max(1,Number(process.env.BIB_PLAY_SECONDS)||10);
const seconds=Math.min(180,Math.max(10,Number(process.env.BIB_SECONDS)||60));
await mkdir(output,{recursive:true});
const report={target,date:new Date().toISOString(),media:process.env.BIB_MEDIA!=='0',mse:process.env.BIB_MSE!=='0',samples:[],errors:[]};
const logs=[];const browser=await chromium.launch({channel:'chromium',args:['--mute-audio']});let page;
try {
  page=await browser.newPage({viewport:{width:1280,height:900}});
  page.on('console',m=>logs.push(m.text()));page.on('pageerror',e=>report.errors.push(e.stack));
  const url=new URL('/browser.html',origin);
  for(const [key,value] of Object.entries({desktop:'1',persist:'0',gpu:'0',media:report.media?'1':'0',mse:report.mse?'1':'0',url:target}))url.searchParams.set(key,value);
  await page.goto(url.href);await page.waitForFunction(()=>window.__bib?.ready||window.__bib?.dead,null,{timeout:180000});
  report.linkOptimization=await page.evaluate(()=>window.BIB_LINK_OPT);
  report.gcRootMode=await page.evaluate(()=>window.BIB_GC_ROOT_MODE);
  const until=Date.now()+seconds*1000;let sequence=0;
  while(Date.now()<until){
    if(await page.evaluate(()=>!!window.__bib?.dead))break;
    const marker=`SITEPROBE${++sequence}:`;
    await page.evaluate(marker=>Module.ccall('bib_eval','number',['string'],[`(()=>{const v=document.querySelector('video');if(v){v.muted=true;if(v.paused)v.play().catch(()=>{})}const button=document.querySelector('.ytp-large-play-button'),r=button?.getBoundingClientRect();console.log(${JSON.stringify(marker)}+JSON.stringify({url:location.href,title:document.title.slice(0,80),text:document.body?.innerText.slice(0,40),viewTransitions:typeof document.startViewTransition,button:r&&r.width>0&&r.height>0?{x:r.x+r.width/2,y:r.y+r.height/2}:null,video:v?{time:v.currentTime,paused:v.paused,ready:v.readyState,width:v.videoWidth,height:v.videoHeight,source:v.currentSrc.startsWith('blob:')?'blob:':v.currentSrc.slice(0,32),error:v.error?.code}:null}))})()`]),marker);
    const start=Date.now();const queryBudget=Math.min(60000,Math.max(1000,until-Date.now()));let line;
    while(!(line=logs.find(l=>l.includes(marker)))&&Date.now()-start<queryBudget){if(await page.evaluate(()=>!!window.__bib?.dead))break;await page.waitForTimeout(100)}
    if(!line){report.probeTimedOut=true;break}
    const body=line.slice(line.indexOf(marker)+marker.length),end=body.lastIndexOf(' (');
    const state=JSON.parse(end<0?body:body.slice(0,end));report.samples.push(state);console.log(JSON.stringify(state));
    if(state.video?.time>1&&state.video.width>0&&!state.video.paused)report.playbackStarted=true;
    if(state.video?.time>playSeconds&&state.video.width>0&&!state.video.paused){report.playbackObserved=true;break}
    if(state.button&&sequence%3===1){const canvas=await page.locator('#screen').boundingBox();await page.mouse.click(canvas.x+state.button.x,canvas.y+state.button.y)}
    await page.waitForTimeout(4000);
  }
  report.engineAlive=await page.evaluate(()=>!!window.__bib?.ready&&!window.__bib?.dead);
  report.hostMedia=await page.evaluate(()=>({stats:window.__bibMediaBridge?.stats,players:[...(window.__bibMedia?.values()||[])].map(p=>({time:p.el?.currentTime,ready:p.el?.readyState,width:p.el?.videoWidth}))}));
} catch(error){report.failure=error.stack}
finally {
  if(page&&report.engineAlive===undefined)report.engineAlive=await page.evaluate(()=>!!window.__bib?.ready&&!window.__bib?.dead).catch(()=>false);
  if(page)await page.screenshot({path:`${output}/site.png`,timeout:5000}).catch(()=>{});
  await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));await writeFile(`${output}/console.log`,logs.join('\n'));
  await browser.close();console.log(JSON.stringify({engineAlive:report.engineAlive,playbackObserved:!!report.playbackObserved,failure:report.failure,errors:report.errors.length,output}));
}
