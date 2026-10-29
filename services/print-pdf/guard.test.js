// node --test services/print-pdf — the renderer's allow-list, secret and queue (share-kit D14).
// Observed red under a mutation: `isAllowedUrl` returning true for any https URL, `isAllowedSubrequest` admitting a
// `script` from an asset origin, `allowedPageUrl` returning the caller's string unchanged, `redactUrls` keeping the query, the queue ignoring `maxWaitMs`, `secretMatches` accepting an empty expected secret, and the queue never refusing.
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  allowedPageUrl,
  createImageFailureTracker,
  createQueue,
  BusyError,
  isAllowedSubrequest,
  isAllowedUrl,
  parseAllowedOrigins,
  parseAssetOrigins,
  redactUrls,
  secretMatches,
} = require('./guard')

const PAGES = ['https://miyagisanchez.com']
const ASSETS = ['https://pub-abc.r2.dev']

test('only our own origin is a page the renderer will load', () => {
  assert.equal(isAllowedUrl('https://miyagisanchez.com/mx/s/x/catalogo/imprimir', PAGES), true)
  for (const url of [
    'http://medusa:8080/admin/users',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:8080/',
    'http://miyagisanchez.com/',
    'https://miyagisanchez.com.evil.example/',
    'https://evil.example/https://miyagisanchez.com/',
    'https://miyagisanchez.com@evil.example/',
    'https://user:pw@miyagisanchez.com/',
    'https://miyagisanchez.com:8443/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
    '',
  ]) {
    assert.equal(isAllowedUrl(url, PAGES), false, url)
  }
  assert.equal(isAllowedUrl(`https://miyagisanchez.com/${'a'.repeat(5000)}`, PAGES), false)
})

test('the page loaded is rebuilt from the allow-list entry, keeping only the path and query', () => {
  assert.equal(
    allowedPageUrl('https://miyagisanchez.com/mx/s/x/catalogo/imprimir?v=2#frag', PAGES),
    'https://miyagisanchez.com/mx/s/x/catalogo/imprimir?v=2',
  )
  for (const url of ['https://miyagisanchez.com@evil.example/', 'http://169.254.169.254/', 'not a url']) {
    assert.equal(allowedPageUrl(url, PAGES), null, url)
  }
})

test('an asset origin serves images and fonts, never a document, script or fetch', () => {
  const origins = { pageOrigins: PAGES, assetOrigins: ASSETS }
  assert.equal(isAllowedSubrequest('https://pub-abc.r2.dev/ad.webp', 'image', origins), true)
  assert.equal(isAllowedSubrequest('https://pub-abc.r2.dev/f.woff2', 'font', origins), true)
  for (const type of ['document', 'script', 'xhr', 'fetch', 'websocket', 'other']) {
    assert.equal(isAllowedSubrequest('https://pub-abc.r2.dev/x', type, origins), false, type)
  }
  assert.equal(isAllowedSubrequest('https://miyagisanchez.com/_next/static/a.js', 'script', origins), true)
  assert.equal(isAllowedSubrequest('https://www.googletagmanager.com/gtm.js', 'script', origins), false)
  assert.equal(isAllowedSubrequest('http://medusa:8080/x.png', 'image', origins), false)
  assert.equal(isAllowedSubrequest('data:image/png;base64,AAAA', 'image', origins), true)
  assert.equal(isAllowedSubrequest('https://pub-abc.r2.dev/x', 'image', { pageOrigins: PAGES }), false)
})

test('origins parse to exact origins, with a safe default and https-only assets', () => {
  assert.deepEqual(parseAllowedOrigins(undefined), ['https://miyagisanchez.com'])
  assert.deepEqual(parseAllowedOrigins(' https://a.example/path , junk, ftp://b.example '), ['https://a.example'])
  assert.deepEqual(parseAssetOrigins('https://pub-abc.r2.dev/, http://plain.example'), ['https://pub-abc.r2.dev'])
  assert.deepEqual(parseAssetOrigins(''), [])
})

test('an unset secret refuses everyone; a wrong one is refused', () => {
  assert.equal(secretMatches('', ''), false)
  assert.equal(secretMatches('', 'anything'), false)
  assert.equal(secretMatches('s3cret', undefined), false)
  assert.equal(secretMatches('s3cret', 's3cre'), false)
  assert.equal(secretMatches('s3cret', 's3cret'), true)
})

test('one render at a time, a bounded line, and the next one refused', { timeout: 5000 }, async () => {
  const queue = createQueue({ concurrency: 1, maxWaiting: 2 })
  const order = []
  let release
  const gate = new Promise((r) => { release = r })
  const first = queue.run(async () => { order.push('a-start'); await gate; order.push('a-end'); return 'a' })
  const second = queue.run(async () => { order.push('b'); return 'b' })
  const third = queue.run(async () => { order.push('c'); return 'c' })
  await assert.rejects(queue.run(async () => 'd'), BusyError)
  assert.deepEqual(queue.stats(), { running: 1, waiting: 2 })
  release()
  assert.deepEqual(await Promise.all([first, second, third]), ['a', 'b', 'c'])
  assert.deepEqual(order, ['a-start', 'a-end', 'b', 'c'])
  assert.deepEqual(queue.stats(), { running: 0, waiting: 0 })
})

test('a failed render frees its slot', async () => {
  const queue = createQueue({ concurrency: 1, maxWaiting: 0 })
  await assert.rejects(queue.run(async () => { throw new Error('boom') }), /boom/)
  assert.equal(await queue.run(async () => 'ok'), 'ok')
})

test('a logged error never carries a query string (the admin rate card URL holds ?secret=)', () => {
  const msg = 'net::ERR_NAME_NOT_RESOLVED at https://miyagisanchez.com/admin/print/rate-card/print?secret=s3cr3t&x=1'
  const out = redactUrls(msg)
  assert.equal(out.includes('s3cr3t'), false)
  assert.equal(out, 'net::ERR_NAME_NOT_RESOLVED at https://miyagisanchez.com/admin/print/rate-card/print?…')
  assert.equal(redactUrls('plain failure'), 'plain failure')
  assert.equal(redactUrls('https://a.example/p#k=secret').includes('secret'), false)
})

test('a job that waited past its bound is refused instead of rendering for a caller who left', async () => {
  let t = 0
  const queue = createQueue({ concurrency: 1, maxWaiting: 4, now: () => t })
  let release
  const first = queue.run(() => new Promise((r) => { release = r }), { maxWaitMs: 10 })
  let ranLate = false
  const late = queue.run(() => { ranLate = true; return 'x' }, { maxWaitMs: 10 })
  t = 50
  await new Promise((r) => setImmediate(r)) // the first job starts a microtask later
  release('done')
  assert.equal(await first, 'done')
  await assert.rejects(late, (e) => e instanceof BusyError)
  assert.equal(ranLate, false)
  const fresh = await queue.run(() => 'ok', { maxWaitMs: 10 })
  assert.equal(fresh, 'ok')
})

test('the renderer loads print pages with scripts off and waits for load, not network idle (share-kit, 2026-10-29)', () => {
  // A source pin on the I/O shell, which has no harness: with scripts on, a catalog never reached network idle and
  // every render timed out at 45 s.
  const server = require('node:fs').readFileSync(require('node:path').join(__dirname, 'server.js'), 'utf8')
  assert.match(server, /await page\.setJavaScriptEnabled\(false\)\n\s+await page\.setRequestInterception\(true\)/)
  assert.match(server, /page\.goto\(url, \{ waitUntil: 'load'/)
  assert.doesNotMatch(server, /networkidle/)
})

test('missing images are counted, except the ones the allow-list blocked on purpose (PR 450)', () => {
  const t = createImageFailureTracker()
  t.responded('image', 200)
  t.responded('document', 500)
  assert.equal(t.count(), 0)
  t.responded('image', 502)
  t.blocked('https://evil.example/x.png')
  t.failed('https://evil.example/x.png', 'image')
  assert.equal(t.count(), 1)
  t.failed('https://miyagisanchez.com/api/img?x', 'image')
  t.failed('https://miyagisanchez.com/a.css', 'stylesheet')
  assert.equal(t.count(), 2)
})

test('server.js imports every guard export it uses (PR 450 shipped a call to an unimported helper)', () => {
  // The I/O shell has no harness and `node --check` only parses, so an unimported name surfaced in production as
  // "createImageFailureTracker is not defined" on every render. This reads the shell's guard destructuring and
  // fails on any guard export used below it but missing from it.
  const server = require('node:fs').readFileSync(require('node:path').join(__dirname, 'server.js'), 'utf8')
  const match = /const \{([^}]*)\} = require\('\.\/guard'\)/.exec(server)
  assert.ok(match, 'the guard require in server.js moved — re-point this test')
  const imported = new Set(match[1].split(',').map((name) => name.trim()).filter(Boolean))
  const body = server.slice(match.index + match[0].length)
  for (const name of Object.keys(require('./guard'))) {
    if (new RegExp(`\\b${name}\\b`).test(body)) assert.ok(imported.has(name), `server.js uses ${name} without importing it`)
  }
  for (const name of imported) assert.ok(name in require('./guard'), `server.js imports ${name}, which guard.js does not export`)
})
