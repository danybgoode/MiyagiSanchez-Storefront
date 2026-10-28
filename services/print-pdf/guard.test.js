// node --test services/print-pdf — the renderer's allow-list, secret and queue (share-kit D14).
// Observed red under a mutation: `isAllowedUrl` returning true for any https URL, `isAllowedSubrequest` admitting a
// `script` from an asset origin, `secretMatches` accepting an empty expected secret, and the queue never refusing.
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createQueue,
  BusyError,
  isAllowedSubrequest,
  isAllowedUrl,
  parseAllowedOrigins,
  parseAssetOrigins,
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
