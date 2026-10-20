// Decoder/gateway acceptance without a WebCore binary. This does NOT prove
// native engine routing; tools/desktop-engine-test.mjs supplies that gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { byteRange } from './http-range.mjs';
const origin = process.env.BIB_ORIGIN || 'http://127.0.0.1:14830';
test('HTTP single-range semantics', () => {
  assert.deepEqual(byteRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(byteRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(byteRange('bytes=90-', 100), { start: 90, end: 99 });
  for (const h of ['bytes=100-', 'bytes=-0', 'bytes=3-1', 'bytes=0-1,3-4', 'bytes=-', 'other=1-3']) assert.equal(byteRange(h, 100), false);
});
test('real decoder: ranges, >64MiB resource, seeking, composed frames and source isolation', { timeout: 150000 }, async () => {
  const browserName = process.env.BIB_BROWSER || 'chromium';
  const browser = await (browserName === 'webkit' ? webkit.launch() : chromium.launch({ channel: 'chromium', args: ['--mute-audio'] }));
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error(e.stack); });
    const requests = [];
    await page.exposeFunction('readEngineRange', async (offset, length, name) => {
      requests.push({ offset, length, name });
      const response = await fetch(`${origin}/media/generated/${name}`, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
      const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(response.headers.get('content-range'));
      return { info: { status: response.status, offset: Number(range?.[1] || 0), total: Number(range?.[3] || response.headers.get('content-length')), mime: response.headers.get('content-type') }, bytes: Buffer.from(await response.arrayBuffer()).toString('base64') };
    });
    console.log('decoder phase: boot');
    await page.goto(`${origin}/media/bridge-test.html`);
    await page.evaluate(async () => {
      window.events = []; window.frames = []; window.filename = 'large.mp4';
      const heap = new Uint8Array(1920 * 1080 * 4 + 16);
      window.fakeModule = {
        HEAPU8: heap, _bib_wasm_alloc: () => 16,
        _bib_media_event: (...args) => events.push(args),
        _bib_media_frame: (id, gen, pointer, width, height) => {
          const mid = pointer + (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
          frames.push({ width, height, pixel: [...heap.slice(mid, mid + 4)] });
          setTimeout(() => bridge.frameDone(id, gen), 60);
        },
        _bib_media_request: (id, gen, request, offset, length) => {
          readEngineRange(offset, length, filename).then(({ info, bytes }) => bridge.chunk(request, info, Uint8Array.from(atob(bytes), character => character.charCodeAt(0))));
        }, _bib_media_cancel: () => {},
      };
      window.bridge = new BibMediaBridge({ module: () => fakeModule });
      await bridge.ready; bridge.create(1); bridge.ctl(1, 0, 5, 1); bridge.load(1, 1);
      document.getElementById('play').onclick = () => setTimeout(() => bridge.ctl(1, bridge.players.get(1).generation, 1, 0), 0);
    });
    await page.waitForFunction(() => bridge.players.get(1).el.readyState >= 2, null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => bridge.players.get(1).el.videoWidth), 640);
    console.log('decoder phase: play');
    await page.click('#play');
    await page.waitForFunction(() => bridge.players.get(1).el.currentTime > 1 && frames.length > 3);
    console.log('decoder phase: seek');
    await page.evaluate(() => bridge.ctl(1, 1, 3, 8));
    await page.waitForFunction(() => bridge.players.get(1).el.currentTime >= 8 && events.some(e => e[2] === 11));
    await page.evaluate(() => bridge.ctl(1, 1, 2, 0));
    assert.equal(await page.evaluate(() => bridge.players.get(1).el.paused), true);
    await page.waitForTimeout(150);
    const framesBeforePausedSeek = await page.evaluate(() => frames.length);
    await page.evaluate(() => {
      bridge.players.get(1).frameBusy = true; // simulate a delayed engine consumer
      setTimeout(() => bridge.frameDone(1, 1), 200);
      bridge.ctl(1, 1, 3, 2);
    });
    await page.waitForFunction(() => events.some(e => e[2] === 11 && Math.abs(e[3] - 2) < .1));
    assert.ok(await page.evaluate(before => frames.length > before, framesBeforePausedSeek), 'paused seek must deliver fresh pixels before reporting completion');
    const state = await page.evaluate(() => ({ stats: bridge.stats, frames, token: bridge.token }));
    assert.ok(state.stats.bytes < 12 * 1024 * 1024, 'must not buffer the >64MiB whole resource');
    assert.ok(requests.every(r => r.length <= 256 * 1024));
    assert.ok(new Set(state.frames.map(f => f.pixel.join(','))).size > 1, 'decoded pixels must change');
    assert.ok(state.stats.droppedFrames > 0, 'one-frame-in-flight backpressure must drop stale frames');
    const ranges = await page.evaluate(async () => {
      const url = `/__bib_media/${bridge.token}/1/1`;
      const read = async range => { const response=await fetch(url,{headers:{Range:range}});return {status:response.status,range:response.headers.get('content-range'),bytes:(await response.arrayBuffer()).byteLength}; };
      return {probe:await read('bytes=0-1'),open:await read('bytes=0-'),suffix:await read('bytes=-32')};
    });
    assert.equal(ranges.probe.bytes, 2);
    assert.equal(ranges.open.bytes, 64 * 1024, 'open-ended ranges must not trigger a whole movie download');
    assert.equal(ranges.suffix.bytes, 32);
    assert.ok(ranges.probe.range.startsWith('bytes 0-1/'));
    assert.ok(ranges.open.range.startsWith('bytes 0-65535/'));
    assert.ok(Object.values(ranges).every(result => result.status === 206));
    console.log('decoder phase: ownership');
    const other = await context.newPage(); await other.goto(`${origin}/media/bridge-test.html`);
    await other.waitForFunction(() => !!navigator.serviceWorker.controller);
    assert.equal(await other.evaluate(async token => (await fetch(`/__bib_media/${token}/1/1`)).status, state.token), 410, 'another tab must not read this player');
    await other.close();
    const navigation = await context.newPage();
    const denied = await navigation.goto(`${origin}/__bib_media/${state.token}/1/1`);
    assert.equal(denied.status(), 410, 'a fresh navigation without the owner client ID must be denied');
    await navigation.close();
    if (browserName === 'chromium') {
      const cdp = await context.newCDPSession(page);
      let version;
      cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => { version = versions.find(v => v.scriptURL.endsWith('/media-gateway-sw.js') && v.status === 'activated')?.versionId || version; });
      await cdp.send('ServiceWorker.enable');
      for (let i = 0; i < 30 && !version; i++) await page.waitForTimeout(100);
      assert.ok(version, 'must identify active media gateway');
      await cdp.send('ServiceWorker.stopWorker', { versionId: version });
      const recovered = await page.evaluate(async () => {
        const response = await fetch(`/__bib_media/${bridge.token}/1/1`, { headers: { Range: 'bytes=0-31' } });
        return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
      });
      assert.deepEqual(recovered, { status: 206, bytes: 32 }, 'gateway must recover after the browser stops its Service Worker');
      await cdp.detach();
    }
    // A WebM source replacement must reject stale metadata/frame callbacks.
    console.log('decoder phase: replace source');
    await page.evaluate(() => { window.filename = 'clip.webm'; bridge.load(1, 2); });
    await page.waitForFunction(() => bridge.players.get(1).el.readyState >= 2);
    assert.equal(await page.evaluate(async () => (await fetch(`/__bib_media/${bridge.token}/1/1`)).status), 410);
    await page.click('#play');
    await page.waitForFunction(() => bridge.players.get(1).el.currentTime > 0.5);
    console.log('decoder phase: shutdown');
    await page.evaluate(() => bridge.shutdown());
    assert.equal(await page.evaluate(() => bridge.players.size), 0);
    assert.equal(await page.evaluate(() => bridge.requests.size), 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ decoder: browserName, bytes: state.stats.bytes, chunks: state.stats.chunks, frames: state.frames.length, droppedFrames: state.stats.droppedFrames, fixture: '>72MiB MP4 and WebM' }));
  } finally { console.log('decoder phase: closing browser'); await browser.close(); }
});
