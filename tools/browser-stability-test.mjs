// Repeated real engine loads. A harness exiting zero is insufficient:
// each report must show the engine alive, no errors and actual video progress.
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,open} from 'node:fs/promises';
import assert from 'node:assert/strict';
const output=process.env.BIB_RESULTS||'build/stability/gc-roots';
await mkdir(output,{recursive:true});
const cases=[
 {name:'youtube-sustained',url:'https://www.youtube.com/watch?v=aqz-KE-bpKQ',seconds:180,play:120},
 {name:'youtube-cold-2',url:'https://www.youtube.com/watch?v=aqz-KE-bpKQ',seconds:100,play:20},
 {name:'youtube-cold-3',url:'https://www.youtube.com/watch?v=aqz-KE-bpKQ',seconds:100,play:20},
 {name:'wikipedia',url:'https://en.wikipedia.org/wiki/WebKit',seconds:25},
 {name:'discord-public',url:'https://discord.com/',seconds:35},
];
const results=[];
let child;
process.on('SIGINT',()=>child?.kill('SIGTERM'));
try {
 for(const item of cases){
  const folder=`${output}/${item.name}`,log=await open(`${output}/${item.name}.log`,'w');
  console.log(`RUN ${item.name}`);
  try {
   const code=await new Promise((resolve,reject)=>{
    child=spawn(process.execPath,['tools/site-probe.mjs',item.url],{env:{...process.env,BIB_RESULTS:folder,BIB_SECONDS:String(item.seconds),BIB_PLAY_SECONDS:String(item.play||10)},stdio:['ignore',log.fd,log.fd]});
    child.once('error',reject);child.once('exit',resolve);
   });
   assert.equal(code,0,`${item.name}: probe process failed`);
  } finally {await log.close();child=null}
  const report=JSON.parse(await readFile(`${folder}/report.json`,'utf8'));
  results.push({name:item.name,folder,engineAlive:report.engineAlive,playbackObserved:report.playbackObserved,errors:report.errors.length,lastSample:report.samples.at(-1)});
  assert.equal(report.linkOptimization,3);
  assert.equal(report.gcRootMode,'jsc-numeric-v2');
  assert.equal(report.engineAlive,true,`${item.name}: engine stopped`);
  assert.equal(report.failure,undefined,`${item.name}: probe failed`);
  assert.equal(report.probeTimedOut,undefined,`${item.name}: JSC stopped responding`);
  assert.deepEqual(report.errors,[],`${item.name}: page errors`);
  const sample=report.samples.at(-1);
  assert.equal(new URL(sample.url).hostname,new URL(item.url).hostname);
  if(item.play){
   assert.equal(report.playbackObserved,true,`${item.name}: no sustained playback`);
   assert.ok(sample.video.time>item.play);
   assert.ok(report.hostMedia.stats.frames>item.play*5);
  }else{assert.ok(sample.title&&sample.text,`${item.name}: no loaded document`)}
  console.log(`PASS ${item.name}`);
 }
}finally{await writeFile(`${output}/results.json`,JSON.stringify({date:new Date().toISOString(),results},null,2))}
