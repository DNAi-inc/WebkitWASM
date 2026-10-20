// Real WebCore+JSC+curl/Wisp acceptance. No engine mocks and no host iframe.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { mkdir, writeFile } from 'node:fs/promises';
const origin = process.env.BIB_ORIGIN || 'http://127.0.0.1:14830';
const output = process.env.BIB_RESULTS || `build/acceptance/${process.env.BIB_GPU === '1' ? 'gpu' : 'cpu'}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', args: ['--mute-audio'] });
const echo = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 65536, verifyClient: info => info.origin === origin });
await once(echo, 'listening');
echo.on('connection', socket => socket.on('message', (data, binary) => socket.send(data, { binary })));
const echoURL = `ws://127.0.0.1:${echo.address().port}/native-echo`;
const hostSockets = [];
const report = { date: new Date().toISOString(), hostBrowser: browser.version(), requestedGPU: process.env.BIB_GPU === '1', forcedHeadlessGPUPipeline: process.env.BIB_GPU === '1', results: [], errors: [] };
const logs = [], hostRequests = [];
let page;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', message => logs.push(message.text()));
  page.on('pageerror', error => report.errors.push(error.stack));
  page.on('request', request => hostRequests.push(request.url()));
  page.on('websocket', socket => hostSockets.push(socket.url()));
  await page.goto(`${origin}/browser.html?desktop=1&persist=0&gpu=${process.env.BIB_GPU || '0'}&gpubench=${process.env.BIB_GPU === '1' ? '0' : '1'}&url=${encodeURIComponent(origin + '/media/desktop.html')}`);
  await page.waitForFunction(() => window.__bib?.ready && !__bib.dead, null, { timeout: 180000 });
  report.linkOptimization = await page.evaluate(() => window.BIB_LINK_OPT);
  report.gcRootMode = await page.evaluate(() => window.BIB_GC_ROOT_MODE);
  assert.equal(report.gcRootMode, 'jsc-numeric-v2', 'engine must preserve encoded JSC roots');
  report.iterationOnly = process.env.BIB_ITERATION === "1";
  if (!report.iterationOnly) assert.equal(report.linkOptimization, 3, "acceptance requires the optimized delivery build");
  let sequence = 0;
  const guest = async expression => {
    const marker = `ENGINEPROBE${++sequence}:`;
    await page.evaluate(({ marker, expression }) => Module.ccall('bib_eval', 'number', ['string'], [`console.log(${JSON.stringify(marker)}+JSON.stringify((${expression})))`]), { marker, expression });
    const started = Date.now();
    while (Date.now() - started < 15000) {
      const line = logs.find(text => text.includes(marker));
      if (line) {
        const body = line.slice(line.indexOf(marker) + marker.length);
        // WebCore console forwarder appends source/line in parentheses.
        const end = body.lastIndexOf(' (');
        return JSON.parse(end >= 0 ? body.slice(0, end) : body);
      }
      await page.waitForTimeout(100);
    }
    throw new Error(`Guest probe timed out: ${expression}`);
  };
  const until = async (expression, timeout = 30000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) { const result = await guest(expression); if (result) return result; await page.waitForTimeout(250); }
    throw new Error(`Guest condition timed out: ${expression}`);
  };
  const click = async id => {
    const rect = await guest(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const canvas = await page.locator('#screen').boundingBox();
    const dimensions = await page.locator('#screen').evaluate(el => ({ width: el.width, height: el.height }));
    await page.mouse.click(canvas.x + rect.x * canvas.width / dimensions.width, canvas.y + rect.y * canvas.height / dimensions.height);
  };
  const record = (name, detail) => { report.results.push({ name, detail }); console.log(`PASS ${name}: ${JSON.stringify(detail)}`); };
  await until('typeof desktopState === "function" && video.readyState >= 1');
  record('Exposed APIs (presence only)', await guest('({worker:typeof Worker,webSocket:typeof WebSocket,indexedDB:typeof indexedDB,mediaSource:typeof MediaSource,subtleCrypto:typeof globalThis.crypto?.subtle,webRTC:typeof RTCPeerConnection,serviceWorker:"serviceWorker" in navigator,fullscreen:typeof document.documentElement.requestFullscreen,viewTransitions:typeof document.startViewTransition})'));
  // Regression for WebKit 336c35e2c17c (SlowPutArrayStorage structure flags).
  const invariants=await guest(`(()=>{Object.defineProperty(Object.prototype,0,{get(){},configurable:true});delete Object.prototype[0];const target=[1,2,3];Object.defineProperty(target,'length',{writable:false});let getThrows=false,setThrows=false;try{new Proxy(target,{get:(t,k)=>k==='length'?999:t[k]}).length}catch(e){getThrows=e instanceof TypeError}try{Reflect.set(new Proxy(target,{set:()=>true}),'length',999)}catch(e){setThrows=e instanceof TypeError}return {getThrows,setThrows,length:target.length}})()`);
  assert.deepEqual(invariants,{getThrows:true,setThrows:true,length:3});
  record('JavaScript Proxy invariants for non-writable array length',invariants);
  assert.equal(await guest('typeof document.startViewTransition'), "undefined");
  assert.equal(await guest('CSS.supports("view-transition-name","desktop-check")'), false);
  await page.evaluate(() => Module.ccall('bib_gc_roots_test', 'number', [], []));
  const gcStart = Date.now();
  while (!logs.some(line => line.includes('BIBGCROOTS:')) && Date.now() - gcStart < 60000)
    await page.waitForTimeout(100);
  assert.ok(logs.some(line => line.includes('BIBGCROOTS:32')), 'all encoded object roots must survive 32 real full collections');
  record('Native encoded objects survive 32 full JSC garbage collections', { collections: 32 });
  let state = await guest('desktopState()');
  assert.equal(state.width, 640); assert.equal(state.height, 360); assert.ok(state.canMP4);
  // Hit WebCore's built-in UA-shadow controls through the real framebuffer.
  let nativePoint = await guest('(()=>{const r=video.getBoundingClientRect();return {x:r.x+30,y:r.bottom-24}})()');
  const nativeCanvas = await page.locator('#screen').boundingBox();
  await page.mouse.click(nativeCanvas.x+nativePoint.x+270,nativeCanvas.y+nativePoint.y);
  await until('video.paused && !video.seeking && video.currentTime>1 && video.currentTime<10');
  await guest('(video.currentTime=0,true)');await until('!video.seeking && video.currentTime<.1');
  await page.mouse.click(nativeCanvas.x+nativePoint.x+570,nativeCanvas.y+nativePoint.y);
  await until('video.volume>.1 && video.volume<.95');
  await page.mouse.click(nativeCanvas.x+nativePoint.x+505,nativeCanvas.y+nativePoint.y);
  await until('video.muted');
  await guest('(video.muted=false,video.volume=1,true)');
  record('Built-in seek, volume and mute controls through actual canvas input', {});
  await page.mouse.click(nativeCanvas.x+nativePoint.x,nativeCanvas.y+nativePoint.y);
  await until('video.currentTime > 1 && !video.paused && video.readyState>=2');
  await page.mouse.click(nativeCanvas.x+nativePoint.x,nativeCanvas.y+nativePoint.y);
  await until('video.paused');
  record('Built-in video controls play/pause through actual canvas input', {});
  for(let cycle=0;cycle<3;cycle++) {
    if(cycle){await page.mouse.click(nativeCanvas.x+nativePoint.x,nativeCanvas.y+nativePoint.y);await until('video.paused')}
    await guest('(window.mediaParent=video.parentNode,window.mediaNext=video.nextSibling,video.remove(),true)');
    await guest('(()=>{const garbage=Array.from({length:40000},(_,i)=>({index:i,text:"controls "+i}));return garbage.length})()');
    await page.waitForTimeout(300);
    const detachedDOM=await guest('({body:document.body?.tagName??null,url:location.href,parent:mediaParent.tagName})');
    assert.equal(detachedDOM.body,'BODY',JSON.stringify(detachedDOM));
    await guest('(mediaParent.insertBefore(video,mediaNext),true)');
    await until('video.isConnected && video.readyState>=1');
    nativePoint=await guest('(()=>{const r=video.getBoundingClientRect();return {x:r.x+30,y:r.bottom-24}})()');
    const before=await guest('video.currentTime');
    await page.mouse.click(nativeCanvas.x+nativePoint.x,nativeCanvas.y+nativePoint.y);
    await until(`!video.paused && video.currentTime>${before+.15}`);
  }
  record('Built-in controls survive repeated detach and allocation pressure',{cycles:3});

  await guest(`(()=>{window.frameCallbacks=0;window.lastFrameMetadata=null;const callback=(time,metadata)=>{frameCallbacks++;lastFrameMetadata={width:metadata.width,height:metadata.height,time:metadata.mediaTime};if(frameCallbacks<4)video.requestVideoFrameCallback(callback)};video.requestVideoFrameCallback(callback);return true})()`);
  await until('frameCallbacks>=3');
  assert.equal((await guest('lastFrameMetadata')).width, 640);
  record('Native requestVideoFrameCallback and decoder quality', await guest('({callbacks:frameCallbacks,metadata:lastFrameMetadata,total:video.getVideoPlaybackQuality().totalVideoFrames})'));
  const memory = await page.evaluate(() => {
    const before = Module.HEAPU8.length;
    if (before > 1024 * 1024 * 1024) throw new Error('Unexpected initial heap size');
    const pointer = Module._bib_wasm_alloc(before + 64 * 1024 * 1024);
    if (!pointer) throw new Error('Memory-growth fixture allocation failed');
    Module.bibSyncMemoryViews(); const size = Module.HEAPU8.length;
    Module._bib_wasm_free(pointer);
    if (size <= before) throw new Error('Fixture did not grow memory');
    return { before, after: size };
  });
  record('Video survives shared WASM memory growth', memory);
  const videoRect = await guest('(()=>{const r=video.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
  const signature = rect => page.evaluate(async rect => {
    const frame = await __bib.readback(); let hash = 2166136261;
    for (let y = Math.max(0, Math.floor(rect.y)); y < Math.min(frame.h, rect.y + rect.height); y += 7)
      for (let x = Math.max(0, Math.floor(rect.x)); x < Math.min(frame.w, rect.x + rect.width); x += 7) {
        const i = (y * frame.w + x) * 4;
        hash = Math.imul(hash ^ frame.data[i], 16777619) >>> 0;
        hash = Math.imul(hash ^ frame.data[i + 1], 16777619) >>> 0;
      }
    const i = (220 * frame.w + 370) * 4;
    return { hash, overlay: [...frame.data.slice(i, i + 3)] };
  }, rect);
  const first = await signature(videoRect);
  await page.waitForTimeout(1200);
  const next = await signature(videoRect);
  assert.notEqual(first.hash, next.hash, 'WebCore framebuffer must show changing decoded pixels');
  assert.ok(next.overlay.every((value,index)=>Math.abs(value-[209,39,99][index])<=2), 'page content must paint above video without a decoder overlay');
  await page.locator('#screen').screenshot({ path: `${output}/webcore-mp4.png` });
  const sample = await page.evaluate(() => ({ time: performance.now(), paints: __bib.frames, decoded: __bibMediaBridge.stats.frames }));
  await page.waitForTimeout(2000);
  const speed = await page.evaluate(start => {
    const seconds = (performance.now() - start.time) / 1000;
    return { seconds, paintFPS: (__bib.frames - start.paints) / seconds, deliveredVideoFPS: (__bibMediaBridge.stats.frames - start.decoded) / seconds };
  }, sample);
  record('Measured local video presentation', speed);
  await click('pause'); const pauseTime = await guest('video.currentTime'); await page.waitForTimeout(600);
  assert.ok(Math.abs((await guest('video.currentTime')) - pauseTime) < 0.25);
  await guest(`(()=>{window.pausedCallbacks=0;window.frameHash=()=>{const c=document.createElement('canvas');c.width=64;c.height=36;const x=c.getContext('2d');x.drawImage(video,0,0,64,36);let hash=2166136261;for(const byte of x.getImageData(0,0,64,36).data)hash=Math.imul(hash^byte,16777619)>>>0;return hash};window.beforeSeekHash=frameHash();video.requestVideoFrameCallback(()=>pausedCallbacks++);return true})()`);
  await page.waitForTimeout(300);
  assert.equal(await guest('pausedCallbacks'), 0, 'a settled paused frame must not be reported as a new frame');
  await click('seek'); await until('!video.seeking && video.currentTime >= 7.9 && pausedCallbacks===1');
  assert.notEqual(await guest('frameHash()'), await guest('beforeSeekHash'), 'paused seek must replace the actual video pixels');
  record('Paused seek pixels and next-frame callback semantics', {});
  await guest('(video.volume=.3,video.playbackRate=1.5,video.muted=true,true)');
  // WebCore updates the decoder rate only while potentially playing.
  await click('play'); await until('!video.paused && video.currentTime>8.2');
  await page.waitForFunction(() => [...__bibMedia.values()].some(p => p.el && Math.abs(p.el.volume-.3)<1e-6 && p.el.muted && Math.abs(p.el.playbackRate-1.5)<1e-6));
  const decoder = await page.evaluate(() => [...__bibMedia.values()].map(p => ({ volume: p.el?.volume, muted: p.el?.muted, rate: p.el?.playbackRate })));
  assert.ok(decoder.some(p => Math.abs(p.volume-.3)<1e-6 && p.muted && Math.abs(p.rate-1.5)<1e-6), JSON.stringify(decoder));
  record('MP4 video painting, playback, pause, seeking and controls', { state, decoder });
  await guest(`(window.audioGate={ended:false,error:null},window.aud=new Audio('/media/beep.wav'),aud.muted=true,aud.addEventListener('ended',()=>audioGate.ended=true),aud.play().catch(error=>audioGate.error=error.name),true)`);
  await until('audioGate.ended');
  assert.equal(await guest('audioGate.error'), null);
  record('Audio playback clock and ended event', await guest('({time:aud.currentTime,ended:aud.ended})'));
  await click('webm'); await until('video.readyState>=1 && video.currentSrc.endsWith("clip.webm")');
  await click('play'); await until('video.currentTime>.5 && !video.paused');
  record('WebM source replacement', await guest('desktopState()'));
  const beforeBytes = await page.evaluate(() => __bibMediaBridge.stats.bytes);
  await click('large'); await until('video.readyState>=1 && video.currentSrc.endsWith("large.mp4")');
  await click('play'); await until('video.currentTime > .5'); await click('seek'); await until('!video.seeking && video.currentTime >= 7.9');
  const bytes = await page.evaluate(() => __bibMediaBridge.stats.bytes);
  console.log("Large movie transfer", JSON.stringify({beforeBytes,bytes,delta:bytes-beforeBytes}));
  assert.ok(bytes - beforeBytes < 12 * 1024 * 1024, JSON.stringify({beforeBytes,bytes,delta:bytes-beforeBytes}));
  record('>72MiB movie uses bounded guest range requests', { bytes: bytes - beforeBytes });
  await guest(`(fetch('/cookie-test/set').then(()=>{video.src='/cookie-test/protected.mp4';video.load()}),true)`);
  await until('video.readyState>=1 && video.currentSrc.endsWith("protected.mp4")');
  record('Guest media cookies remain in WebCore network path', await guest('desktopState()'));
  await click('mse'); await until('window.mseGate?.done && video.readyState>=2', 60000);
  assert.equal(await guest('mseGate.error'), null);
  await click('play'); await until('video.currentTime>.5 && !video.paused');
  await click('seek'); await until('!video.seeking && video.currentTime>=7.9');
  record('MediaSource: JSC append segments, native video, seeking', await guest('({updates:mseGate.updates,state:testMediaSource.readyState,ranges:testSourceBuffer.buffered.length,time:video.currentTime})'));
  await click('hls'); await until('window.hlsGate?.ready && video.readyState>=1', 60000);
  await click('play'); await until('video.currentTime>1 && !video.paused', 60000);
  await click('seek'); await until('!video.seeking && video.currentTime>=7.9');
  assert.equal(await guest('hlsGate.errors.some(error=>error.fatal)'), false);
  record('Unmodified HLS.js 1.6.13: playlist, TS demux, MSE playback and seeking', await guest('({time:video.currentTime,state:video.readyState,errors:hlsGate.errors.slice(-2)})'));
  await guest('(testHls.destroy(),true)');
  await guest(`(fetch('/media/generated/clip.mp4').then(response=>response.blob()).then(blob=>{window.blobURL=URL.createObjectURL(blob);video.src=blobURL;video.load()}),true)`);
  await until('video.currentSrc.startsWith("blob:") && video.readyState>=2');
  await click('play'); await until('video.currentTime>.3');
  const blobPixel = await guest(`(()=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.drawImage(video,0,0,1,1);return [...x.getImageData(0,0,1,1).data]})()`);
  assert.equal(blobPixel[3], 255);
  await guest('(URL.revokeObjectURL(blobURL),true)');
  record('Guest Blob video loader and readable same-origin canvas pixels', { pixel: blobPixel });
  const crossOriginURL = origin.replace('127.0.0.1', 'localhost') + '/media/generated/clip.mp4';
  await guest(`(video.src=${JSON.stringify(crossOriginURL)},video.load(),true)`);
  await until('video.readyState>=1 && video.currentSrc.includes("localhost")');
  await click('play'); await until('video.currentTime>.3 && video.readyState>=2');
  const taint = await guest(`(()=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');try{x.drawImage(video,0,0,1,1);x.getImageData(0,0,1,1);return 'readable'}catch(e){return e.name}})()`);
  assert.equal(taint, 'SecurityError');
  await guest(`(video.crossOrigin='anonymous',video.src=${JSON.stringify(crossOriginURL)}+'?cors-denied=1',video.load(),true)`);
  await until('!!video.error', 30000);
  record('Cross-origin canvas taint and CORS denial retained', { taint, error: await guest('video.error.code') });
  const leaked = hostRequests.filter(url => /media\/generated\/|cookie-test\/|media\/beep\.wav/.test(url));
  assert.deepEqual(leaked, [], 'host must never fetch original website media/cookie URL');
  record('No original media or cookie requests from the host browser', { requests: hostRequests.length });
  await guest(`(window.cloneGate={rounds:0,done:false,error:null},(async()=>{try{for(let i=0;i<3;i++){const response=await fetch('/media/generated/clip.mp4'),copy=response.clone();const [a,b]=await Promise.all([response.arrayBuffer(),copy.arrayBuffer()]);const left=new Uint8Array(a),right=new Uint8Array(b);if(left.length!==right.length||left.some((v,j)=>v!==right[j]))throw new Error('clone bytes differ');cloneGate.rounds++}cloneGate.done=true}catch(error){cloneGate.error=error.message}})(),true)`);
  await until('cloneGate.done || cloneGate.error',60000);
  assert.deepEqual(await guest('cloneGate'),{rounds:3,done:true,error:null});
  record('Native Fetch Response.clone copies complete streaming bodies',await guest('cloneGate'));
  await click('input'); await page.keyboard.type('Desktop browsing works');
  assert.equal(await guest('document.getElementById("input").value'), 'Desktop browsing works');
  await guest('(localStorage.setItem("desktop-key","retained"),sessionStorage.setItem("desktop-key","tab"),true)');
  assert.deepEqual(await guest('({local:localStorage.getItem("desktop-key"),session:sessionStorage.getItem("desktop-key")})'), { local: 'retained', session: 'tab' });
  await page.keyboard.press('Control+a'); await page.keyboard.type('Replacement');
  assert.equal(await guest('document.getElementById("input").value'), 'Replacement');
  await page.keyboard.press('Control+z');
  await until('document.getElementById("input").value === "Desktop browsing works"');
  await page.keyboard.press('Control+Shift+z');
  await until('document.getElementById("input").value === "Replacement"');
  record('Real keyboard editing, selection, undo/redo and guest storage', {});
  await guest(`(()=>{window.idbGate={};try{const request=indexedDB.open('desktop-acceptance',1);request.onupgradeneeded=()=>request.result.createObjectStore('state');request.onerror=()=>idbGate.error=request.error.name;request.onsuccess=()=>{const db=request.result;const tx=db.transaction('state','readwrite');tx.objectStore('state').put({text:'Native IndexedDB'},'document');tx.onerror=()=>idbGate.error=tx.error.name;tx.oncomplete=()=>{const read=db.transaction('state').objectStore('state').get('document');read.onerror=()=>idbGate.error=read.error.name;read.onsuccess=()=>{idbGate.value=read.result.text;idbGate.done=true;db.close()}}}}catch(e){idbGate.error=e.name}return true})()`);
  await until('idbGate.done || idbGate.error');
  assert.equal(await guest('idbGate.value'), 'Native IndexedDB');
  record('Native IndexedDB write/read transactions', await guest('idbGate'));
  await guest(`(()=>{window.wsGate={};const socket=new WebSocket(${JSON.stringify(echoURL)});socket.binaryType='arraybuffer';socket.onopen=()=>socket.send('WebCore socket');socket.onerror=()=>wsGate.error='connection error';socket.onmessage=event=>{if(typeof event.data==='string'){wsGate.text=event.data;socket.send(new Uint8Array([3,1,4]))}else{wsGate.binary=[...new Uint8Array(event.data)];socket.close()}};socket.onclose=()=>wsGate.closed=true;return true})()`);
  await until('wsGate.closed || wsGate.error');
  const socketState = await guest('wsGate');
  assert.equal(socketState.text, 'WebCore socket'); assert.deepEqual(socketState.binary, [3,1,4]);
  assert.ok(hostSockets.every(url => url.includes('/wisp/')), 'guest WebSocket must use in-engine TCP/TLS, not a host website socket');
  record('Native WebSocket text/binary round-trip through Wisp', socketState);
  await page.setViewportSize({ width: 1024, height: 768 });
  await until('innerWidth===1024 && innerHeight===724');
  record('Live viewport resize without page reload', await guest('({width:innerWidth,height:innerHeight,text:document.getElementById("input").value})'));
  await page.evaluate(url => Module.ccall('bib_load_url', null, ['string'], [url]), 'https://example.com');
  await until('location.hostname==="example.com" && document.title==="Example Domain" && document.body.innerText.length>20', 60000);
  record('Live HTTPS website over in-engine TLS', await guest('({url:location.href,title:document.title})'));
  await page.click('#backbtn'); await until('location.pathname==="/media/desktop.html"');
  assert.equal(await guest('localStorage.getItem("desktop-key")'), 'retained');
  record('Back history retains origin storage', {});
  await page.click('#forwardbtn'); await until('location.hostname==="example.com"');
  record('Forward history', {});
  const publicVideoURL = 'https://media.w3.org/2010/05/sintel/trailer.mp4';
  await page.evaluate(url => Module.ccall('bib_load_url', null, ['string'], [url]), publicVideoURL);
  await until('location.hostname==="media.w3.org" && document.querySelector("video")?.readyState>=1', 60000);
  await guest('(()=>{const v=document.querySelector("video");v.muted=true;v.play().catch(()=>{});return true})()');
  await until('document.querySelector("video").currentTime>1 && document.querySelector("video").readyState>=2', 60000);
  record('Public HTTPS MP4 media document plays through guest networking', await guest('(()=>{const v=document.querySelector("video");return {url:location.href,time:v.currentTime,width:v.videoWidth,height:v.videoHeight,controls:v.controls}})()'));
  await page.locator('#screen').screenshot({path:`${output}/public-video.png`});
  report.siteProbesRequested = process.env.BIB_SITE_PROBES !== '0';
  for (const target of report.siteProbesRequested ? ['https://en.wikipedia.org/wiki/WebKit', 'https://www.youtube.com/'] : []) {
    await page.evaluate(url => Module.ccall('bib_load_url', null, ['string'], [url]), target);
    await page.waitForTimeout(target.includes('youtube') ? 25000 : 15000);
    const diagnosis = await guest('({url:location.href,title:document.title,text:document.body?.innerText.slice(0,130),mse:typeof MediaSource,webRTC:typeof RTCPeerConnection})');
    report.results.push({ name: 'Public site compatibility probe', target, diagnosis });
    await page.locator('#screen').screenshot({ path: `${output}/${target.includes('youtube') ? 'youtube' : 'wikipedia'}.png` });
  }
  report.rendering = await page.evaluate(() => ({gpu: Module.bibGPU, pthread: window.BIB_PTHREAD_BUILD, width:document.getElementById('screen').width,height:document.getElementById('screen').height}));
  report.engineAlive = await page.evaluate(() => __bib.ready && !__bib.dead);
  assert.equal(report.engineAlive, true);
} catch (error) { report.failure = error.stack; console.error(error); process.exitCode = 1;
  if (page) await page.screenshot({path:`${output}/failure.png`,timeout:5000}).catch(()=>{});
}
finally {
  await writeFile(`${output}/engine-report.json`, JSON.stringify(report, null, 2));
  await writeFile(`${output}/engine-console.log`, logs.join('\n'));
  await browser.close();
  for (const socket of echo.clients) socket.terminate();
  await new Promise(resolve => echo.close(resolve));
}
