'use client'

import { useEffect } from 'react'
import { useAuth } from '@clerk/nextjs'
import { authCacheAction, COUNTER_CACHE_PREFIX, COUNTER_OWNER_KEY, LAST_USER_KEY } from '@/lib/in-person/counter-cache'

/**
 * Clears the counter's offline cache when the session changes (in-person-sales S3.1), so seller
 * A's cached catalog is never served offline to the next person on a shared browser. Renders
 * nothing. Only the CacheStorage entries and the owner marker go; the IndexedDB sale queues stay
 * (seller-keyed, and they hold unsynced sales). See `authCacheAction` for the offline residual.
 */
export default function CounterCacheGuard() {
  const { isLoaded, userId } = useAuth()
  useEffect(() => {
    if (!isLoaded) return
    try {
      const prev = window.localStorage.getItem(LAST_USER_KEY)
      const next = userId ?? null
      if (authCacheAction(prev, next) === 'purge') {
        window.localStorage.removeItem(COUNTER_OWNER_KEY)
        if ('caches' in window) {
          void caches.keys().then((names) => Promise.all(names.filter((n) => n.startsWith(COUNTER_CACHE_PREFIX)).map((n) => caches.delete(n))))
        }
      }
      if (next) window.localStorage.setItem(LAST_USER_KEY, next)
      else window.localStorage.removeItem(LAST_USER_KEY)
    } catch { /* storage blocked: the counter's own owner check still runs */ }
  }, [isLoaded, userId])
  return null
}
