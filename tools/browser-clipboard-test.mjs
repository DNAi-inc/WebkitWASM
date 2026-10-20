// Real WebCore selection/editor/clipboard events. Only the OS clipboard adapter
// is simulated: this test must never read or overwrite the user's clipboard.
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin=process.env.BIB_ORIGIN||'http://127.0.0.1:14838';
const output=process.env.BIB_RESULTS||'build/acceptance/clipboard';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chromium',args:['--mute-audio']});
const logs=[],errors=[];let page;
const report={date:new Date().toISOString(),osClipboard:'simulated; real native editor',results:[],errors};
try{
 page=await browser.newPage();page.on('console',m=>logs.push(m.text()));page.on('pageerror',e=>errors.push(e.stack));
 await page.addInitScript(()=>{
  const os=window.__clipboardOS={text:'',reads:0,writes:0,denied:false,holdRead:false};
  Object.defineProperty(navigator,'clipboard',{value:{
   async write(items){os.writes++;if(os.denied)throw new DOMException('Clipboard permission denied','NotAllowedError');os.text=await(await items[0].getType('text/plain')).text()},
   async readText(){os.reads++;if(os.holdRead)await new Promise(resolve=>os.releaseRead=resolve);return os.text}
  }});
 });
 await page.goto(`${origin}/browser.html?desktop=1&persist=0&gpu=0&url=${encodeURIComponent(origin+'/media/desktop.html')}`);
 await page.waitForFunction(()=>window.__bib?.ready&&!__bib.dead,null,{timeout:180000});
 let sequence=0;
 const guest=async expression=>{
  const marker=`CLIPPROBE${++sequence}:`;
  await page.evaluate(({marker,expression})=>Module.ccall('bib_eval','number',['string'],[`console.log(${JSON.stringify(marker)}+JSON.stringify((${expression})))`]),{marker,expression});
  const start=Date.now();while(Date.now()-start<15000){const line=logs.find(l=>l.includes(marker));if(line){let s=line.slice(line.indexOf(marker)+marker.length),end=s.lastIndexOf(' (');return JSON.parse(end<0?s:s.slice(0,end))}await page.waitForTimeout(50)}throw new Error('Clipboard guest probe timed out');
 };
 while(await guest('location.pathname')!=='/media/desktop.html')await page.waitForTimeout(100);
 await guest(`(()=>{document.body.innerHTML='<textarea id="edit" style="width:600px;height:100px"></textarea><input id="password" type="password">';window.events=[];for(const type of ['copy','cut','paste','input'])document.addEventListener(type,e=>{events.push({type,text:e.clipboardData?.getData('text/plain')??null});if(type==='copy'&&window.customCopy!==undefined){e.clipboardData.setData('text/plain',customCopy);e.preventDefault()}});return true})()`);
 const select=async(text,start=0,end=text.length)=>{
  await guest(`(()=>{const e=document.getElementById('edit');e.value=${JSON.stringify(text)};e.focus();e.setSelectionRange(${start},${end});return true})()`);
  await page.locator('#screen').focus();
 };
 const shortcut=async(key,status)=>{
  await page.evaluate(()=>document.getElementById('status').textContent='pending test');
  await page.keyboard.press('Control+'+key);
  await page.waitForFunction(status=>document.getElementById('status').textContent===status,status,{timeout:35000});
 };
 const record=name=>{report.results.push(name);console.log('PASS '+name)};
 await select('Hello 🐰 café',6,8);await shortcut('c','Copied');
 assert.equal(await page.evaluate(()=>__clipboardOS.text),'🐰');
 assert.equal(await guest('events.at(-1).type'),'copy');record('Unicode copy uses real native selection and copy event');
 await guest('(window.customCopy="Custom 🐱",true)');await select('Original');await shortcut('c','Copied');
 assert.equal(await page.evaluate(()=>__clipboardOS.text),'Custom 🐱');record('Website custom copy event');
 await guest('(window.customCopy="",true)');await shortcut('c','Copied');assert.equal(await page.evaluate(()=>__clipboardOS.text),'');
 await guest('(delete window.customCopy,true)');record('Empty custom clipboard text is accepted');
 await select('Menu copy');await page.evaluate(()=>document.getElementById('status').textContent='pending menu test');await page.locator('#editmenu summary').click();await page.locator('[data-clipboard="copy"]').click();
 await page.waitForFunction(()=>document.getElementById('status').textContent==='Copied');assert.equal(await page.evaluate(()=>__clipboardOS.text),'Menu copy');record('Accessible Edit menu routes to native clipboard selection');
 await select('Before ',7,7);await page.evaluate(()=>__clipboardOS.text='Pasted 🐰 café');await shortcut('v','Pasted');
 assert.equal(await guest('edit.value'),'Before Pasted 🐰 café');assert.ok((await guest('events')).some(e=>e.type==='paste'&&e.text==='Pasted 🐰 café'));record('Paste dispatches native clipboard and input events');
 await select('Website owns paste');await guest(`(document.addEventListener('paste',e=>{e.preventDefault();window.customPasted=e.clipboardData.getData('text/plain')},{once:true}),true)`);
 await page.evaluate(()=>__clipboardOS.text='Custom paste');await shortcut('v','Pasted');assert.equal(await guest('edit.value'),'Website owns paste');assert.equal(await guest('customPasted'),'Custom paste');record('Website paste handler can cancel default insertion');
 await select('Delete this',0,6);await shortcut('x','Cut');assert.equal(await guest('edit.value'),' this');assert.equal(await page.evaluate(()=>__clipboardOS.text),'Delete');
 await page.keyboard.press('Control+z');await page.waitForTimeout(200);assert.equal(await guest('edit.value'),'Delete this');record('Cut commits only after clipboard write and retains undo');
 await select('Keep this');await page.evaluate(()=>__clipboardOS.denied=true);await shortcut('x','Clipboard permission denied');
 assert.equal(await guest('edit.value'),'Keep this');await page.evaluate(()=>__clipboardOS.denied=false);record('Denied clipboard write never performs default cut deletion');
 await select('Target',0,6);await page.evaluate(()=>{__clipboardOS.text='Wrong target';__clipboardOS.holdRead=true});await page.keyboard.press('Control+v');
 await page.waitForFunction(()=>typeof __clipboardOS.releaseRead==='function');await guest('(edit.setSelectionRange(1,1),true)');
 await page.evaluate(()=>{__clipboardOS.holdRead=false;__clipboardOS.releaseRead()});await page.waitForFunction(()=>document.getElementById('status').textContent==='Paste cancelled: selection changed');
 assert.equal(await guest('edit.value'),'Target');record('Asynchronous paste rejects changed native selection');
 await select('Address safe');await page.evaluate(()=>{__clipboardOS.text='Not in address';__clipboardOS.holdRead=true;delete __clipboardOS.releaseRead});await page.keyboard.press('Control+v');
 await page.waitForFunction(()=>typeof __clipboardOS.releaseRead==='function');await page.locator('#urlbar').focus();await page.evaluate(()=>{__clipboardOS.holdRead=false;__clipboardOS.releaseRead()});
 await page.waitForFunction(()=>document.getElementById('status').textContent==='Paste cancelled: browser focus changed');assert.equal(await guest('edit.value'),'Address safe');record('Asynchronous paste rejects changed host focus');
 await guest(`(()=>{password.value='secret';password.focus();password.setSelectionRange(0,6);return true})()`);await page.locator('#screen').focus();
 await shortcut('c','Nothing to copy');assert.notEqual(await page.evaluate(()=>__clipboardOS.text),'secret');record('WebCore password selection cannot be copied');
 await select('Navigation guard');await page.evaluate(()=>{__clipboardOS.text='Stale paste';__clipboardOS.holdRead=true;delete __clipboardOS.releaseRead});await page.keyboard.press('Control+v');
 await page.waitForFunction(()=>typeof __clipboardOS.releaseRead==='function');
 await page.evaluate(url=>Module.ccall('bib_load_url',null,['string'],[url]),origin+'/media/desktop.html?clipboard-navigation=1');
 while(await guest('location.search')!=='?clipboard-navigation=1')await page.waitForTimeout(100);
 await page.evaluate(()=>{__clipboardOS.holdRead=false;__clipboardOS.releaseRead()});
 await page.waitForFunction(()=>document.getElementById('status').textContent==='Paste cancelled: selection changed');assert.equal(await guest('document.getElementById("input").value'),'');record('Asynchronous paste cannot enter a newly navigated document');
 assert.deepEqual(errors,[]);report.engineAlive=await page.evaluate(()=>__bib.ready&&!__bib.dead);assert.equal(report.engineAlive,true);
}catch(error){report.failure=error.stack;process.exitCode=1;console.error(error);if(page)await page.screenshot({path:`${output}/failure.png`,timeout:5000}).catch(()=>{})}
finally{await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));await writeFile(`${output}/console.log`,logs.join('\n'));await browser.close()}
