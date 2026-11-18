import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { META_PIXEL_ID, forwardToMetaPixel, metaPixelCallFor, shouldLoadMetaPixel } from '../lib/meta-pixel'
import { pushAnalyticsEvent } from '../lib/analytics-events'

/**
 * Meta Pixel for paid seller-acquisition campaigns (2026-11-17). Pure: the gate, the allow-list, the forwarder, and
 * the one real call path (`pushAnalyticsEvent` → `fbq`) driven with a stand-in `window`.
 */

const call = () => {
  const calls: unknown[][] = []
  return { calls, fbq: (...args: unknown[]) => void calls.push(args) }
}

test.describe('meta-pixel · where it loads', () => {
  test('loads on the production hosts, on the seller pitch and builder pages', () => {
    for (const hostname of ['miyagisanchez.com', 'www.miyagisanchez.com', 'MiyagiSanchez.com:443']) {
      expect(shouldLoadMetaPixel({ hostname, pathname: '/mx/vende' })).toBe(true)
    }
    expect(shouldLoadMetaPixel({ hostname: 'miyagisanchez.com', pathname: '/' })).toBe(true)
    expect(shouldLoadMetaPixel({ hostname: 'miyagisanchez.com', pathname: '/p2s/abc' })).toBe(true)
  })

  test('never on dev or previews — they would feed the ad account fake conversions', () => {
    expect(shouldLoadMetaPixel({ hostname: 'localhost', pathname: '/' })).toBe(false)
    expect(shouldLoadMetaPixel({ hostname: '127.0.0.1', pathname: '/' })).toBe(false)
    expect(shouldLoadMetaPixel({ hostname: 'miyagi-git-feat-x.vercel.app', pathname: '/' })).toBe(false)
  })

  test('never on white-label shops, the embed, or a pay link (the GA gate still applies)', () => {
    expect(shouldLoadMetaPixel({ hostname: 'una-tienda.miyagisanchez.com', pathname: '/' })).toBe(false)
    expect(shouldLoadMetaPixel({ hostname: 'tienda-propia.mx', pathname: '/' })).toBe(false)
    expect(shouldLoadMetaPixel({ hostname: 'miyagisanchez.com', pathname: '/embed/s/x' })).toBe(false)
    expect(shouldLoadMetaPixel({ hostname: 'miyagisanchez.com', pathname: '/pagar/tok123' })).toBe(false)
    expect(shouldLoadMetaPixel({ hostname: null, pathname: '/' })).toBe(false)
  })

  test('the pixel id is the «Miyagi Sánchez web» dataset', () => {
    expect(META_PIXEL_ID).toBe('29512612288367811')
  })
})

test.describe('meta-pixel · which events Meta hears', () => {
  test('the four funnel steps map to the events campaigns optimise on', () => {
    expect(metaPixelCallFor('p2s_describe_submitted')).toEqual(['track', 'Lead'])
    expect(metaPixelCallFor('p2s_kept')).toEqual(['track', 'CompleteRegistration'])
    expect(metaPixelCallFor('p2s_payments_connected')).toEqual(['trackCustom', 'PaymentsConnected'])
    expect(metaPixelCallFor('p2s_published')).toEqual(['trackCustom', 'ShopPublished'])
  })

  test('everything else stays in GA4 only — including names that are Object properties', () => {
    for (const name of ['guide_view', 'comparador_view', 'p2s_preview_rendered', 'constructor', 'toString', '']) {
      expect(metaPixelCallFor(name)).toBeNull()
    }
  })

  test('forwards the event NAME only, never our params', () => {
    const { calls, fbq } = call()
    expect(forwardToMetaPixel('p2s_kept', fbq)).toBe(true)
    expect(calls).toEqual([['track', 'CompleteRegistration']])
  })

  test('no fbq (not loaded / ad blocker) or a throwing fbq is a quiet no-op', () => {
    expect(forwardToMetaPixel('p2s_kept', undefined)).toBe(false)
    expect(forwardToMetaPixel('p2s_kept', null)).toBe(false)
    expect(
      forwardToMetaPixel('p2s_kept', () => {
        throw new Error('blocked')
      }),
    ).toBe(false)
  })
})

test.describe('meta-pixel · the real call path', () => {
  const g = globalThis as unknown as { window?: unknown }
  let saved: unknown
  test.beforeEach(() => {
    saved = g.window
  })
  test.afterEach(() => {
    g.window = saved
  })

  function fakeWindow(hostname: string) {
    const { calls, fbq } = call()
    const win = {
      location: { hostname, pathname: '/mx/vende' },
      dataLayer: [] as unknown[],
      fbq,
      localStorage: { getItem: () => null, setItem: () => undefined },
    }
    g.window = win
    return { win, calls }
  }

  test('pushAnalyticsEvent reaches both GTM and the Pixel for a mapped funnel step', () => {
    const { win, calls } = fakeWindow('miyagisanchez.com')
    pushAnalyticsEvent('p2s_describe_submitted', { chars: 42, market: 'mx' })
    expect(win.dataLayer).toEqual([{ event: 'p2s_describe_submitted', chars: 42, market: 'mx' }])
    expect(calls).toEqual([['track', 'Lead']])
  })

  test('an unmapped event reaches GTM only', () => {
    const { win, calls } = fakeWindow('miyagisanchez.com')
    pushAnalyticsEvent('guide_view')
    expect(win.dataLayer).toHaveLength(1)
    expect(calls).toEqual([])
  })
})

test.describe('meta-pixel · mounted in the one root document', () => {
  test('MarketDocument mounts <MetaPixel /> next to <SiteAnalytics />', () => {
    const src = readFileSync(join(process.cwd(), 'app/components/MarketDocument.tsx'), 'utf8')
    expect(src).toMatch(/<SiteAnalytics \/>[\s\S]{0,300}<MetaPixel \/>/)
  })
})
