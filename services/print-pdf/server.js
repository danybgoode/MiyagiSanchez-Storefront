/**
 * PDF renderer — headless Chromium beside the app on the Oracle VM (share-kit S2.1; first written for print editions,
 * US-5b, on Cloud Run, which was deleted with GCP on 2026-10-16).
 *
 * Loads one of OUR print pages and returns a print-ready PDF honouring the page's @page size (preferCSSPageSize) and
 * backgrounds (printBackground). Separate from the Medusa backend so Chromium can never affect orders, and reachable
 * only on the compose network (`http://print-pdf:8080`, no published port).
 *
 * Auth: POST /pdf with `x-internal-secret` === PRINT_PDF_SECRET, body { url }. Every rule about WHAT it may load and
 * how many at once lives in ./guard.js (D14), which `node --test` covers.
 */

const express = require('express')
const puppeteer = require('puppeteer-core')
const {
  BusyError,
  createQueue,
  allowedPageUrl,
  isAllowedSubrequest,
  isAllowedUrl,
  parseAllowedOrigins,
  parseAssetOrigins,
  secretMatches,
} = require('./guard')

const PORT = process.env.PORT || 8080
const SECRET = process.env.PRINT_PDF_SECRET || ''
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium'
// One render's whole budget, browser launch to PDF bytes. The web caller gives up at 60 s; this stays inside it.
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 45000)
const PAGE_ORIGINS = parseAllowedOrigins(process.env.PRINT_PDF_ALLOWED_ORIGINS)
const ASSET_ORIGINS = parseAssetOrigins(process.env.PRINT_PDF_ASSET_ORIGINS)
const queue = createQueue({ concurrency: 1, maxWaiting: Number(process.env.PRINT_PDF_MAX_WAITING || 4) })

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '16kb' }))

app.get('/health', (_req, res) => res.json({ ok: true, ...queue.stats() }))

function withTimeout(promise, ms, onTimeout) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout()
        reject(new Error(`render timed out after ${ms} ms`))
      }, ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function render(url) {
  let browser
  const blocked = []
  const work = (async () => {
    browser = await puppeteer.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    })
    const page = await browser.newPage()
    await page.setRequestInterception(true)
    // Every request, redirects included (each hop is its own request event), is checked against the allow-list.
    page.on('request', (request) => {
      const allowed = isAllowedSubrequest(request.url(), request.resourceType(), {
        pageOrigins: PAGE_ORIGINS,
        assetOrigins: ASSET_ORIGINS,
      })
      if (allowed) {
        request.continue().catch(() => {})
      } else {
        blocked.push(request.url().slice(0, 120))
        request.abort('blockedbyclient').catch(() => {})
      }
    })
    await page.goto(url, { waitUntil: 'networkidle0', timeout: RENDER_TIMEOUT_MS })
    // A redirect off our origins was already aborted; refuse explicitly rather than print whatever did load.
    if (!isAllowedUrl(page.url(), PAGE_ORIGINS)) throw new Error('the page left the allowed origins')
    try { await page.evaluate(() => (document.fonts ? document.fonts.ready : null)) } catch { /* non-fatal */ }
    return Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }))
  })()
  try {
    return await withTimeout(work, RENDER_TIMEOUT_MS, () => { if (browser) browser.close().catch(() => {}) })
  } finally {
    if (blocked.length > 0) console.warn(`[print-pdf] blocked ${blocked.length} request(s): ${blocked.slice(0, 5).join(' ')}`)
    if (browser) await browser.close().catch(() => {})
  }
}

app.post('/pdf', async (req, res) => {
  if (!secretMatches(SECRET, req.get('x-internal-secret'))) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const requested = req.body && typeof req.body.url === 'string' ? req.body.url : null
  if (!requested) return res.status(400).json({ error: 'url required' })
  // Refused before Chromium starts: a URL off the allow-list never costs a browser launch. What loads is the URL
  // rebuilt from the allow-list entry, never the caller's string.
  const url = allowedPageUrl(requested, PAGE_ORIGINS)
  if (!url) return res.status(403).json({ error: 'url not allowed' })

  const started = Date.now()
  try {
    const pdf = await queue.run(() => render(url))
    console.log(`[print-pdf] rendered ${new URL(url).pathname} in ${Date.now() - started} ms (${pdf.length} bytes)`)
    res.set('Content-Type', 'application/pdf').send(pdf)
  } catch (e) {
    if (e instanceof BusyError) return res.status(503).json({ error: 'busy' })
    console.error('[print-pdf] render failed:', e)
    res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) })
  }
})

app.listen(PORT, () => {
  console.log(`[print-pdf] listening on :${PORT} (chromium=${CHROMIUM_PATH}, pages=${PAGE_ORIGINS.join(',')}, assets=${ASSET_ORIGINS.join(',') || 'none'})`)
})
