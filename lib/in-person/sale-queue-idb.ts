/**
 * Thin IndexedDB adapter for the offline cash queue (in-person-sales S3.1). One object store
 * keyed by client_id. Everything is try/catch: when IndexedDB is missing or blocked the
 * functions say so (`false` / `null`) and the counter DISABLES offline selling with a reason —
 * there is never a silent memory-only queue that a reload would lose.
 */
import { sanitizeEntries, type QueueEntry } from './sale-queue'

const DB_NAME = 'ms-en-persona'
const STORE = 'queue'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('indexedDB unavailable'))
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'client_id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
    req.onblocked = () => reject(new Error('indexedDB blocked'))
  })
}

/** null when storage is unavailable (distinct from an empty queue). */
export async function idbLoad(): Promise<QueueEntry[] | null> {
  try {
    const db = await open()
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

/** Make the store equal to `entries` in one transaction. False when it could not be written. */
export async function idbSave(entries: QueueEntry[]): Promise<boolean> {
  try {
    const db = await open()
    try {
      return await new Promise<boolean>((resolve) => {
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        store.clear()
        for (const e of entries) store.put(e)
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => resolve(false)
        tx.onabort = () => resolve(false)
      })
    } finally { db.close() }
  } catch {
    return false
  }
}
