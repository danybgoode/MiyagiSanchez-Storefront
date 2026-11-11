import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import type { NextRequest } from 'next/server'
import { shopSlugFromHost, isReservedSubdomain, ROOT_DOMAIN, publicHostRedirectUrl, unentitledSubdomainPath } from '../lib/subdomain'
import { detectChannel } from '../lib/channel'

/**
 * Subdomains · US-1. Pure-logic guards on host→slug resolution and channel
 * attribution — the rules middleware trusts to white-label a shop subdomain
 * without ever hijacking the apex, www, previews, or auth/infra subdomains.
 * No network; deterministic.
 */
test.describe('subdomain · shopSlugFromHost', () => {
  test('a single-label shop subdomain → its slug', () => {
    expect(shopSlugFromHost('mi-tienda.miyagisanchez.com')).toBe('mi-tienda')
    expect(shopSlugFromHost('Mi-Tienda.MIYAGISANCHEZ.com:443')).toBe('mi-tienda') // case + port
  })

  test('apex / www / vercel / localhost → null', () => {
    expect(shopSlugFromHost('miyagisanchez.com')).toBeNull()
    expect(shopSlugFromHost('www.miyagisanchez.com')).toBeNull()
    expect(shopSlugFromHost('my-branch.vercel.app')).toBeNull()
    expect(shopSlugFromHost('localhost:3001')).toBeNull()
    expect(shopSlugFromHost('')).toBeNull()
    expect(shopSlugFromHost(null)).toBeNull()
  })

  test('multi-label subdomains → null (only direct children are shops)', () => {
    expect(shopSlugFromHost('a.b.miyagisanchez.com')).toBeNull()
  })

  test('reserved / infra labels never resolve to a shop', () => {
    for (const label of ['admin', 'api', 'app', 'clerk', 'accounts', 'mail', 'cdn', 'shop', 's', 'mschz', 'gcp']) {
      expect(shopSlugFromHost(`${label}.miyagisanchez.com`)).toBeNull()
      expect(isReservedSubdomain(label)).toBe(true)
    }
  })

  test('a custom domain (not under the root) → null', () => {
    expect(shopSlugFromHost('tienda.com')).toBeNull()
    expect(shopSlugFromHost('shop.tienda.mx')).toBeNull()
  })

  test('malformed label (bad slug) → null', () => {
    expect(shopSlugFromHost('-bad.miyagisanchez.com')).toBeNull()
    expect(shopSlugFromHost('ab.miyagisanchez.com')).toBeNull() // < 3 chars
  })

  test('ROOT_DOMAIN is the platform apex', () => {
    expect(ROOT_DOMAIN).toBe('miyagisanchez.com')
  })
})

test.describe('subdomain · channel attribution', () => {
  test('x-miyagi-channel: subdomain → detectChannel "subdomain"', () => {
    const req = { headers: new Headers({ 'x-miyagi-channel': 'subdomain' }) } as unknown as NextRequest
    expect(detectChannel(req)).toBe('subdomain')
  })
})

test.describe('subdomain · redirects never leak the container port (reported live 2026-11-11)', () => {
  test('a fresh public URL has no port, whatever the request carried', () => {
    // 🚨 The shipped code cloned req.nextUrl and set `.host`, and the WHATWG host
    // setter KEEPS the old port: buyers got https://miyagisanchez.com:8080/… → SSL error.
    const cloned = new URL('http://miel-verduras.miyagisanchez.com:8080/l/prod_01M7609S83T01NK7Q2MFGKZQ2K')
    cloned.protocol = 'https:'
    cloned.host = ROOT_DOMAIN
    expect(cloned.port).toBe('8080') // the trap, pinned so nobody "simplifies" back to it

    const url = publicHostRedirectUrl(ROOT_DOMAIN, '/mx/s/miel-verduras')
    expect(url.href).toBe('https://miyagisanchez.com/mx/s/miel-verduras')
    expect(url.port).toBe('')
  })

  test('the middleware builds subdomain redirects with the helper, not a nextUrl clone', () => {
    const source = readFileSync(path.join(import.meta.dirname, '..', 'middleware.ts'), 'utf8')
    expect(source).not.toMatch(/\.host\s*=/)
  })

  test('an unentitled product link keeps its product; anything else lands on the shop', () => {
    expect(unentitledSubdomainPath('miel-verduras', '/l/prod_01M7609S83T01NK7Q2MFGKZQ2K'))
      .toBe('/mx/s/miel-verduras/l/prod_01M7609S83T01NK7Q2MFGKZQ2K')
    expect(unentitledSubdomainPath('miel-verduras', '/')).toBe('/mx/s/miel-verduras')
    expect(unentitledSubdomainPath('miel-verduras', '/tienda')).toBe('/mx/s/miel-verduras')
    // A junk id is not a product link.
    expect(unentitledSubdomainPath('miel-verduras', '/l/.env')).toBe('/mx/s/miel-verduras')
  })
})
