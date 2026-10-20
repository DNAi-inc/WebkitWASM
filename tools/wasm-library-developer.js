/*
 * WebKit + WASM test — local library developer tool
 * Copyright (c) 2026 WebKit + WASM test contributors
 * SPDX-License-Identifier: BSD-2-Clause (see ../LICENSE)
 *
 * This is the complete, dependency-free developer file. It makes no network
 * requests and never reads cookies, account data, or application documents.
 * Review this file, then run it as a Chrome DevTools Sources > Snippets snippet
 * on the host's local library-licence page. Do not bypass browser paste warnings.
 * The host must publish a <meta name="wasm-library-cache-v1"> cache descriptor.
 *
 * await WasmLibraryDeveloper.installWisp()   — select the rebuilt client .js
 * await WasmLibraryDeveloper.installEngine() — select embedder.js, embedder.wasm
 *                                             and optional bib-build-config.js
 * await WasmLibraryDeveloper.status()        — inspect selected library hashes
 * await WasmLibraryDeveloper.reset()         — return to supplied libraries
 *
 * Reload only the application pages you want to change after completing an
 * operation. Nothing is reloaded automatically; existing pages stay running.
 * File objects can be passed directly for scripted development/testing:
 * installWisp(file), installEngine([glueFile, wasmFile, optionalConfigFile]).
 * A non-modal developer file chooser appears only after an install command.
 */
(() => {
  'use strict';
  const MiB = 1024 * 1024;
  const names = ['embedder.js', 'embedder.wasm', 'bib-build-config.js'];
  let busy = false;
  function descriptor() {
    if (window.top !== window || !isSecureContext || !globalThis.caches || !crypto.subtle)
      throw Error('Run this tool in the top-level secure local library-licence page.');
    const nodes = document.querySelectorAll('meta[name="wasm-library-cache-v1"]');
    if (nodes.length !== 1) throw Error('This page does not provide the version 1 library cache descriptor. Update the host and open its local library-licence page.');
    const value = JSON.parse(nodes[0].content);
    const path = s => typeof s === 'string' && /^\/(?!\/)[a-zA-Z0-9_./-]+$/.test(s) && !s.includes('..');
    if (value.version !== 1 || typeof value.cacheName !== 'string' || !value.cacheName || value.cacheName.length > 128 ||
        !path(value.entries?.wisp) || !path(value.entries?.engine) || value.entries.wisp === value.entries.engine ||
        !/^[a-zA-Z0-9-]{1,80}$/.test(value.digestHeader))
      throw Error('Unsupported library cache descriptor.');
    return value;
  }
  async function locked(work) {
    if (busy) throw Error('Another library operation is in progress.');
    busy = true;
    try { return await work(descriptor()); } finally { busy = false; }
  }
  function choose(multiple, accept) {
    return new Promise((resolve, reject) => {
      const panel = document.createElement('section');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Library developer file selection');
      panel.style.cssText = 'position:fixed;z-index:2147483647;inset:20% auto auto 50%;transform:translateX(-50%);max-width:90vw;padding:24px;background:#fff;color:#111;border:2px solid #555;border-radius:12px;box-shadow:0 8px 40px #0005;font:16px system-ui';
      const title = document.createElement('p');
      title.textContent = multiple ? 'Select rebuilt embedder.js, embedder.wasm and optional bib-build-config.js.' : 'Select the rebuilt Wisp client JavaScript file.';
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = multiple; input.accept = accept;
      input.setAttribute('aria-label', multiple ? 'Rebuilt engine files' : 'Rebuilt Wisp client');
      const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
      let done = false;
      const finish = (files, error) => {
        if (done) return;
        done = true; panel.remove(); document.removeEventListener('keydown', key);
        if (error) reject(error); else resolve(files);
      };
      const key = event => { if (event.key === 'Escape') finish(null, new DOMException('Selection cancelled.', 'AbortError')); };
      cancel.onclick = () => finish(null, new DOMException('Selection cancelled.', 'AbortError'));
      input.onchange = () => {
        if (input.files?.length) finish(Array.from(input.files));
      };
      panel.append(title, input, cancel); document.body.append(panel);
      document.addEventListener('keydown', key); input.focus();
    });
  }
  async function bytes(file, limit) {
    if (!(file instanceof Blob) || !file.size || file.size > limit) throw Error('Empty or oversized library file.');
    return new Uint8Array(await file.arrayBuffer());
  }
  function javascript(data) {
    if (!new TextDecoder('utf-8', {fatal:true}).decode(data).trim()) throw Error('Empty JavaScript library.');
  }
  async function digest(data) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
  }
  async function save(value, kind, data) {
    const sha256 = await digest(data);
    await (await caches.open(value.cacheName)).put(value.entries[kind], new Response(data, {
      headers: {[value.digestHeader]: sha256, 'Content-Type': kind === 'engine' ? 'application/zip' : 'text/javascript; charset=utf-8'}
    }));
    return {library:kind, bytes:data.length, sha256, message:'Selected locally. Reload only the application pages you want to change.'};
  }
  // ZIP method 8, produced entirely with the browser's own raw-DEFLATE codec.
  // The ZIP contains only the three library paths; no application/host files.
  const crcTable = Uint32Array.from({length:256}, (_, i) => {
    let crc = i; for (let bit=0; bit<8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    return crc >>> 0;
  });
  function crc32(data) {
    let crc = 0xffffffff;
    for (const b of data) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 255];
    return (crc ^ 0xffffffff) >>> 0;
  }
  async function archive(files) {
    if (typeof CompressionStream !== 'function') throw Error('Use a current Chrome version with raw-DEFLATE compression.');
    const chunks = [], central = [];
    let offset = 0, compressedTotal = 0;
    for (const [name, data] of files) {
      let codec;
      try { codec = new CompressionStream('deflate-raw'); }
      catch { throw Error('This browser lacks raw-DEFLATE compression. Use a current Chrome version.'); }
      const compressed = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(codec)).arrayBuffer());
      compressedTotal += compressed.length;
      if (compressedTotal > 160 * MiB - 4096) throw Error('Compressed engine exceeds 160 MiB.');
      const path = new TextEncoder().encode('engine/' + name), crc = crc32(data);
      const local = new Uint8Array(30 + path.length), l = new DataView(local.buffer);
      l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(8, 8, true); l.setUint16(12, 33, true);
      l.setUint32(14, crc, true); l.setUint32(18, compressed.length, true); l.setUint32(22, data.length, true); l.setUint16(26, path.length, true); local.set(path, 30);
      const entry = new Uint8Array(46 + path.length), c = new DataView(entry.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(10, 8, true); c.setUint16(14, 33, true);
      c.setUint32(16, crc, true); c.setUint32(20, compressed.length, true); c.setUint32(24, data.length, true); c.setUint16(28, path.length, true); c.setUint32(42, offset, true); entry.set(path, 46);
      chunks.push(local, compressed); central.push(entry); offset += local.length + compressed.length;
    }
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, central.reduce((n, b) => n + b.length, 0), true); e.setUint32(16, offset, true);
    const result = new Uint8Array(await new Blob([...chunks, ...central, end]).arrayBuffer());
    if (result.length > 160 * MiB) throw Error('Compressed engine exceeds 160 MiB.');
    return result;
  }
  const api = Object.freeze({
    version: 1,
    installWisp(file) {
      return locked(async value => {
        file ??= (await choose(false, '.js,text/javascript'))[0];
        const data = await bytes(file, 4 * MiB); javascript(data);
        return save(value, 'wisp', data);
      });
    },
    installEngine(files) {
      return locked(async value => {
        files ??= await choose(true, '.js,.wasm');
        files = Array.from(files);
        if (files.length < 2 || files.length > 3) throw Error('Select the two engine files and optional build configuration.');
        const seen = new Set(), entries = [];
        let expanded = 0;
        for (const file of files) {
          if (!names.includes(file.name) || seen.has(file.name)) throw Error('Only embedder.js, embedder.wasm and optional bib-build-config.js are accepted, once each.');
          seen.add(file.name);
          const data = await bytes(file, 384 * MiB);
          expanded += data.length;
          if (expanded > 384 * MiB) throw Error('Expanded engine exceeds 384 MiB.');
          if (file.name.endsWith('.wasm')) {
            if ([0,97,115,109,1,0,0,0].some((b,i) => data[i] !== b)) throw Error('Invalid WebAssembly header.');
          } else javascript(data);
          entries.push([file.name, data]);
        }
        if (!seen.has('embedder.js') || !seen.has('embedder.wasm')) throw Error('Both embedder.js and embedder.wasm are required.');
        return save(value, 'engine', await archive(entries));
      });
    },
    status() {
      return locked(async value => {
        const cache = await caches.open(value.cacheName), result = {};
        for (const kind of ['wisp', 'engine']) {
          const saved = await cache.match(value.entries[kind]);
          if (!saved) { result[kind] = {selected:'supplied'}; continue; }
          const data = new Uint8Array(await saved.arrayBuffer()), sha256 = await digest(data);
          result[kind] = {selected:'local', bytes:data.length, sha256, integrity:sha256 === saved.headers.get(value.digestHeader)};
        }
        return result;
      });
    },
    reset() {
      return locked(async value => {
        const cache = await caches.open(value.cacheName);
        for (const kind of ['wisp', 'engine']) await cache.delete(value.entries[kind]);
        return {message:'Supplied libraries selected. Existing pages remain running; reload pages when ready.'};
      });
    }
  });
  globalThis.WasmLibraryDeveloper = api;
  console.info('WebKit + WASM developer tool loaded. Commands: await WasmLibraryDeveloper.installWisp(); await WasmLibraryDeveloper.installEngine(); await WasmLibraryDeveloper.status(); await WasmLibraryDeveloper.reset();');
})();
