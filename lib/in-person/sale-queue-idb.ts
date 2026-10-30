/**
 * Thin IndexedDB adapter for the offline cash queue (in-person-sales S3.1). One object store
 * keyed by client_id. Everything is try/catch: when IndexedDB is missing or blocked the
 * functions say so (`false` / `null`) and the counter DISABLES offline selling with a reason —
 * there is never a silent memory-only queue that a reload would lose.
 */
import { sanitizeEntries, type QueueEntry } from './sale-queue'

/** One database per signed-in seller: a shared phone never shows or uploads another seller's sales. */
const dbName = (sellerId: string) => `ms-en-persona:${sellerId}`
const STORE = 'queue'

function open(sellerId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('indexedDB unavailable'))
    const req = indexedDB.open(dbName(sellerId), 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'client_id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
    req.onblocked = () => reject(new Error('indexedDB blocked'))
  })
}

/** null when storage is unavailable (distinct from an empty queue). */
export async function idbLoad(sellerId: string): Promise<QueueEntry[] | null> {
  try {
    const db = await open(sellerId)
    try {
      return await new Promise<QueueEntry[]>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
        req.onsuccess = () => resolve(sanitizeEntries(req.result))
        req.onerror = () => reject(req.error)
      })
    } finally { db.close() }
  } catch {
    return null
  }
}

/**
 * Apply per-entry writes in one transaction. NEVER clear-and-rewrite: another tab or a remounted
 * counter may have added entries this memory has not seen, and a clear would erase them.
 */
export async function idbApply(sellerId: string, change: { put: QueueEntry[]; remove: string[] }): Promise<boolean> {
  if (change.put.length === 0 && change.remove.length === 0) return true
  try {
    const db = await open(sellerId)
    try {
      return await new Promise<boolean>((resolve) => {
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        for (const e of change.put) store.put(e)
        for (const id of change.remove) store.delete(id)
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => resolve(false)
        tx.onabort = () => resolve(false)
      })
    } finally { db.close() }
  } catch {
    return false
  }
}
