/* Public program assets only. Website state never enters this cache. */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if(url.origin === self.location.origin && (url.pathname.startsWith('/__bib_media/') || ['/remote-webkit-runner.html','/remote-webkit-setup.html','/media-gateway-sw.js'].includes(url.pathname))) return;
  event.respondWith((async()=>{
    if(url.origin!==self.location.origin || event.request.method!=='GET')return Response.error();
    const cache=await caches.open('wasmhost-webkit-code-v1');
    return await cache.match(url.origin+url.pathname) || new Response('WebKit asset unavailable',{status:404});
  })());
});
self.addEventListener('message', event => {
  if(event.data?.type!=='wasmhost-webkit-retire'||!event.source?.url)return;
  const owner=new URL(event.source.url);
  if(owner.origin!==self.location.origin||owner.pathname!=='/browser.html')return;
  event.waitUntil((async()=>{await caches.delete('wasmhost-webkit-code-v1');await self.registration.unregister();})());
});
