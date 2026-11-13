import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { publicUrl } from '../lib/request-origin'

// A signed-out seller on /api/stripe/connect was sent to https://0.0.0.0:8080/sign-in: behind Caddy, `req.url` is the
// container's bind address. Redirects use the public origin.

const req = (host: string | null) => ({ url: 'https://0.0.0.0:8080/api/stripe/connect', headers: { get: (k: string) => (k === 'host' ? host : null) } })

test('the site URL wins over the container address', () => {
  const prev = process.env.NEXT_PUBLIC_SITE_URL
  process.env.NEXT_PUBLIC_SITE_URL = 'https://miyagisanchez.com'
  try {
    expect(publicUrl('/sign-in', req('0.0.0.0:8080')).toString()).toBe('https://miyagisanchez.com/sign-in')
  } finally {
    process.env.NEXT_PUBLIC_SITE_URL = prev
  }
})

test('no Stripe or Mercado Pago connect route builds a redirect from req.url any more', () => {
  for (const f of ['app/api/stripe/connect/route.ts', 'app/api/stripe/connect/refresh/route.ts', 'app/api/stripe/connect/return/route.ts', 'app/api/stripe/connect/dashboard/route.ts', 'app/api/mp/connect/route.ts', 'app/api/mp/connect/callback/route.ts']) {
    expect(readFileSync(f, 'utf8'), f).not.toMatch(/new URL\([^)]*req\.url\)/)
  }
})
