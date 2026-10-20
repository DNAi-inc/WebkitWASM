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
