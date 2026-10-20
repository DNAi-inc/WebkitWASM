import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
const origin = process.env.BIB_ORIGIN || 'http://127.0.0.1:14830';
test('static media ranges and exact Wisp Origin gate', async () => {
  const response = await fetch(origin + '/media/generated/large.mp4', { headers: { Range: 'bytes=16-47' } });
  assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 32);
  assert.match(response.headers.get('content-range'), /^bytes 16-47\/\d+$/);
  const rejected = await new Promise((resolve, reject) => {
    const request = http.get(origin + '/wisp/', { headers: { Connection: 'Upgrade', Upgrade: 'websocket', Origin: 'https://untrusted.invalid', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.alloc(16, 7).toString('base64') } });
    request.on('response', result => { result.resume(); resolve(result.statusCode); });
    request.on('upgrade', (_, socket) => { socket.destroy(); reject(new Error('Untrusted origin accepted')); }); request.on('error', reject);
  });
  assert.equal(rejected, 403);
});
test('actual browser Wisp client transports TCP through the local endpoint', { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ channel: 'chromium', args: ['--mute-audio'] });
  try {
    const page = await browser.newPage(); page.on('pageerror', error => console.error(error.stack)); await page.goto(origin + '/media/bridge-test.html');
    await page.addScriptTag({ url: origin + '/vendor/wisp-client.js' });
    const text = await page.evaluate(origin => new Promise((resolve, reject) => {
      const destination = new URL(origin);
      const socket = new wisp_client.client.WispWebSocket(`ws://${destination.host}/wisp/${destination.hostname}:${destination.port}`);
      if (socket.readyState !== 0 || socket.CONNECTING !== 0 || socket.OPEN !== 1 || socket.CLOSING !== 2 || socket.CLOSED !== 3) throw new Error('WebSocket instance constants must match the platform interface');
      let text = ''; const timer = setTimeout(() => { socket.close(); reject(new Error('TCP tunnel timed out: ' + text.slice(0,100))); }, 10000);
      socket.binaryType = 'arraybuffer';
      socket.addEventListener('open', () => socket.send(new TextEncoder().encode(`GET /media/bridge-test.html HTTP/1.1\r\nHost: ${destination.host}\r\nConnection: close\r\n\r\n`)));
      socket.addEventListener('message', event => { text += new TextDecoder().decode(event.data); });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Wisp client error')); });
      socket.addEventListener('close', () => { clearTimeout(timer); resolve(text); });
    }), origin);
    assert.match(text, /^HTTP\/1.1 200/); assert.ok(text.includes('Decoder bridge harness'));
  } finally { await browser.close(); }
});

// The engine host also uses the documented v1 wire format with a phone-style
// transport. Test that path separately from the upstream v2 development server.
test('LGPL client supports v1 flow control and exact stream bytes', { timeout: 60000 }, async () => {
  const { createServer } = await import('node:net');
  const { once } = await import('node:events');
  const { WebSocketServer } = await import('ws');
  const tcp = createServer(socket => socket.pipe(socket));
  tcp.listen(0, '127.0.0.1'); await once(tcp, 'listening');
  const wire = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: info => info.origin === origin });
  await once(wire, 'listening');
  const packet = (type, id, data) => { const value=Buffer.alloc(5+data.length); value[0]=type;value.writeUInt32LE(id,1);data.copy(value,5);return value; };
  const credit=Buffer.alloc(4);credit.writeUInt32LE(2);
  const peers=new Set();
  wire.on('connection', ws => {
    const streams=new Map();ws.send(packet(3,0,credit));
    ws.on('message', raw => {
      const b=Buffer.from(raw);if(b.length<5||b.length>65541){ws.close();return;}
      const id=b.readUInt32LE(1),body=b.subarray(5);
      if(b[0]===1) {
        if(body[0]!==1||body.readUInt16LE(1)!==tcp.address().port||body.subarray(3).toString()!=='127.0.0.1'){ws.close();return;}
        import('node:net').then(({connect})=>{
          const socket=connect(tcp.address().port,'127.0.0.1');peers.add(socket);streams.set(id,{socket,count:0});
          socket.on('data',bytes=>{for(let n=0;n<bytes.length;n+=65536)ws.send(packet(2,id,bytes.subarray(n,n+65536)));});
          socket.on('error',()=>ws.close());socket.on('close',()=>peers.delete(socket));
        });
      } else if(b[0]===2) {
        const stream=streams.get(id);if(!stream){ws.close();return;}stream.socket.write(body);
        if(++stream.count%2===0)ws.send(packet(3,id,credit));
      } else if(b[0]===4) {streams.get(id)?.socket.destroy();streams.delete(id);}
    });
    ws.on('close',()=>{for(const {socket} of streams.values())socket.destroy();});
  });
  const browser=await chromium.launch({channel:'chromium',args:['--mute-audio']});
  try {
    const page=await browser.newPage();await page.goto(origin+'/media/bridge-test.html');await page.addScriptTag({url:origin+'/vendor/wisp-client.js'});
    const result=await page.evaluate(({port,target})=>new Promise((resolve,reject)=>{
      const socket=new wisp_client.client.WispWebSocket(`ws://127.0.0.1:${port}/wisp/127.0.0.1:${target}`);socket.binaryType='arraybuffer';
      const expected=163840,received=new Uint8Array(expected);let length=0;
      const timer=setTimeout(()=>{socket.close();reject(Error('v1 flow-control timeout'));},10000);
      socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('v1 transport error'));});
      socket.addEventListener('open',()=>{if(socket.readyState!==1)throw Error('WebSocket OPEN state');for(let off=0;off<expected;off+=8192){const bytes=new Uint8Array(8192);for(let i=0;i<bytes.length;i++)bytes[i]=(off+i)%251;socket.send(bytes);}});
      socket.addEventListener('message',event=>{const bytes=new Uint8Array(event.data);received.set(bytes,length);length+=bytes.length;if(length===expected){clearTimeout(timer);for(let i=0;i<length;i++)if(received[i]!==i%251){reject(Error('v1 byte mismatch'));return;}const version=socket.connection.wisp_version;socket.close();resolve({length,version});}});
    }),{port:wire.address().port,target:tcp.address().port});
    assert.deepEqual(result,{length:163840,version:1});
  } finally {
    await browser.close();for(const socket of peers)socket.destroy();for(const ws of wire.clients)ws.terminate();await new Promise(resolve=>wire.close(resolve));await new Promise(resolve=>tcp.close(resolve));
  }
});
