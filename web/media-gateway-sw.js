/* Local decoder gateway, NOT a network proxy. Only the owning WebCore instance
 * can resolve registered player IDs; no remote URLs or cookies cross this API. */
const sessions = new Map();
const pending = new Map();
let nextRequest = 0;
// Small partial responses prevent the host decoder from racing far ahead.
const CHUNK = 64 * 1024;
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
function attach(token, clientId, port) {
  const session = { clientId, port }; sessions.set(token, session);
  port.onmessage = ({ data }) => {
    const entry = pending.get(data.request); if (!entry || entry.port !== port) return;
    pending.delete(data.request); clearTimeout(entry.timer);
    if (data.error) entry.resolve({ info: { status: 410 }, bytes: new Uint8Array(0) }); else entry.resolve(data);
  };
  port.postMessage({ type: 'ready' }); return session;
}
self.addEventListener('message', event => {
  const { type, token } = event.data || {};
  if (type !== 'bib-media-connect' || !/^[a-f0-9-]{36}$/.test(token) || !event.source?.id || !event.ports[0]) return;
  attach(token, event.source.id, event.ports[0]);
});
async function recover(token, clientId) {
  const client = clientId && await self.clients.get(clientId); if (!client) return null;
  // Service Workers may be stopped between requests. Reattach only if this
  // live owning page recognizes the unguessable token; no global persistence.
  const channel = new MessageChannel();
  return new Promise(resolve => {
    const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 3000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      if (data?.type !== 'attach') { channel.port1.close(); resolve(null); return; }
      resolve(attach(token, clientId, channel.port1));
    };
    client.postMessage({ type: 'bib-media-recover', token }, [channel.port2]);
  });
}
function requestChunk(session, id, generation, offset, length, signal) {
  return new Promise((resolve, reject) => {
    const request = ++nextRequest;
    const finish = (f, value) => { signal?.removeEventListener('abort', abort); f(value); };
    const abort = () => {
      const entry = pending.get(request); if (!entry) return;
      clearTimeout(entry.timer); pending.delete(request);
      session.port.postMessage({ type: 'cancel', request }); finish(resolve, { info: { status: 499 }, bytes: new Uint8Array(0) });
    };
    const timer = setTimeout(abort, 30000);
    pending.set(request, { port: session.port, timer, resolve: v => finish(resolve, v), reject: e => finish(reject, e) });
    signal?.addEventListener('abort', abort, { once: true });
    session.port.postMessage({ type: 'read', id, generation, request, offset, length });
    if (signal?.aborted) abort();
  });
}
async function serve(event, match) {
  const [, token, player, gen] = match;
  const session = sessions.get(token) || await recover(token, event.clientId);
  if (!session || event.clientId !== session.clientId)
    return new Response('Media session expired', { status: 410 });
  if (!await self.clients.get(session.clientId)) {
    sessions.delete(token); return new Response('Media session expired', { status: 410 });
  }
  if (!['GET', 'HEAD'].includes(event.request.method)) return new Response(null, { status: 405 });
  const rangeHeader = event.request.headers.get('Range');
  const range = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (rangeHeader && (!range || (!range[1] && !range[2]))) return new Response(null, { status: 416 });
  const controller = new AbortController();
  event.request.signal.addEventListener('abort', () => controller.abort(), { once: true });
  let start = range?.[1] ? Number(range[1]) : 0;
  let first;
  const read = (offset, length) => requestChunk(session, +player, +gen, offset, length, controller.signal);
  try {
    const requestedEnd = range?.[1] && range[2] ? Number(range[2]) : null;
    if (!Number.isSafeInteger(start) || (requestedEnd !== null && (!Number.isSafeInteger(requestedEnd) || requestedEnd < start))) return new Response(null, { status: 416 });
    // Honor tiny decoder probes and discover suffix/HEAD metadata with one byte.
    const initialLength = event.request.method === 'HEAD' || (range && !range[1]) ? 1 : requestedEnd !== null ? Math.min(CHUNK, requestedEnd - start + 1) : CHUNK;
    first = await read(start, initialLength);
    const { status, total, mime, offset } = first.info;
    if (![200, 206].includes(status) || !Number.isSafeInteger(total) || total < 1 || offset !== start)
      return new Response('Media server did not provide a bounded range', { status: status === 410 ? 410 : 502 });
    if (range && !range[1]) { start = Math.max(0, total - Number(range[2])); first = await read(start, Math.min(CHUNK, total - start)); }
    // RFC 9110 15.3.7 permits partial fulfillment. Do not turn a decoder's
    // open-ended range into an eager download of the entire movie.
    const end = Math.min(total - 1, requestedEnd ?? total - 1, range ? start + CHUNK - 1 : total - 1);
    if (!Number.isSafeInteger(start) || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
    const headers = { 'Content-Type': mime || 'application/octet-stream', 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin' };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    if (event.request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
    let position = start, initial = first;
    const stream = new ReadableStream({
      async pull(target) {
        try {
          const result = initial || await read(position, Math.min(CHUNK, end - position + 1)); initial = null;
          if (controller.signal.aborted) return;
          if ([410, 499].includes(result.info.status)) { target.close(); return; }
          if (![200, 206].includes(result.info.status) || result.info.offset !== position || result.info.total !== total || !result.bytes?.length) throw new Error('Invalid media range');
          const bytes = result.bytes.subarray(0, end - position + 1);
          position += bytes.length; target.enqueue(bytes);
          if (position > end) target.close();
        } catch (e) { controller.abort(); target.error(e); }
      },
      cancel() { controller.abort(); },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: range ? 206 : 200, headers });
  } catch { controller.abort(); return new Response('Media request failed', { status: 502 }); }
}
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/__bib_media/')) return;
  const match = /^\/__bib_media\/([a-f0-9-]{36})\/(\d+)\/(\d+)$/.exec(url.pathname);
  event.respondWith(match ? serve(event, match) : new Response(null, { status: 404 }));
});
