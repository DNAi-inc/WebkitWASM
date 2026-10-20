// MediaSource lives in the host decoder; fetch/XHR remains inside WebCore.
// Only whitelisted operations are accepted; no host eval or website URL fetch.
(() => {
  const serial = value => JSON.stringify(value, (_, item) => typeof item === 'number' && !Number.isFinite(item) ? String(item) : item);
  const ranges = value => Array.from({ length: value.length }, (_, i) => [value.start(i), value.end(i)]);
  class BibMSEDecoder {
    constructor({ module, media }) { this.module = module; this.media = media; this.contexts = new Map(); }
    context(id) { let c = this.contexts.get(id); if (!c) { c = new Map(); this.contexts.set(id, c); } return c; }
    send(context, source, target, name, expectedMedia) {
      if (this.media.stopped) return;
      const c = this.contexts.get(context), entry = c?.get(source); if (!entry || (expectedMedia && entry.media !== expectedMedia)) return;
      if (name === 'updateend') for (const p of this.media.players.values()) if (p.el?.src === entry.url) p.ranges?.();
      const payload = { source, target, name, state: entry.media.readyState, active: entry.buffers.filter(b => [...entry.media.activeSourceBuffers].includes(b.buffer)).map(b => b.id) };
      const text = serial(payload), m = this.module(); if (!m?._bib_mse_event) return;
      const length = m.lengthBytesUTF8(text) + 1, pointer = m._bib_wasm_alloc(length); if (!pointer) return;
      m.bibSyncMemoryViews?.();
      m.stringToUTF8(text, pointer, length);
      try { m._bib_mse_event(context, pointer); } catch (error) { m.onAbort?.(error.message); }
    }
    command(context, raw, bytes) {
      try {
        if (this.media.stopped) throw new DOMException('Engine stopped', 'InvalidStateError');
        const command = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const { op, source, buffer, value } = command;
        if (op === 'supported') return serial({ ok: true, result: !!window.MediaSource?.isTypeSupported(value) });
        if (op === 'dispose') { this.dispose(context); return serial({ ok: true }); }
        const c = this.context(context);
        if (op === 'create') {
          if (c.size >= 8 || c.has(source)) throw new DOMException('MediaSource limit', 'QuotaExceededError');
          const media = new MediaSource(), entry = { media, buffers: [], url: null }; c.set(source, entry);
          for (const name of ['sourceopen', 'sourceended', 'sourceclose']) media.addEventListener(name, () => this.send(context, source, 0, name, media));
          return serial({ ok: true });
        }
        const entry = c.get(source); if (!entry) throw new DOMException('MediaSource closed', 'InvalidStateError');
        const media = entry.media;
        const item = buffer == null ? null : entry.buffers.find(b => b.id === buffer);
        const sb = item?.buffer;
        let result;
        switch (op) {
          case 'release':
            if (media.readyState !== 'closed') throw new DOMException('MediaSource attached', 'InvalidStateError');
            if (entry.url) URL.revokeObjectURL(entry.url); c.delete(source); break;
          case 'add': {
            if (entry.buffers.length >= 4) throw new DOMException('SourceBuffer limit', 'QuotaExceededError');
            if (entry.buffers.some(b => b.id === buffer)) throw new DOMException('Duplicate buffer', 'InvalidStateError');
            const newBuffer = media.addSourceBuffer(value); entry.buffers.push({ id: buffer, buffer: newBuffer });
            for (const name of ['updatestart', 'update', 'updateend', 'error', 'abort']) newBuffer.addEventListener(name, () => this.send(context, source, buffer, name, media));
            break;
          }
          case 'removeBuffer': media.removeSourceBuffer(sb); entry.buffers = entry.buffers.filter(b => b.id !== buffer); break;
          case 'duration': if (value !== undefined) media.duration = Number(value); result = media.duration; break;
          case 'end': value ? media.endOfStream(value) : media.endOfStream(); break;
          case 'liveRange': media.setLiveSeekableRange(value[0], value[1]); break;
          case 'clearLiveRange': media.clearLiveSeekableRange(); break;
          case 'append':
            if (!sb || !(bytes instanceof Uint8Array) || bytes.length > 16 * 1024 * 1024) throw new DOMException('Append unavailable', 'QuotaExceededError');
            sb.appendBuffer(bytes); break;
          case 'remove': sb.remove(value[0], value[1]); break;
          case 'abort': sb.abort(); break;
          case 'changeType': sb.changeType(value); break;
          case 'buffered': result = ranges(sb.buffered); break;
          case 'property': {
            if (!['mode', 'timestampOffset', 'appendWindowStart', 'appendWindowEnd'].includes(command.key)) throw new TypeError('Unknown SourceBuffer property');
            if (value !== undefined) sb[command.key] = command.key === 'mode' ? value : Number(value);
            result = sb[command.key]; break;
          }
          default: throw new TypeError('Unknown media operation');
        }
        return serial({ ok: true, result });
      } catch (error) { return serial({ ok: false, name: error.name || 'InvalidStateError', message: error.message }); }
    }
    attach(id, generation, context, source) {
      const entry = this.contexts.get(context)?.get(source); if (!entry) return;
      const p = this.media.prepare(id, generation); if (!p) return;
      if (entry.url) URL.revokeObjectURL(entry.url);
      entry.url = URL.createObjectURL(entry.media); p.el.src = entry.url; p.el.load();
      if (p.playRequested) this.media.play(p);
    }
    disposeAll() { for (const context of [...this.contexts.keys()]) this.dispose(context); }
    dispose(context) {
      const c = this.contexts.get(context); if (!c) return;
      this.contexts.delete(context);
      for (const entry of c.values()) if (entry.url) {
        for (const p of this.media.players.values()) if (p.el?.src === entry.url) this.media.unload(p);
        URL.revokeObjectURL(entry.url);
      }
    }
  }
  window.BibMSEDecoder = BibMSEDecoder;
})();
