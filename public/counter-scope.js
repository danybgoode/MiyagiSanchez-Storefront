/* Which requests the counter's own service worker (counter-sw.js) may answer (in-person-sales
   S3.1, D11). Plain script on purpose: the worker loads it with importScripts and the api spec
   evaluates it directly, so the decision under test is the decision that ships.

   Answer ONLY: a navigation to the counter page, and same-origin GET build assets (or the page
   itself) requested by that page. Everything else returns false and the worker does not call
   respondWith: other pages, API calls, image-optimiser URLs, RSC payloads, cross-origin, non-GET.
   Cache growth is bounded by the same rule, because only what passes here is ever cached. */
self.shouldHandleCounterRequest = function shouldHandleCounterRequest(url, clientUrl, mode, origin, method) {
  var COUNTER = '/shop/manage/en-persona'
  try {
    var u = new URL(url)
    if (method && method !== 'GET') return false
    if (origin && u.origin !== origin) return false
    var onCounter = function (p) { return p === COUNTER || p === COUNTER + '/' }
    if (mode === 'navigate') return onCounter(u.pathname)
    if (u.searchParams.has('_rsc')) return false
    if (!clientUrl) return false
    var c = new URL(clientUrl)
    if (c.origin !== u.origin || !onCounter(c.pathname)) return false
    return u.pathname.indexOf('/_next/static/') === 0 || onCounter(u.pathname)
  } catch {
    return false
  }
}
