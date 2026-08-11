/* BLITZ service worker.
   Deliberately conservative: this runs during a live draft, so a stale
   app shell would be worse than a slow one.
     - hashed build assets  -> cache-first (their names change every deploy)
     - everything else      -> straight to network, never cached
   No API response is ever cached. Draft state must always be live.
*/
const CACHE = 'blitz-assets-v1'

self.addEventListener('install', e => { self.skipWaiting() })

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET') return
  if (url.origin !== self.location.origin) return          // never touch Supabase
  const isHashedAsset = /\/assets\/.+-[A-Za-z0-9_]{8,}\.(js|css)$/.test(url.pathname)
  const isIcon = /\.(png|webmanifest)$/.test(url.pathname)

  if (isHashedAsset || isIcon) {
    e.respondWith((async () => {
      const cached = await caches.match(e.request)
      if (cached) return cached
      const res = await fetch(e.request)
      if (res.ok) (await caches.open(CACHE)).put(e.request, res.clone())
      return res
    })())
  }
  // HTML and everything else: fall through to the network untouched.
})
