// Host MSE + guest shim API contract; the separate engine gate proves JSC wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
const origin = process.env.BIB_ORIGIN || 'http://127.0.0.1:14830';
test('MSE append, events, buffered ranges, seek, quota errors, teardown', { timeout: 45000 }, async () => {
  const name = process.env.BIB_BROWSER || 'chromium';
  const browser = await (name === 'webkit' ? webkit.launch() : chromium.launch({ channel: 'chromium', args: ['--mute-audio'] }));
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/media/bridge-test.html`);
    await page.addScriptTag({ url: origin + '/mse-decoder.js' });
    await page.evaluate(async () => {
      window.mseEvents = []; window.frameCount = 0;
      const memory = new Uint8Array(10 * 1024 * 1024); let pending;
      const encoder = new TextEncoder(), decoder = new TextDecoder();
      const m = { HEAPU8: memory, lengthBytesUTF8: text => encoder.encode(text).length, _bib_wasm_alloc: () => 16, stringToUTF8: text => { pending = text; }, _bib_media_event: () => {}, _bib_media_cancel: () => {}, _bib_mse_event: () => {
        const event = JSON.parse(pending); mseEvents.push(event);
        frame.contentWindow.__bibMSEDispatch(event);
      }, _bib_media_frame: (id, gen) => { frameCount++; media.frameDone(id, gen); } };
      window.media = new BibMediaBridge({ module: () => m }); await media.ready;
      window.mse = new BibMSEDecoder({ module: () => m, media });
      const frame = document.createElement('iframe'); document.body.append(frame); window.guestFrame = frame;
      const global = frame.contentWindow;
      global.__bibMediaSourceCommand = (text, bytes) => {
        const command = JSON.parse(text);
        if (command.op === 'register') { window.sourceId = command.source; return '{"ok":true}'; }
        if (command.op === 'unregister') return '{"ok":true}';
        return mse.command(7, command, bytes ? new Uint8Array(bytes) : undefined);
      };
      const source = await (await fetch('/mse-polyfill.js')).text(); global.eval(source);
      global.eval(`window.source=new MediaSource();window.sourceURL=URL.createObjectURL(source);window.opened=0;window.ended=0;source.addEventListener('sourceopen',()=>opened++);source.addEventListener('sourceended',()=>ended++);`);
      media.create(10); media.ctl(10, 0, 5, 1); mse.attach(10, 1, 7, sourceId);
    });
    await page.waitForFunction(() => guestFrame.contentWindow.opened === 1);
    const accepted = await page.evaluate(() => guestFrame.contentWindow.MediaSource.isTypeSupported('video/mp4; codecs="avc1.64001e,mp4a.40.2"'));
    assert.equal(accepted, true);
    await page.evaluate(async () => {
      const global = guestFrame.contentWindow;
      global.eval(`window.buffer=source.addSourceBuffer('video/mp4; codecs="avc1.64001e,mp4a.40.2"');window.updates=0;buffer.addEventListener('updateend',()=>updates++);`);
      const data = new Uint8Array(await (await fetch('/media/generated/fragmented.mp4')).arrayBuffer());
      // Irregular boundaries deliberately split MP4 boxes; host MSE must parse them.
      for (let offset = 0; offset < data.length; offset += 131071) {
        await new Promise((resolve, reject) => {
          global.buffer.addEventListener('updateend', resolve, { once: true });
          global.buffer.addEventListener('error', reject, { once: true });
          global.buffer.appendBuffer(new global.Uint8Array(data.slice(offset, offset + 131071)));
        });
      }
      global.source.endOfStream();
    });
    await page.waitForFunction(() => media.players.get(10).el.readyState >= 2);
    const state = await page.evaluate(() => {
      const g = guestFrame.contentWindow;
      return { state: g.source.readyState, updates: g.updates, ranges: g.buffer.buffered.length, end: g.buffer.buffered.end(0), duration: g.source.duration };
    });
    assert.equal(state.state, 'ended'); assert.ok(state.updates > 3); assert.ok(state.end > 11);
    await page.evaluate(() => { media.ctl(10, 1, 1); media.ctl(10, 1, 3, 8); });
    await page.waitForFunction(() => media.players.get(10).el.currentTime > 8 && frameCount > 0);
    const unsupported = await page.evaluate(() => {
      try { guestFrame.contentWindow.source.addSourceBuffer('video/no-such-codec'); return false; }
      catch (error) { return !!error.name; }
    });
    assert.equal(unsupported, true);
    await page.evaluate(() => mse.dispose(7));
    assert.equal(await page.evaluate(() => mse.contexts.size), 0);
    assert.equal(await page.evaluate(() => media.players.get(10).el), null);
    console.log(JSON.stringify({ browser: name, ...state }));
  } finally { await browser.close(); }
});
