/* Which requests the counter's service worker may answer (in-person-sales S3.1, D11).
   Plain script on purpose: sw.js loads it with importScripts and the api spec evaluates it
   directly, so the decision under test is the decision that ships.

   Answer ONLY: a navigation to the counter page, and same-origin GET subresources requested by
   that page. Everything else (other pages, API calls, cross-origin, non-GET) returns false and
   the worker does not call respondWith, so navigation elsewhere is untouched. */
self.shouldHandleCounterRequest = function shouldHandleCounterRequest(url, clientUrl, mode, origin, method) {
  var COUNTER = '/shop/manage/en-persona'
  try {
    var u = new URL(url)
    if (method && method !== 'GET') return false
    if (origin && u.origin !== origin) return false
    var onCounter = function (p) { return p === COUNTER || p === COUNTER + '/' }
    if (mode === 'navigate') return onCounter(u.pathname)
    if (u.pathname.indexOf('/api/') === 0) return false
    if (!clientUrl) return false
    var c = new URL(clientUrl)
    return c.origin === u.origin && onCounter(c.pathname)
  } catch (e) {
    return false
  }
}
