/**
 * Whose counter is cached on this browser (in-person-sales S3.1). The counter's cached HTML holds
 * a seller's products; on a shared phone it must never be served offline to the next person.
 * PURE decision; the counter applies it (delete the caches, then record the new owner) before
 * anything else on mount.
 */
export type CacheOwnerAction = 'keep' | 'claim' | 'purge'

export function cacheOwnerAction(storedOwner: string | null, currentSeller: string): CacheOwnerAction {
  if (storedOwner === currentSeller) return 'keep'
  // No recorded owner could still be someone's cache from before this marker existed: purge it too.
  return storedOwner === null ? 'claim' : 'purge'
}

export const COUNTER_CACHE_PREFIX = 'ms-counter-'
export const COUNTER_OWNER_KEY = 'ms.en-persona.cache-owner'

/** localStorage marker: the Clerk user this browser last saw signed in. */
export const LAST_USER_KEY = 'ms.auth.last-user'

/**
 * Auth-side cache hygiene. The cached counter page lists one seller's products, and the worker
 * would serve it offline to whoever opens the URL next on a shared phone, before the counter's
 * own owner check can run. So the cache is cleared where the session is observed: when the
 * signed-in user changes or goes signed-out. `prev` is the last user this browser saw (null when
 * none was recorded), `next` is the user now (null = signed out). PURE.
 *
 * Residual that no client code can close: a seller who signs out while the phone is OFFLINE has no
 * signal for the page to run this on, so the cache survives until the next online page load.
 * The unsynced-sales queue is NOT touched by this: it is keyed by seller and holds real sales.
 */
export function authCacheAction(prev: string | null, next: string | null): 'purge' | 'keep' {
  if (prev === null) return 'keep' // first observation: nothing to compare against
  return prev === next ? 'keep' : 'purge'
}
