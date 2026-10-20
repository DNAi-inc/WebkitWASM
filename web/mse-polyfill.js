// Runs inside JSC before author scripts. Preserve the genuine WebCore video
// element; bridge only MSE controls and append bytes to the host decoder.
(() => {
  const bridge = globalThis.__bibMediaSourceCommand;
  if (typeof bridge !== 'function') return;
  delete globalThis.__bibMediaSourceCommand;
  const identity=Symbol('mediaIdentity'), owner=Symbol('mediaOwner'), state=Symbol('mediaState'), urls=Symbol('mediaURLs'), released=Symbol('mediaReleased'), busy=Symbol('bufferBusy'), removed=Symbol('bufferRemoved'), listItems=Symbol('bufferItems'), handlers=Symbol('mediaHandlers'), token=Symbol('construct');
  const sources = new Map(), objectURLs = new Map(); let nextSource = 0, nextBuffer = 0;
  const rpc = (op, source, buffer, value, extra, bytes) => {
    const result = JSON.parse(bridge(JSON.stringify({ op, source, buffer, value, ...extra }), bytes));
    if (!result.ok) throw new DOMException(result.message || 'Media operation failed', result.name || 'InvalidStateError');
    return result.result;
  };
  const number = value => value === 'Infinity' ? Infinity : value === '-Infinity' ? -Infinity : Number(value);
  class RangeList {
    constructor(ranges) { this.ranges = ranges; }
    get length() { return this.ranges.length; }
    start(i) { if (!Number.isInteger(i) || i < 0 || i >= this.length) throw new DOMException('Range index', 'IndexSizeError'); return this.ranges[i][0]; }
    end(i) { if (!Number.isInteger(i) || i < 0 || i >= this.length) throw new DOMException('Range index', 'IndexSizeError'); return this.ranges[i][1]; }
  }
  class BufferList extends EventTarget {
    constructor(key) { super(); if(key!==token) throw new TypeError('Illegal constructor'); this[listItems] = []; }
    get length() { return this[listItems].length; }
    [Symbol.iterator]() { return this[listItems][Symbol.iterator](); }
    update(items) {
      const old = this[listItems];
      for (let i = 0; i < old.length; i++) delete this[i];
      this[listItems] = items;
      items.forEach((item, i) => Object.defineProperty(this, i, { configurable: true, enumerable: true, value: item }));
      if (old.some(item => !items.includes(item))) queueMicrotask(() => this.dispatchEvent(new Event('removesourcebuffer')));
      if (items.some(item => !old.includes(item))) queueMicrotask(() => this.dispatchEvent(new Event('addsourcebuffer')));
    }
  }
  class SourceBuffer extends EventTarget {
    constructor(source, id, key) { super(); if(key!==token) throw new TypeError('Illegal constructor'); this[owner] = source; this[identity] = id; this[busy] = false; this[removed] = false; }
    check() { if (this[removed]) throw new DOMException('SourceBuffer removed', 'InvalidStateError'); }
    get updating() { return this[busy]; }
    get buffered() { this.check(); return new RangeList(rpc('buffered', this[owner][identity], this[identity])); }
    appendBuffer(data) {
      this.check(); if (this[busy]) throw new DOMException('SourceBuffer updating', 'InvalidStateError');
      let bytes;
      if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else throw new TypeError('appendBuffer needs a BufferSource');
      rpc('append', this[owner][identity], this[identity], undefined, undefined, bytes); this[busy] = true; if (this[owner][state] === 'ended') this[owner][state] = 'open';
    }
    remove(start, end) { this.check(); rpc('remove', this[owner][identity], this[identity], [start, end]); this[busy] = true; if (this[owner][state] === 'ended') this[owner][state] = 'open'; }
    abort() { this.check(); rpc('abort', this[owner][identity], this[identity]); this[busy] = false; }
    changeType(type) { this.check(); rpc('changeType', this[owner][identity], this[identity], String(type)); }
  }
  for (const key of ['mode', 'timestampOffset', 'appendWindowStart', 'appendWindowEnd']) Object.defineProperty(SourceBuffer.prototype, key, {
    get() { this.check(); const value = rpc('property', this[owner][identity], this[identity], undefined, { key }); return key === 'mode' ? value : number(value); },
    set(value) { this.check(); rpc('property', this[owner][identity], this[identity], typeof value === 'number' && !Number.isFinite(value) ? String(value) : value, { key }); },
  });
  class MediaSource extends EventTarget {
    constructor() {
      super(); this[identity] = ++nextSource; this.sourceBuffers = new BufferList(token); this.activeSourceBuffers = new BufferList(token); this[state] = 'closed'; this[urls] = new Set(); this[released] = false;
      rpc('create', this[identity]); sources.set(this[identity], this);
    }
    static isTypeSupported(type) { return rpc('supported', 0, undefined, String(type)); }
    static get canConstructInDedicatedWorker() { return false; }
    get readyState() { return this[state]; }
    get duration() { return number(rpc('duration', this[identity])); }
    set duration(value) { rpc('duration', this[identity], undefined, Number.isFinite(value) ? value : String(value)); }
    addSourceBuffer(type) {
      const id = ++nextBuffer; rpc('add', this[identity], id, String(type));
      const buffer = new SourceBuffer(this, id, token); this.sourceBuffers.update([...this.sourceBuffers, buffer]); return buffer;
    }
    removeSourceBuffer(buffer) {
      if (![...this.sourceBuffers].includes(buffer)) throw new DOMException('Unknown buffer', 'NotFoundError');
      rpc('removeBuffer', this[identity], buffer[identity]); buffer[removed] = true;
      this.sourceBuffers.update([...this.sourceBuffers].filter(b => b !== buffer));
      this.activeSourceBuffers.update([...this.activeSourceBuffers].filter(b => b !== buffer));
    }
    endOfStream(error) { rpc('end', this[identity], undefined, error); this[state] = 'ended'; }
    setLiveSeekableRange(start, end) { rpc('liveRange', this[identity], undefined, [start, end]); }
    clearLiveSeekableRange() { rpc('clearLiveRange', this[identity]); }
  }
  for (const [prototype, name] of [[MediaSource.prototype, 'MediaSource'], [SourceBuffer.prototype, 'SourceBuffer'], [BufferList.prototype, 'SourceBufferList']]) Object.defineProperty(prototype, Symbol.toStringTag, { value: name });
  for (const [prototype, names] of [[MediaSource.prototype, ['sourceopen', 'sourceended', 'sourceclose']], [SourceBuffer.prototype, ['updatestart', 'update', 'updateend', 'error', 'abort']], [BufferList.prototype, ['addsourcebuffer', 'removesourcebuffer']]]) {
    for (const name of names) Object.defineProperty(prototype, 'on' + name, { get() { return this[handlers]?.[name] || null; }, set(handler) { const map=this[handlers] ||= Object.create(null); if (map[name]) this.removeEventListener(name, map[name]); map[name] = typeof handler === 'function' ? handler : null; if (map[name]) this.addEventListener(name, map[name]); } });
  }
  const createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = object => {
    if (!(object instanceof MediaSource)) return createURL(object);
    if (object[released]) { rpc('create', object[identity]); object[released] = false; sources.set(object[identity], object); }
    const type = document.createElement('video').canPlayType('video/mp4') ? 'video/mp4' : 'video/webm';
    const url = createURL(new Blob([], { type })); rpc('register', object[identity], undefined, url); object[urls].add(url); objectURLs.set(url, object); return url;
  };
  URL.revokeObjectURL = url => {
    url = String(url);
    const object = objectURLs.get(url); if (object) { rpc('unregister', 0, undefined, url); object[urls].delete(url); objectURLs.delete(url); }
    revokeURL(url);
  };
  Object.defineProperty(globalThis, '__bibMSEDispatch', { value: event => {
    const source = sources.get(event.source); if (!source) return;
    source[state] = event.state;
    source.activeSourceBuffers.update([...source.sourceBuffers].filter(b => event.active.includes(b[identity])));
    const target = event.target ? [...source.sourceBuffers].find(b => b[identity] === event.target) : source;
    if (!target) return;
    if (event.target && ['updateend', 'error', 'abort'].includes(event.name)) target[busy] = false;
    if (event.name === 'sourceclose') {
      for (const buffer of source.sourceBuffers) buffer[removed] = true;
      source.sourceBuffers.update([]); source.activeSourceBuffers.update([]);
    }
    target.dispatchEvent(new Event(event.name));
    if (event.name === 'sourceclose' && !source[urls].size) {
      rpc('release', source[identity]); source[released] = true; sources.delete(source[identity]);
    }
  } });
  Object.defineProperties(globalThis, { MediaSource: { configurable: true, writable: true, value: MediaSource }, SourceBuffer: { configurable: true, writable: true, value: SourceBuffer }, SourceBufferList: { configurable: true, writable: true, value: BufferList } });
})();
