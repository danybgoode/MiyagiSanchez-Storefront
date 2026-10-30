import { expect, test } from '@playwright/test'
import {
  parseSellerAcquisitionUtm,
  resolveSellerAcquisitionVariant,
  resolveSellerPersonaRoute,
  sellerPersonaCtaHref,
  sellerPersonaRouterHref,
} from '../lib/seller-acquisition'

/**
 * Every persona CTA now converts on `/sign-up` and carries the publish
 * destination in `redirect_url`. Asserting through these two helpers keeps the
 * intent legible: WHERE the visitor is sent, and WHAT attribution survives the
 * account-creation hop.
 */
const signupHref = (publishHref: string) => `/sign-up?redirect_url=${encodeURIComponent(publishHref)}`
const publishTarget = (href: string) =>
  decodeURIComponent(new URL(href, 'https://miyagisanchez.com').searchParams.get('redirect_url') ?? '')

test.describe('seller acquisition · persona config and attribution seam', () => {
  test('resolves live persona routes without touching middleware', () => {
    expect(resolveSellerPersonaRoute('vende')).toMatchObject({
      pagePath: '/',
      from: 'vende',
      status: 'live',
    })
    expect(resolveSellerPersonaRoute('creadores')).toMatchObject({
      pagePath: '/mx/vende/creadores',
      from: 'creadores',
      status: 'live',
    })
    expect(resolveSellerPersonaRoute('mundial')).toMatchObject({
      pagePath: '/mx/vende/mundial',
      from: 'mundial',
      type: 'service',
      status: 'live',
    })
    expect(resolveSellerPersonaRoute('negocios')).toMatchObject({
      pagePath: '/mx/vende/negocios',
      from: 'negocios',
      status: 'live',
    })
    expect(resolveSellerPersonaRoute('servicios')).toMatchObject({
      pagePath: '/mx/vende/servicios',
      from: 'servicios',
      type: 'service',
      status: 'live',
    })
  })

  test('builds CTA hrefs with persona from-param and safe UTM carry-through', () => {
    const href = sellerPersonaCtaHref('creadores', {
      utm_source: 'instagram',
      utm_medium: 'bio ',
      utm_campaign: ' creator-drop ',
      ref: 'not-carried',
    })

    expect(href).toBe(signupHref('/sell?from=creadores&v=a&utm_source=instagram&utm_medium=bio&utm_campaign=creator-drop'))
    expect(publishTarget(href)).toBe('/sell?from=creadores&v=a&utm_source=instagram&utm_medium=bio&utm_campaign=creator-drop')
  })

  test('keeps World Cup service type on the shipped wedge CTA', () => {
    expect(sellerPersonaCtaHref('mundial', 'utm_source=qr')).toBe(
      signupHref('/sell?type=service&from=mundial&v=a&utm_source=qr'),
    )
  })

  test('routes the local business persona to its page with attribution', () => {
    expect(sellerPersonaRouterHref('negocios', 'utm_source=flyer')).toBe(
      '/mx/vende/negocios?utm_source=flyer',
    )
    expect(sellerPersonaCtaHref('negocios', 'utm_source=flyer')).toBe(
      signupHref('/sell?from=negocios&v=a&utm_source=flyer'),
    )
  })

  test('routes the services persona to its page and service CTA with attribution', () => {
    expect(sellerPersonaRouterHref('servicios', 'utm_source=flyer')).toBe(
      '/mx/vende/servicios?utm_source=flyer',
    )
    expect(sellerPersonaCtaHref('servicios', 'utm_source=flyer')).toBe(
      signupHref('/sell?type=service&from=servicios&v=a&utm_source=flyer'),
    )
  })

  test('resolves A/B variants fail-safe and tags conversion links', () => {
    expect(resolveSellerAcquisitionVariant()).toBe('a')
    expect(resolveSellerAcquisitionVariant('v=b')).toBe('b')
    expect(resolveSellerAcquisitionVariant({ variant: 'B' })).toBe('b')
    expect(resolveSellerAcquisitionVariant({ v: 'bad-value' })).toBe('a')

    expect(sellerPersonaCtaHref('creadores', { v: 'b', utm_source: 'ig' })).toBe(
      signupHref('/sell?from=creadores&v=b&utm_source=ig'),
    )
    expect(sellerPersonaRouterHref('creadores', 'v=b&utm_source=ig')).toBe(
      '/mx/vende/creadores?utm_source=ig&v=b',
    )
  })

  test('sanitizes empty, unknown, and overlong UTM values', () => {
    const longValue = 'x'.repeat(160)
    expect(parseSellerAcquisitionUtm({
      utm_source: ' ',
      utm_medium: longValue,
      foo: 'bar',
    })).toEqual({
      utm_medium: longValue.slice(0, 140),
    })
  })
})
