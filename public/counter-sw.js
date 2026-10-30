/* The counter's OWN service worker (in-person-sales S3.1). Registered from the counter page with
   scope /shop/manage/en-persona, so no other page on the site is ever controlled by it; the site
   wide /sw.js stays push-only. Network first with a cached fallback so the counter opens with no
   signal. What may be answered or cached is decided by counter-scope.js alone. */
importScripts('/counter-scope.js')

// Bump on each deploy that changes the counter's assets; activate deletes every other version.
const CACHE = 'ms-counter-v2'
const PAGE = '/shop/manage/en-persona'

self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith('ms-counter-') && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (!self.shouldHandleCounterRequest(req.url, req.referrer, req.mode, self.location.origin, req.method)) return
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone()
          event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}))
        }
        return res
      })
      .catch(() => caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then((hit) => hit || Response.error())),
  )
})

// First visit works offline: the page tells us what it loaded; we cache what the scope allows.
self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'precache' || !Array.isArray(data.urls) || typeof data.page !== 'string') return
  const origin = self.location.origin
  let page
  try { page = new URL(data.page, origin) } catch { return }
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        data.urls.slice(0, 200).map((raw) => {
          let u
          try { u = new URL(raw, origin) } catch { return null }
          const mode = u.pathname === PAGE || u.pathname === PAGE + '/' ? 'navigate' : 'no-cors'
          if (!self.shouldHandleCounterRequest(u.href, page.href, mode, origin, 'GET')) return null
          return fetch(u.href, { credentials: 'same-origin' }).then((r) => (r.ok ? cache.put(u.href, r) : null)).catch(() => null)
        }),
      ),
    ),
  )
})
