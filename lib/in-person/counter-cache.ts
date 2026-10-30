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
