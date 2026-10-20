import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const origin=process.env.BIB_ORIGIN||'http://127.0.0.1:14834';
const output=process.env.BIB_RESULTS||'build/acceptance/youtube-controls';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chromium',args:['--mute-audio']});
const logs=[],errors=[],report={date:new Date().toISOString(),results:[],errors};let page;
try{
 page=await browser.newPage({viewport:{width:1280,height:900}});
 page.on('console',m=>logs.push(m.text()));page.on('pageerror',e=>errors.push(e.stack));
 await page.goto(`${origin}/browser.html?desktop=1&persist=0&gpu=0&url=${encodeURIComponent('https://www.youtube.com/watch?v=aqz-KE-bpKQ')}`);
 await page.waitForFunction(()=>window.__bib?.ready&&!__bib.dead,null,{timeout:180000});
 assert.equal(await page.evaluate(()=>window.BIB_GC_ROOT_MODE),'jsc-numeric-v2');
 let sequence=0;
 const guest=async expression=>{
  const marker=`YTCONTROL${++sequence}:`;
  await page.evaluate(({marker,expression})=>Module.ccall('bib_eval','number',['string'],[`console.log(${JSON.stringify(marker)}+JSON.stringify((${expression})))`]),{marker,expression});
  const start=Date.now();while(Date.now()-start<30000){const line=logs.find(line=>line.includes(marker));if(line){let text=line.slice(line.indexOf(marker)+marker.length);const end=text.lastIndexOf(' (');return JSON.parse(end>=0?text.slice(0,end):text)}await page.waitForTimeout(100)}throw new Error(`Guest timed out: ${expression}`);
 };
 const until=async expression=>{const start=Date.now();while(Date.now()-start<90000){if(await guest(expression))return;await page.waitForTimeout(300)}throw new Error(`Condition timed out: ${expression}`)};
 const record=(name,detail={})=>{report.results.push({name,detail});console.log(`PASS ${name}: ${JSON.stringify(detail)}`)};
 await until('location.hostname==="www.youtube.com" && !!document.querySelector("video")');
 await guest('(()=>{const v=document.querySelector("video");v.muted=true;v.play().catch(()=>{});return true})()');
 await until('document.querySelector("video").currentTime>3 && document.querySelector("video").readyState>=2');
 const canvas=page.locator('#screen'),box=await canvas.boundingBox();
 await page.mouse.move(box.x+400,box.y+200);await page.waitForTimeout(600);
 const r=await guest('(()=>{const r=document.querySelector(".ytp-play-button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height}})()');
 assert.ok(r.width&&r.height);
 const dimensions=await canvas.evaluate(e=>({width:e.width,height:e.height}));
 await page.mouse.click(box.x+r.x*box.width/dimensions.width,box.y+r.y*box.height/dimensions.height);
 await until('document.querySelector("video").paused');record('YouTube Play/Pause button through actual WebCore canvas input');
 await canvas.focus();await page.keyboard.press('k');
 await until('!document.querySelector("video").paused');record('YouTube keyboard shortcut through native key routing');
 await guest('(document.querySelector("video").currentTime=180,true)');
 await until('document.querySelector("video").currentTime>181 && !document.querySelector("video").seeking && document.querySelector("video").readyState>=2');
 record('Public YouTube MSE seek to three minutes',await guest('(()=>{const v=document.querySelector("video");return {time:v.currentTime,width:v.videoWidth,height:v.videoHeight}})()'));
 await page.screenshot({path:`${output}/youtube.png`});
 await page.evaluate(()=>Module.ccall('bib_load_url',null,['string'],['https://example.com/']));
 await until('location.hostname==="example.com" && document.title==="Example Domain"');
 await page.waitForTimeout(1500);
 const active=await page.evaluate(()=>[...__bibMediaBridge.players.values()].filter(p=>p.el&&!p.el.paused&&p.el.readyState>0).length);
 assert.equal(active,0);record('Navigating away stops old media playback',{active});
 report.engineAlive=await page.evaluate(()=>__bib.ready&&!__bib.dead);assert.equal(report.engineAlive,true);assert.deepEqual(errors,[]);
}catch(error){report.failure=error.stack;console.error(error);process.exitCode=1}
finally{if(page)await page.screenshot({path:`${output}/final.png`,timeout:5000}).catch(()=>{});await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));await writeFile(`${output}/console.log`,logs.join('\n'));await browser.close()}
