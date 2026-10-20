/* WasmHost embedder adapter. Page renderer adapter; no standalone browser chrome. */
(() => {
  const config = JSON.parse(sessionStorage.getItem('wasmhost-webkit-channel') || 'null');
  sessionStorage.removeItem('wasmhost-webkit-channel');
  if (!config || window.parent === window) return;
  const endpoint = 'wss://wasmhost.invalid/wisp/';

  class PhoneSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    extensions = '';
    protocol = '';
    binaryType = 'arraybuffer';
    onopen = null;
    onclose = null;
    onerror = null;
    onmessage = null;
    constructor(url) {
      super();
      if (String(url) !== endpoint)
        throw new DOMException('Only the paired phone network is available.', 'SecurityError');
      this.url = endpoint;
      const channel = new MessageChannel();
      this.port = channel.port1;
      this.port.onmessage = ({ data }) => {
        if (data?.type === 'open') {
          this.readyState = 1;
          this.fire('open', new Event('open'));
        } else if (data?.type === 'data' && data.bytes instanceof Uint8Array) {
          const bytes = data.bytes;
          this.fire(
            'message',
            new MessageEvent('message', {
              data: this.binaryType === 'blob' ? new Blob([bytes]) : bytes.buffer,
            }),
          );
          if (bytes[0] === 2 && bytes.length >= 5)
            this.port.postMessage({
              type: 'consumed',
              id: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true),
            });
        } else if (data?.type === 'close') this.close();
      };
      parent.postMessage({ type: 'wasmhost-webkit-connect', nonce: config.nonce }, config.origin, [
        channel.port2,
      ]);
    }
    fire(type, event) {
      this.dispatchEvent(event);
      this['on' + type]?.(event);
    }
    send(value) {
      if (this.readyState !== 1)
        throw new DOMException('The phone connection is not open.', 'InvalidStateError');
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : null;
      if (!bytes || bytes.length > 65541) throw new TypeError('Invalid website network packet.');
      this.port.postMessage({ type: 'data', bytes });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.port.postMessage({ type: 'close' });
      this.port.close();
      this.fire('close', new CloseEvent('close', { code: 1000, wasClean: true }));
    }
  }
  window.WebSocket = PhoneSocket;
  const send = (value) => parent.postMessage({ ...value, nonce: config.nonce }, config.origin);
  // The local phone certificate cannot register a service worker in Chrome.
  // MSE and small engine-resolved blob media do not need that gateway. Keep
  // general browsing/YouTube MSE available instead of blocking engine startup.
  window.__WasmHostConfigureMedia = () => {
    const connectMedia = window.BibMediaBridge?.prototype;
    if (connectMedia && window.__WasmHostAssetURL) {
      connectMedia.connectGateway = async function () {};
      connectMedia.load = function (id, generation) {
        const player = this.prepare(id, generation);
        player?.send(8, 4);
        this.log('This direct media stream needs the trusted HTTPS media gateway.');
      };
    }
    window.__WasmHostInstallProfileMedia?.();
  };
  window.__WasmHostBindWebKit = (module, navigate) => {
    module.bibPersist = (json) => {
      if (typeof json !== 'string' || json.length > 8 * 1024 * 1024) return;
      try {
        send({ type: 'wasmhost-webkit-profile', profile: JSON.parse(json) });
      } catch {}
    };
    module.locateFile = (path) => window.__WasmHostAssetURL?.('engine/' + path) ?? path;
    let live = false;
    const onReady = module.onEngineReady,
      onState = module.bibBrowserState,
      onAbort = module.onAbort;
    module.onEngineReady = function () {
      onReady.call(this);
      if (window.__bib?.ready && !__bib.dead) {
        live = true;
        send({ type: 'wasmhost-webkit-ready' });
      }
    };
    module.bibBrowserState = (state) => {
      onState(state);
      send({
        type: 'wasmhost-webkit-info',
        info: {
          url: state.url,
          title: state.title,
          canGoBack: state.back,
          canGoForward: state.forward,
          loading: false,
        },
      });
    };
    module.onAbort = (reason) => {
      live = false;
      onAbort(reason);
      send({
        type: 'wasmhost-package-error',
        error: 'The webpage renderer stopped. Reload to reopen it.',
      });
    };
    window.addEventListener('message', ({ origin, source, data }) => {
      if (
        origin !== config.origin ||
        source !== parent ||
        data?.nonce !== config.nonce ||
        data.type !== 'wasmhost-webkit-command' ||
        !live
      )
        return;
      if (
        data.command === 'navigate' &&
        typeof data.url === 'string' &&
        data.url.length <= 8192 &&
        /^https?:\/\//.test(data.url)
      )
        navigate(data.url);
      if (data.command === 'profile' && data.base && data.next)
        module.ccall(
          'bib_profile_apply',
          null,
          ['string'],
          [JSON.stringify({ base: data.base, next: data.next })],
        );
      if (data.command === 'back') module._bib_navigate(-1);
      if (data.command === 'forward') module._bib_navigate(1);
      if (data.command === 'reload') module._bib_navigate(0);
      // This artifact has no native stop-loading export. Closing the owning
      // streams cancels outstanding network work while retaining the document.
      if (data.command === 'stop') send({ type: 'wasmhost-webkit-network-reset' });
    });
  };
})();
// Retire this engine's public code cache; the shared compressed release cache
// belongs to WasmHost. No website profile is persisted by this host.
addEventListener(
  'pagehide',
  () => navigator.serviceWorker?.controller?.postMessage({ type: 'wasmhost-webkit-retire' }),
  { once: true },
);

/* Real host activation stays inside the renderer, separate from guest JS. */
(() => {
  window.__WasmHostInstallProfileMedia = () => {
    const proto = window.BibMediaBridge?.prototype;
    if (!proto) return;
    const removeIfReady = (bridge) => {
      const audible = [...bridge.players.values()].some(
        (p) => p.playRequested && p.el && !p.el.paused && !p.el.muted && p.el.volume !== 0,
      );
      const blocked = [...bridge.players.values()].some(
        (p) => p.activationBlocked && p.el && p.playRequested && p.el.paused,
      );
      if (!blocked || audible) {
        bridge.activationButton?.remove();
        bridge.activationButton = null;
      }
    };
    proto.play = function (p) {
      const el = p.el;
      if (!el) return;
      el.play()
        .then(() => {
          p.activationBlocked = false;
          removeIfReady(this);
        })
        .catch((e) => {
          if (this.stopped || p.el !== el || e.name === 'AbortError') return;
          if (e.name !== 'NotAllowedError') {
            p.send(15);
            return;
          }
          p.activationBlocked = true;
          if (this.activationButton) return;
          const button = document.createElement('button');
          this.activationButton = button;
          button.textContent = 'Enable media playback';
          Object.assign(button.style, {
            position: 'fixed',
            right: '16px',
            top: '16px',
            zIndex: '10000',
            padding: '10px 14px',
            borderRadius: '20px',
            border: '1px solid #888',
            background: 'rgba(245,245,245,.94)',
            color: '#111',
            cursor: 'pointer',
          });
          button.onclick = () => {
            for (const player of this.players.values())
              if (player.playRequested && player.el) this.play(player);
          };
          document.body.append(button);
        });
    };
    const prepare = proto.prepare;
    proto.prepare = function (...args) {
      const player = prepare.apply(this, args);
      if (player?.el && !player.el.__dnProfileActivation) {
        player.el.__dnProfileActivation = true;
        player.el.addEventListener('playing', () => {
          player.activationBlocked = false;
          removeIfReady(this);
        });
      }
      return player;
    };
    const unload = proto.unload;
    proto.unload = function (p) {
      p.activationBlocked = false;
      const result = unload.call(this, p);
      removeIfReady(this);
      return result;
    };
    const connect = proto.connectGateway;
    proto.connectGateway = function (...args) {
      if (!this.__dnActivate) {
        this.__dnActivate = () => {
          for (const p of this.players.values()) if (p.playRequested && p.el?.paused) this.play(p);
        };
        document.addEventListener('pointerdown', this.__dnActivate, true);
        document.addEventListener('keydown', this.__dnActivate, true);
      }
      return connect.apply(this, args);
    };
    const stop = proto.stop;
    if (stop)
      proto.stop = function (...args) {
        document.removeEventListener('pointerdown', this.__dnActivate, true);
        document.removeEventListener('keydown', this.__dnActivate, true);
        this.activationButton?.remove();
        return stop.apply(this, args);
      };
  };
})();
