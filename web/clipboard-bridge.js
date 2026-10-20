/* User-initiated plain-text clipboard for the native engine. The host starts
 * Clipboard API calls in the original key gesture, before worker round trips.
 * Cut acknowledges the OS write directly through atomics, never via the blocked
 * engine queue. No arbitrary guest script gets host clipboard privileges. */
(() => {
  const MAX_BYTES = 4 * 1024 * 1024;
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    // A native error may precede the consumer attaching its handler.
    promise.catch(() => {});
    return { promise, resolve, reject };
  };
  class ClipboardBridge {
    constructor({ module, canvas, report, clipboard = () => navigator.clipboard }) {
      Object.assign(this, { module, canvas, report, clipboard });
      this.sequence = 0; this.pending = null;
    }
    event(identifier, event, text) {
      const state = this.pending;
      if (!state || state.identifier !== identifier) return;
      if (event === 'text') {
        state.payload.resolve(text);
        if (state.writeResult) this.completeWrite(state, state.writeResult === 1);
      } else if (event === 'error') {
        state.payload.reject(new Error(text)); state.done.reject(new Error(text));
      } else if (event === 'done') state.done.resolve();
    }
    completeWrite(state, success) {
      state.writeResult = success ? 1 : 2;
      this.module._bib_clipboard_write_complete(state.identifier, success ? 1 : 0);
    }
    send(kind, state, text = '') {
      if (!this.module.ccall('bib_clipboard', 'number', ['number', 'number', 'string'], [kind, state.identifier, text]))
        throw new Error('Clipboard engine is unavailable');
    }
    async perform(action) {
      if (typeof this.module._bib_clipboard !== 'function' || typeof this.module._bib_clipboard_write_complete !== 'function') {
        this.report('Clipboard requires the updated engine'); return false;
      }
      if (this.pending) { this.report('A clipboard operation is already pending'); return false; }
      const state = { identifier: this.sequence = this.sequence % 0x7fffffff + 1, payload: deferred(), done: deferred(), writeResult: 0 };
      this.pending = state;
      let write;
      try {
        const clipboard = this.clipboard();
        if (!clipboard || typeof clipboard[action === 'paste' ? 'readText' : 'write'] !== 'function' || (action !== 'paste' && typeof ClipboardItem !== 'function'))
          throw new Error('This browser does not support clipboard access');
        if (action === 'paste') {
          // Start the browser permission operation inside the user gesture.
          const read = clipboard.readText();
          this.send(2, state);
          const text = await read;
          if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error('Clipboard text is too large');
          if (document.activeElement !== this.canvas || document.hidden) throw new Error('Paste cancelled: browser focus changed');
          this.send(3, state, text);
          await state.done.promise;
        } else {
          const data = state.payload.promise.then(text => new Blob([text], { type: 'text/plain' }));
          write = clipboard.write([new ClipboardItem({ 'text/plain': data })]);
          write = Promise.resolve(write).then(() => this.completeWrite(state, true), error => {
            this.completeWrite(state, false); throw error;
          });
          write.catch(() => {});
          this.send(action === 'cut' ? 1 : 0, state);
          const results = await Promise.allSettled([write, state.done.promise]);
          const failure = results.find(result => result.status === 'rejected');
          if (failure) throw failure.reason;
        }
        this.report(action === 'paste' ? 'Pasted' : action === 'cut' ? 'Cut' : 'Copied');
        return true;
      } catch (error) {
        state.payload.reject(error);
        this.completeWrite(state, false);
        if (action === 'paste') { try { this.send(4, state); } catch {} }
        this.report(error?.message || 'Clipboard unavailable');
        return false;
      } finally {
        if (this.pending === state) this.pending = null;
      }
    }
  }
  globalThis.BibClipboardBridge = ClipboardBridge;
})();
