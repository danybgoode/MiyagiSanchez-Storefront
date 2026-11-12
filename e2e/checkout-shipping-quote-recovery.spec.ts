import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startCheckout } from '../lib/cart-client'
import { CheckoutStartError, isShippingQuoteInvalid } from '../lib/checkout-error'

/**
 * A stale or expired signed shipping quote (e.g. a checkout page opened before the deploy) must
 * recover in ONE step: the page clears the picked rate and re-quotes. That needs the backend's
 * machine code to survive the trip start-checkout -> /api/checkout/start -> cart-client -> button.
 */
const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

test.describe('shipping quote recovery', () => {
  test('cart-client keeps the code of a refused start', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: 'Vuelve a elegir el envío.', code: 'SHIPPING_QUOTE_INVALID' }), { status: 400 })) as typeof fetch
    try {
      const err = await startCheckout({ provider: 'stripe' } as never).catch((e) => e)
      expect(err).toBeInstanceOf(CheckoutStartError)
      expect(err.message).toBe('Vuelve a elegir el envío.')
      expect(isShippingQuoteInvalid(err)).toBe(true)
    } finally { globalThis.fetch = realFetch }
  })
  test('only that code triggers recovery', () => {
    expect(isShippingQuoteInvalid(new CheckoutStartError('x', 'OFFER_INVALID'))).toBe(false)
    expect(isShippingQuoteInvalid(new CheckoutStartError('x'))).toBe(false)
    expect(isShippingQuoteInvalid(new Error('SHIPPING_QUOTE_INVALID'))).toBe(false)
  })
  test('the page wires recovery: button reports it, page clears the rate and re-quotes once', () => {
    expect(src('app/components/CheckoutPayButton.tsx')).toMatch(/isShippingQuoteInvalid\(err\)\) onShippingQuoteInvalid\?\.\(\)/)
    const page = src('app/(shell)/checkout/CheckoutExperience.tsx')
    expect(page).toMatch(/onShippingQuoteInvalid=\{\(\) => \{ setSelectedShippingRateId\(null\); setShippingRates\(\[\]\); setRateRefreshKey/)
    expect(page).toMatch(/\[needsShippingRate, addressReady, listingId, items, address, rateRefreshKey\]/)
    expect(src('app/api/checkout/start/route.ts')).toContain('CheckoutStartError')
  })
})
