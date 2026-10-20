/* Host decoder for WebCore's media engine. Website URLs NEVER reach host fetch:
 * only engine-issued, cookie/CSP-aware range requests feed the decoder gateway.
 * Video frames go back into WebCore painting, so page clipping/z-order still work.
 */
(() => {
  const CHUNK = 256 * 1024;
  class BibMediaBridge {
    constructor({ module, log = console.log, enabled = true }) {
      this.module = module; this.log = log; this.stopped = !enabled;
      this.players = new Map(); this.requests = new Map(); this.nextRequest = 0;
      this.token = crypto.randomUUID();
      navigator.serviceWorker?.addEventListener('message', event => {
        if (event.data?.type !== 'bib-media-recover' || !event.ports[0]) return;
        if (this.stopped) { event.ports[0].postMessage({ type: 'reject' }); return; }
        if (event.data.token !== this.token) { event.ports[0].postMessage({ type: 'reject' }); return; }
        const port = event.ports[0]; this.port = port;
        port.onmessage = ({ data }) => this.onGatewayRequest(data, port);
        port.postMessage({ type: 'attach' });
      });
      this.ready = enabled ? this.connectGateway() : Promise.resolve();
      this.stats = { bytes: 0, chunks: 0, frames: 0, droppedFrames: 0 };
    }
    async connectGateway() {
      if (!('serviceWorker' in navigator)) throw new Error('Media streaming needs a secure localhost or HTTPS origin');
      await navigator.serviceWorker.register('/media-gateway-sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Media gateway did not claim this tab')), 10000);
          navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
      const channel = new MessageChannel(); const port = channel.port1; this.port = port;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Media gateway handshake timed out')), 10000);
        port.onmessage = ({ data }) => {
          if (data.type === 'ready') { clearTimeout(timer); resolve(); }
          else this.onGatewayRequest(data, port);
        };
        navigator.serviceWorker.controller.postMessage({ type: 'bib-media-connect', token: this.token }, [channel.port2]);
      });
    }
    canPlay(type) {
      const answer = document.createElement('video').canPlayType(type);
      return answer === 'probably' ? 2 : answer === 'maybe' ? 1 : 0;
    }
    create(id) { if (this.stopped) return; this.players.set(id, { id, generation: 0, el: null, frameBusy: false, width: 640, height: 360, volume: 1, muted: false, rate: 1, playRequested: false, seek: null, preload: 'auto' }); }
    unload(p) {
      clearTimeout(p.captureTimer); p.captureTimer = null; p.framePending = false; p.seekedPending = false;
      if (!p.el) return;
      if (p.frameCallback && p.el.cancelVideoFrameCallback) p.el.cancelVideoFrameCallback(p.frameCallback);
      cancelAnimationFrame(p.animationFrame);
      p.el.pause(); p.el.removeAttribute('src'); p.el.load(); p.el.remove(); p.el = null;
      if (p.url) URL.revokeObjectURL(p.url); p.url = null;
      for (const [request, entry] of this.requests) if (entry.id === p.id) this.cancelRequest(request);
    }
    prepare(id, generation) {
      if (this.stopped) return null;
      const p = this.players.get(id); if (!p) return null;
      if (generation < p.generation) return null;
      if (generation !== p.generation) { p.playRequested = false; p.seek = null; }
      this.unload(p); p.generation = generation; p.frameBusy = false; p.lastFrame = -1; p.lastCapture = 0; p.bridgeDrops = 0;
      const el = document.createElement('video'); p.el = el;
      el.preload = p.preload; el.playsInline = true;
      el.volume = p.volume; el.muted = p.muted; try { el.playbackRate = p.rate; } catch { p.rate = el.playbackRate; }
      // Keep decoder alive without an overlay over the guest canvas. The actual
      // displayed frame is composed by WebCore, including transforms and occlusion.
      Object.assign(el.style, { position: 'fixed', left: '-2px', top: '-2px', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
      el.setAttribute('aria-hidden', 'true'); el.tabIndex = -1; document.body.append(el);
      const send = (code, a = 0, b = 0) => {
        if (this.stopped || p.el !== el || p.generation !== generation) return;
        try { this.module()?._bib_media_event(id, generation, code, a, b); } catch (error) { this.module()?.onAbort?.(error.message); }
      };
      p.send = send;
      el.addEventListener('loadedmetadata', () => { send(1, el.duration); send(12, el.videoWidth, el.videoHeight); if (p.seek != null) el.currentTime = p.seek; });
      for (const [name, code] of [['canplay', 2], ['canplaythrough', 3], ['playing', 4], ['pause', 5], ['waiting', 13]])
        el.addEventListener(name, () => { if (name === 'playing' || name === 'pause' || name === 'waiting') send(6, el.currentTime); send(code); });
      el.addEventListener('timeupdate', () => send(6, el.currentTime));
      el.addEventListener('ended', () => send(7, el.currentTime));
      el.addEventListener('error', () => send(8, el.error?.code || 2));
      el.addEventListener('durationchange', () => send(9, el.duration));
      el.addEventListener('ratechange', () => send(16, el.playbackRate));
      p.quality = () => {
        const quality = el.getVideoPlaybackQuality?.();
        if (quality) send(17, quality.totalVideoFrames, Math.min(quality.totalVideoFrames, quality.droppedVideoFrames + p.bridgeDrops));
      };
      el.addEventListener('timeupdate', p.quality);
      const ranges = () => {
        send(14); for (let i = 0; i < el.buffered.length; ++i) send(10, el.buffered.start(i), el.buffered.end(i));
      };
      p.ranges = ranges;
      for (const name of ['progress', 'loadeddata', 'canplay', 'timeupdate', 'seeked']) el.addEventListener(name, ranges);
      el.addEventListener('seeked', () => {
        if (p.el !== el || p.generation !== generation) return;
        if (!el.videoWidth) { send(11, el.currentTime); return; }
        p.seekedPending = true; this.captureFrame(p, el, generation);
      });
      el.addEventListener('loadeddata', () => { send(18); this.captureFrame(p, el, generation); });
      const frame = () => {
        if (p.el !== el || p.generation !== generation) return;
        this.captureFrame(p, el, generation);
        if (el.requestVideoFrameCallback) p.frameCallback = el.requestVideoFrameCallback(frame);
        else p.animationFrame = requestAnimationFrame(frame);
      };
      frame(); return p;
    }
    load(id, generation) {
      const p = this.prepare(id, generation); if (!p) return;
      p.el.src = `/__bib_media/${this.token}/${id}/${generation}`; p.el.load();
      if (p.playRequested) this.play(p);
    }
    loadBytes(id, generation, bytes, mime) {
      // Small data:/blob: sources use their engine-resolved bytes; never an
      // author-provided URL in the host realm.
      const p = this.prepare(id, generation); if (!p) return;
      p.url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
      p.el.src = p.url; p.el.load();
      if (p.playRequested) this.play(p);
    }
    ctl(id, generation, op, a) {
      const p = this.players.get(id); if (!p || generation < p.generation) return;
      if (generation !== p.generation) { this.unload(p); p.generation = generation; p.playRequested = false; p.seek = null; }
      if (op === 1) p.playRequested = true;
      if (op === 2 || op === 7) p.playRequested = false;
      if (op === 3) { p.seek = Math.max(0, a); p.seekedPending = false; }
      if (op === 4) p.volume = Math.min(1, Math.max(0, a));
      if (op === 5) p.muted = !!a;
      if (op === 6 && Number.isFinite(a)) p.rate = a;
      if (op === 8) p.preload = ['none', 'metadata', 'auto'][a] || 'metadata';
      const el = p.el; if (!el) return;
      switch (op) {
        case 1: this.play(p); break;
        case 2: el.pause(); break;
        case 3: try { el.currentTime = Math.max(0, a); } catch {} break;
        case 4: el.volume = Math.min(1, Math.max(0, a)); break;
        case 5: el.muted = !!a; break;
        case 6: try { el.playbackRate = a; } catch { p.rate = el.playbackRate; p.send(16, el.playbackRate); } break;
        case 7: this.unload(p); break;
        case 8: el.preload = p.preload; break;
      }
    }
    play(p) {
      p.el.play().catch(e => {
        if (this.stopped || !p.el) return;
        if (e.name === 'AbortError') return;
        this.log(`Playback blocked: ${e.name}`); p.send(15);
        // A user gesture inside a WASM worker is not a host activation. Keep
        // an explicit accessible retry for browsers that require one.
        if (e.name === 'NotAllowedError' && !this.activationButton) {
          const button = document.createElement('button'); this.activationButton = button;
          button.textContent = 'Enable media playback';
          Object.assign(button.style, { position: 'fixed', right: '16px', top: '70px', zIndex: '10000', padding: '12px' });
          button.onclick = () => {
            button.remove(); this.activationButton = null;
            for (const player of this.players.values()) if (player.playRequested && player.el) player.el.play().catch(() => {});
          };
          document.body.append(button);
        }
      });
    }
    resize(id, generation, width, height) {
      const p = this.players.get(id); if (!p || p.generation !== generation) return;
      p.width = width; p.height = height;
    }
    deliverSeeked(p, el) {
      if (p.seekedPending) { p.seekedPending = false; p.send(11, el.currentTime); }
    }
    captureFrame(p, el, generation) {
      // A hidden video can still feed a page canvas or frame callbacks. Keep
      // those semantics; bound cost with frame credit, size and rate instead.
      if (this.stopped || p.el !== el || p.generation !== generation || !el.videoWidth || el.readyState < 2 || el.seeking) return;
      if (p.lastFrame === el.currentTime) { this.deliverSeeked(p, el); return; }
      if (p.frameBusy) { p.framePending = true; this.stats.droppedFrames++; p.bridgeDrops++; return; }
      const captureAt = performance.now();
      const delay = 1000 / 30 - (captureAt - (p.lastCapture || 0));
      if (delay > 0) {
        if (!p.captureTimer) p.captureTimer = setTimeout(() => {
          p.captureTimer = null; this.captureFrame(p, el, generation);
        }, Math.ceil(delay));
        this.stats.droppedFrames++; p.bridgeDrops++; return;
      }
      // Preserve source detail for video-to-canvas consumers, even when the
      // visible player is small. Only the explicit HD delivery ceiling scales.
      const scale = Math.min(1, 1920 / el.videoWidth, 1080 / el.videoHeight);
      const width = Math.max(1, Math.round(el.videoWidth * scale));
      const height = Math.max(1, Math.round(el.videoHeight * scale));
      const canvas = p.canvas ||= document.createElement('canvas');
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const context = p.context ||= canvas.getContext('2d', { willReadFrequently: true });
      let allocation = 0;
      try {
        context.drawImage(el, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height).data;
        const m = this.module(); const pointer = m._bib_wasm_alloc(pixels.length); allocation = pointer;
        if (!pointer) return;
        m.bibSyncMemoryViews?.();
        m.HEAPU8.set(pixels, pointer);
        p.frameBusy = true; p.lastFrame = el.currentTime; p.lastCapture = captureAt;
        m._bib_media_frame(p.id, generation, pointer, width, height, el.currentTime); allocation = 0;
        this.deliverSeeked(p, el); p.quality();
        this.stats.frames++;
      } catch (e) {
        if (e instanceof WebAssembly.RuntimeError) this.module()?.onAbort?.(e.message);
        if (allocation && !this.stopped) { try { this.module()?._bib_wasm_free(allocation); } catch {} }
        p.frameBusy = false; this.log(`Video frame: ${e.name}`);
      }
    }
    frameDone(id, generation) {
      const p = this.players.get(id); if (p?.generation !== generation) return;
      p.frameBusy = false;
      if (p.framePending && p.el) { p.framePending = false; this.captureFrame(p, p.el, generation); }
    }
    onGatewayRequest(data, port = this.port) {
      if (data.type === 'ready') return;
      if (data.type === 'cancel') {
        for (const [id, entry] of this.requests) if (entry.port === port && entry.wireRequest === data.request) this.cancelRequest(id);
        return;
      }
      const { id, generation, request, offset, length } = data;
      const p = this.players.get(id);
      if (!p || p.generation !== generation || !Number.isSafeInteger(offset) || offset < 0 || length > CHUNK || length < 1 || this.requests.size >= 8) {
        port.postMessage({ request, error: 'Media source unavailable' }); return;
      }
      // Transport IDs restart when a Service Worker restarts. Native IDs stay
      // unique for this page so a late reply cannot satisfy a different read.
      const nativeRequest = ++this.nextRequest;
      const timer = setTimeout(() => this.cancelRequest(nativeRequest, 'Media request timed out'), 30000);
      this.requests.set(nativeRequest, { id, generation, timer, port, wireRequest: request });
      this.module()._bib_media_request(id, generation, nativeRequest, offset, length);
    }
    chunk(request, info, bytes) {
      const entry = this.requests.get(request); if (!entry) return;
      clearTimeout(entry.timer); this.requests.delete(request);
      this.stats.bytes += bytes.byteLength; this.stats.chunks++;
      entry.port.postMessage({ request: entry.wireRequest, info, bytes }, [bytes.buffer]);
    }
    cancelRequest(request, error = 'Media request cancelled') {
      const entry = this.requests.get(request); if (!entry) return;
      clearTimeout(entry.timer); this.requests.delete(request);
      if (!this.stopped) { try { this.module()?._bib_media_cancel(entry.id, entry.generation, request); } catch {} }
      entry.port.postMessage({ request: entry.wireRequest, error });
    }
    shutdown() {
      this.stopped = true;
      for (const id of [...this.players.keys()]) this.destroy(id);
      for (const request of [...this.requests.keys()]) this.cancelRequest(request);
      this.activationButton?.remove(); this.activationButton = null;
    }
    destroy(id) { const p = this.players.get(id); if (!p) return; this.unload(p); this.players.delete(id); }
  }
  window.BibMediaBridge = BibMediaBridge;
})();
