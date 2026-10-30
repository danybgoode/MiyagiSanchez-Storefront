/* Web push service worker for messaging notifications.
   TODO: add a 192x192 PNG at /icon-192.png for a crisper notification icon. */

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (e) {
    data = {}
  }
  const title = data.title || 'Miyagi Sánchez'
  const options = {
    body: data.body || '',
    icon: data.icon || '/favicon.svg',
    badge: '/favicon.svg',
    data: { url: data.url || '/messages' },
    tag: data.tag,
    renotify: Boolean(data.tag),
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/messages'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          if ('navigate' in client) client.navigate(url)
          return client.focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})

/* Counter offline support (in-person-sales S3.1, D11). Network first with a cached fallback,
   and ONLY for the counter page and the same-origin GETs that page makes. The decision lives in
   counter-scope.js; any request it rejects returns here without respondWith, so every other
   navigation and request is exactly as it was. The page that made a subresource request is read
   from the request referrer (synchronous: respondWith cannot wait for clients.get, and calling
   it for every request would put the worker in front of the whole site). */
importScripts('/counter-scope.js')
const COUNTER_CACHE = 'ms-counter-v1'

self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (!self.shouldHandleCounterRequest(req.url, req.referrer, req.mode, self.location.origin, req.method)) return
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone()
          event.waitUntil(caches.open(COUNTER_CACHE).then((c) => c.put(req, copy)).catch(() => {}))
        }
        return res
      })
      .catch(() => caches.match(req).then((hit) => hit || Response.error())),
  )
})
