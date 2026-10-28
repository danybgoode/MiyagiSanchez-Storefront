/**
 * The renderer's decisions, pure (share-kit D14) — what it will load and when it is too busy to.
 *
 * Headless Chromium on the VM sits beside Postgres, Redis and Medusa on the `miyagi` network. A renderer that loads
 * any URL it is handed is a server-side request forgery primitive: one POST could make it fetch `http://medusa:8080`
 * or the cloud metadata address and print the answer into a PDF. So it loads only OUR origins — the page it is asked
 * for AND every request that page makes (images, fonts, redirects) — and it renders one page at a time.
 *
 * Kept free of express and puppeteer so `node --test` checks it with no browser.
 */
const { timingSafeEqual } = require('node:crypto')

const DEFAULT_ALLOWED_ORIGINS = ['https://miyagisanchez.com']

/** `PRINT_PDF_ALLOWED_ORIGINS` (comma-separated) as normalized origins; the default when unset or empty. */
function parseAllowedOrigins(raw) {
  const origins = String(raw || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      try {
        const url = new URL(part)
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
      } catch {
        return null
      }
    })
    .filter(Boolean)
  return origins.length > 0 ? origins : DEFAULT_ALLOWED_ORIGINS
}

/**
 * May the renderer load this URL? Only an exact allow-listed origin (scheme, host AND port). Credentials in the URL
 * are refused outright — `https://miyagisanchez.com@evil.example` parses to evil.example, and a userinfo part on our
 * own host has no legitimate use here.
 */
function isAllowedUrl(raw, allowedOrigins) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return false
  let url
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  return allowedOrigins.includes(url.origin)
}

/** Resource types a public ASSET origin may serve: passive content only, never a document, script or fetch. */
const ASSET_RESOURCE_TYPES = new Set(['image', 'font', 'stylesheet', 'media'])

/**
 * A request the page may make. Inline `data:` / `blob:` content is fine (no network). A page origin may serve
 * anything. An asset origin (`PRINT_PDF_ASSET_ORIGINS` — the public R2 bucket the print-edition ads and their QR
 * codes are stored in) may serve only passive content, so it can never become a navigation, a script or an XHR.
 * Everything else is aborted.
 */
function isAllowedSubrequest(raw, resourceType, { pageOrigins, assetOrigins = [] }) {
  if (typeof raw === 'string' && (raw.startsWith('data:') || raw.startsWith('blob:'))) return true
  if (isAllowedUrl(raw, pageOrigins)) return true
  return ASSET_RESOURCE_TYPES.has(resourceType) && isAllowedUrl(raw, assetOrigins)
}

/** `PRINT_PDF_ASSET_ORIGINS` — https only, no default (an unset value means page origins only). */
function parseAssetOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      try {
        const url = new URL(part)
        return url.protocol === 'https:' ? url.origin : null
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** Constant-time secret check. An unset secret refuses everyone, never "no secret needed". */
function secretMatches(expected, given) {
  if (typeof expected !== 'string' || expected.length === 0) return false
  if (typeof given !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

class BusyError extends Error {
  constructor() {
    super('busy')
    this.name = 'BusyError'
  }
}

/**
 * A FIFO that runs `concurrency` jobs at once and holds at most `maxWaiting` more; the next one is refused with a
 * BusyError instead of piling up Chromium processes on a 768 MB container.
 */
function createQueue({ concurrency = 1, maxWaiting = 4 } = {}) {
  let running = 0
  const waiting = []

  function next() {
    while (running < concurrency && waiting.length > 0) {
      const { job, resolve, reject } = waiting.shift()
      running += 1
      Promise.resolve()
        .then(job)
        .then(resolve, reject)
        .finally(() => {
          running -= 1
          next()
        })
    }
  }

  return {
    run(job) {
      if (running >= concurrency && waiting.length >= maxWaiting) return Promise.reject(new BusyError())
      return new Promise((resolve, reject) => {
        waiting.push({ job, resolve, reject })
        next()
      })
    },
    stats() {
      return { running, waiting: waiting.length }
    },
  }
}

module.exports = {
  DEFAULT_ALLOWED_ORIGINS,
  parseAllowedOrigins,
  isAllowedUrl,
  isAllowedSubrequest,
  parseAssetOrigins,
  secretMatches,
  createQueue,
  BusyError,
}
