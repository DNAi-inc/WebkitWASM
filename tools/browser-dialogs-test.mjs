// Real JSC window.alert/confirm/prompt -> WebCore ChromeClient -> host dialog.
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin=process.env.BIB_ORIGIN||'http://127.0.0.1:14833';
const output=process.env.BIB_RESULTS||'build/acceptance/dialogs';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'chromium',args:['--mute-audio']});
const logs=[],errors=[],seen=[],expected=[];
let page;
const report={date:new Date().toISOString(),results:[],errors};
try{
 page=await browser.newPage();page.on('console',m=>logs.push(m.text()));page.on('pageerror',e=>errors.push(e.stack));
 page.on('dialog',async dialog=>{
  const next=expected.shift();seen.push({type:dialog.type(),message:dialog.message(),defaultValue:dialog.defaultValue()});
  try{
   assert.ok(next,'Unexpected dialog');assert.equal(dialog.type(),next.type);
   assert.equal(dialog.message(),`${origin}\n\n${next.message}`);
   if(next.initial!==undefined)assert.equal(dialog.defaultValue(),next.initial);
   if(next.cancel)await dialog.dismiss();else await dialog.accept(next.answer);
  }catch(error){errors.push(error.stack);await dialog.dismiss().catch(()=>{})}
 });
 await page.goto(`${origin}/browser.html?desktop=1&persist=0&gpu=0&url=${encodeURIComponent(origin+'/media/desktop.html')}`);
 await page.waitForFunction(()=>window.__bib?.ready&&!__bib.dead,null,{timeout:180000});
 assert.equal(await page.evaluate(()=>window.BIB_GC_ROOT_MODE),'jsc-numeric-v2');
 let sequence=0;
 const guest=async expression=>{
  const marker=`DIALOGPROBE${++sequence}:`;
  await page.evaluate(({marker,expression})=>Module.ccall('bib_eval','number',['string'],[`console.log(${JSON.stringify(marker)}+JSON.stringify((${expression})))`]),{marker,expression});
  const start=Date.now();
  while(Date.now()-start<30000){
   const line=logs.find(line=>line.includes(marker));
   if(line){let text=line.slice(line.indexOf(marker)+marker.length);const end=text.lastIndexOf(' (');if(end>=0)text=text.slice(0,end);return JSON.parse(text)}
   await page.waitForTimeout(100);
  }
  throw new Error('Native dialog result timed out');
 };
 while(await guest('location.pathname')!=='/media/desktop.html')await page.waitForTimeout(100);
 const cases=[
  {type:'alert',message:'Native greeting',expression:'(alert("Native greeting"),true)',result:true},
  {type:'confirm',message:'Continue?',expression:'confirm("Continue?")',result:true},
  {type:'confirm',message:'Cancel?',cancel:true,expression:'confirm("Cancel?")',result:false},
  {type:'prompt',message:'Edit name',initial:'Existing café',answer:'Edited 🐰 café',expression:'prompt("Edit name","Existing café")',result:'Edited 🐰 café'},
  {type:'prompt',message:'Cancel edit',cancel:true,expression:'prompt("Cancel edit")',result:null},
  {type:'prompt',message:'Empty edit',answer:'',expression:'prompt("Empty edit","old")',result:''},
 ];
 for(const item of cases){expected.push(item);const result=await guest(item.expression);assert.deepEqual(result,item.result);assert.equal(expected.length,0,'WebCore must present a real host dialog');report.results.push({type:item.type,message:item.message,result});console.log(`PASS ${item.type}: ${item.message}`)}
 assert.deepEqual(errors,[]);assert.equal(seen.length,cases.length);assert.equal(await page.evaluate(()=>__bib.ready&&!__bib.dead),true);report.engineAlive=true;
}catch(error){report.failure=error.stack;process.exitCode=1;console.error(error)}
finally{await writeFile(`${output}/report.json`,JSON.stringify({...report,dialogs:seen},null,2));await writeFile(`${output}/console.log`,logs.join('\n'));await browser.close()}
