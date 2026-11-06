/**
 * Image ingestion for bulk import (Sprint 1 US-5).
 *
 * Pulls remote image URLs the seller's agent supplied into our own R2 asset
 * pipeline so listings don't depend on the source host staying alive. Designed
 * to be safe to call inline during import: bounded count, per-image timeout,
 * and graceful per-image failure (a bad URL keeps its original value, never
 * throws, never blocks the product).
 */

import { pinnedFetch } from './ssrf-fetch'
import { uploadToR2, isR2Configured } from './r2'

const MAX_IMAGES_PER_PRODUCT = 6
const FETCH_TIMEOUT_MS = 6000
const MAX_BYTES = 8 * 1024 * 1024 // 8 MB

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

/** Block obvious SSRF targets (loopback, link-local, private ranges, hostless). */
function isSafePublicUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || !host.includes('.')) return false
  if (/^(127\.|0\.|10\.|169\.254\.|192\.168\.)/.test(host)) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
  return true
}

export interface IngestResult {
  /** Final image list ({url} objects). R2 URLs where ingestion succeeded,
   *  original URLs where it failed (so nothing the seller intended is lost). */
  images: Array<{ url: string; alt?: string }>
  ingested: number
  failed: number
}

/** How many redirects an image fetch follows; each hop is re-checked and re-pinned. */
const MAX_REDIRECTS = 3

/**
 * Fetch one remote image and upload it to R2. Returns null on any failure.
 *
 * The URL comes from an uploaded file or a scraped catalog, so this is a server-side fetch of an untrusted address.
 * Since 2026-11-05 (promoter-panel S1.3, which lets promoters import files) it dials through `pinnedFetch`: the host is
 * resolved once, private and reserved addresses are refused, and the connection goes to exactly the address that was
 * checked (no DNS-rebinding window). Redirects are followed by hand, each hop checked again, instead of `fetch`'s
 * `redirect: 'follow'`, which would dial wherever a public server pointed — internal addresses included.
 */
async function ingestOne(url: string, userId: string): Promise<string | null> {
  if (!isSafePublicUrl(url)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    let target = new URL(url)
    let res = await pinnedFetch(target, { signal: controller.signal, redirect: 'manual' })
    for (let hop = 0; res.status >= 300 && res.status < 400; hop++) {
      const location = res.headers.get('location')
      if (!location || hop >= MAX_REDIRECTS) return null
      target = new URL(location, target)
      if (!isSafePublicUrl(target.href)) return null
      res = await pinnedFetch(target, { signal: controller.signal, redirect: 'manual' })
    }
    if (!res.ok) return null
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const ext = EXT_BY_TYPE[type]
    if (!ext) return null
    const buf = await res.arrayBuffer()
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null
    const key = `listing-images/${userId}/import/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    return await uploadToR2(buf, key, type)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ingest a product's image URLs into R2. If R2 isn't configured, the original
 * URLs are returned untouched (graceful no-op). Caps the number of images.
 */
export async function ingestImageUrls(
  userId: string,
  urls: string[],
  alt: string,
): Promise<IngestResult> {
  const capped = urls.slice(0, MAX_IMAGES_PER_PRODUCT)
  if (!isR2Configured() || capped.length === 0) {
    return { images: capped.map((url) => ({ url, alt })), ingested: 0, failed: 0 }
  }

  const settled = await Promise.all(capped.map((url) => ingestOne(url, userId)))

  let ingested = 0
  let failed = 0
  const images = capped.map((original, i) => {
    const r2 = settled[i]
    if (r2) { ingested++; return { url: r2, alt } }
    failed++
    return { url: original, alt } // keep original on failure — never lose an image
  })

  return { images, ingested, failed }
}
