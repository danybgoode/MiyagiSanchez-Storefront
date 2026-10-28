import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isShopSlug, shopQrPlan, shopShortLink } from '../lib/share-link'

// Prompt-to-shop S5.2 — the shares after «Publicar». The shop slug comes from a database row, and a row is not proof
// of its own shape: it is validated against the shop-slug charset before it reaches a QR code, a download filename,
// a short link or a backend query. Anything else is refused, never encoded.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const HOSTILE = [
  '', 'Tamales', 'tamales_abuela', '-tamales', 'tamales-', 'tama--les', 'tamales/../admin', 'a"; filename=x.exe',
  'tamales\r\nSet-Cookie: x=1', 'tamales?x=1', 'https://evil.example', 'tamal%20es', 'é', 'a'.repeat(81),
]

test('only a shop slug passes: lowercase letters and digits in hyphen-separated runs', () => {
  for (const ok of ['tamales', 'tamales-la-abuela', 'tienda-24', 'a1']) expect(isShopSlug(ok), ok).toBe(true)
  for (const bad of HOSTILE) expect(isShopSlug(bad), JSON.stringify(bad)).toBe(false)
  for (const bad of [null, undefined, 7, {}]) expect(isShopSlug(bad)).toBe(false)
})

test('the QR plan encodes the short link and names the file from the VALIDATED slug only, or refuses', () => {
  expect(shopQrPlan('tamales-la-abuela')).toEqual({ url: 'https://mschz.org/tamales-la-abuela', filename: 'tamales-la-abuela-qr.png' })
  for (const bad of HOSTILE) expect(shopQrPlan(bad), JSON.stringify(bad)).toBeNull()
  expect(shopShortLink('tamales')).toBe('https://mschz.org/tamales')
  expect(shopShortLink('a"; x')).toBeNull()
})

test('the QR route refuses before encoding, and its header carries only the plan\'s filename', () => {
  const route = read('app/api/sell/shop/qr/route.ts')
  const plan = route.indexOf('const plan = shopQrPlan(shop?.slug)')
  const refuse = route.indexOf("if (!plan) return NextResponse.json({ error: 'Tienda no encontrada.' }, { status: 404 })")
  const encode = route.indexOf('QRCode.toBuffer(plan.url')
  expect(plan).toBeGreaterThan(0)
  expect(refuse).toBeGreaterThan(plan)
  expect(encode).toBeGreaterThan(refuse)
  expect(route).toContain('filename="${plan.filename}"')
  expect(route).not.toMatch(/shop\.slug\b/)
})

test('the nudge cron validates the slug before the backend read (defence in depth)', () => {
  const src = read('lib/prompt-to-shop/nudges-server.ts')
  const fn = src.slice(src.indexOf('async function listProductsInternal('), src.indexOf('async function deletedIds('))
  expect(fn.indexOf('if (!isShopSlug(slug)) return null')).toBeGreaterThan(0)
  expect(fn.indexOf('if (!isShopSlug(slug)) return null')).toBeLessThan(fn.indexOf('await fetch('))
})
