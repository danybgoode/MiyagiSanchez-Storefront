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
  createImageFailureTracker,
  createQueue,
  allowedPageUrl,
  isAllowedSubrequest,
  isAllowedUrl,
  parseAllowedOrigins,
  parseAssetOrigins,
  redactUrls,
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
// The web client gives up at 55 s, so a render that starts more than 10 s after its request arrived can finish after
// the caller left. It is refused as busy instead (verifier, PR 448).
const MAX_QUEUE_WAIT_MS = Number(process.env.PRINT_PDF_MAX_QUEUE_WAIT_MS || 10000)

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

async function render(url, callerGone) {
  let browser
  let abandoned = false
  const blocked = []
  const images = createImageFailureTracker()
  const work = (async () => {
    if (callerGone()) throw new Error('the caller left before the render started')
    browser = await puppeteer.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    })
    // A launch slower than the whole budget lands after the timeout already released the queue slot: close it now.
    if (abandoned) throw new Error('render abandoned after the timeout')
    const page = await browser.newPage()
    // Our print pages are server-rendered; their scripts are the app shell (auth, analytics, hydration). With them
    // off, a catalog loads in ~7 s instead of never going network-idle (two blob: requests stay pending forever), and
    // the 0.2-CPU budget goes to layout and printing (share-kit, 2026-10-29). Fewer requests also means less surface.
    await page.setJavaScriptEnabled(false)
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
        blocked.push(redactUrls(request.url()).slice(0, 120))
        images.blocked(request.url())
        request.abort('blockedbyclient').catch(() => {})
      }
    })
    page.on('requestfailed', (request) => images.failed(request.url(), request.resourceType()))
    page.on('response', (response) => images.responded(response.request().resourceType(), response.status()))
    // `load` waits for every image; with scripts off nothing else arrives after it.
    await page.goto(url, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS })
    // A redirect off our origins was already aborted; refuse explicitly rather than print whatever did load.
    if (!isAllowedUrl(page.url(), PAGE_ORIGINS)) throw new Error('the page left the allowed origins')
    // Bounded: with page scripts off, an in-page promise can stall a CDP call until its protocol timeout.
    let fontsTimer
    await Promise.race([
      page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true)).catch(() => false),
      new Promise((resolve) => { fontsTimer = setTimeout(resolve, 3000) }),
    ]).finally(() => clearTimeout(fontsTimer))
    const pdf = Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }))
    return { pdf, missingImages: images.count() }
  })()
  try {
    return await withTimeout(work, RENDER_TIMEOUT_MS, () => {
      abandoned = true
      if (browser) browser.close().catch(() => {})
    })
  } finally {
    if (blocked.length > 0) console.warn(`[print-pdf] blocked ${blocked.length} request(s): ${blocked.slice(0, 5).join(' ')}`)
    if (browser) await browser.close().catch(() => {})
    // A launch still in flight closes its browser when it lands (codex review, PR 448).
    else work.catch(() => {}).finally(() => { if (browser) browser.close().catch(() => {}) })
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
  let gone = false
  res.on('close', () => { if (!res.writableEnded) gone = true })
  try {
    const { pdf, missingImages } = await queue.run(() => render(url, () => gone), { maxWaitMs: MAX_QUEUE_WAIT_MS })
    console.log(`[print-pdf] rendered ${new URL(url).pathname} in ${Date.now() - started} ms (${pdf.length} bytes, ${missingImages} missing image(s))`)
    // The PDF is still served (a missing photo should not cost the merchant their download); the header lets the
    // caller decide not to keep it.
    res.set('Content-Type', 'application/pdf').set('X-Print-Missing-Images', String(missingImages)).send(pdf)
  } catch (e) {
    if (e instanceof BusyError) return res.status(503).json({ error: 'busy' })
    // Never the raw message: a navigation error carries the full URL, query string and all (verifier, PR 448).
    console.error(`[print-pdf] render failed: ${redactUrls((e && e.message) || e).slice(0, 300)}`)
    res.status(500).json({ error: 'render failed' })
  }
})

app.listen(PORT, () => {
  console.log(`[print-pdf] listening on :${PORT} (chromium=${CHROMIUM_PATH}, pages=${PAGE_ORIGINS.join(',')}, assets=${ASSET_ORIGINS.join(',') || 'none'})`)
})
