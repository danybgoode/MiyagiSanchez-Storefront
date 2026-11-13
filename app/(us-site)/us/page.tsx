import type { Metadata } from 'next'
import { MarketHomePage } from '@/app/(mx-site)/mx/page'
import { marketLandingMetadata } from '@/lib/market-seo'

// 2026-11-13: per request, not ISR. The chrome follows the visitor's stored ES/EN choice (`lib/site-language.ts`),
// and a cookie-dependent render must never be cached for the next visitor. Data stays cached at the fetch layer.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: { absolute: 'Miyagi Sánchez United States — Marketplace' },
  description: 'Browse independent US shops and listings in the Miyagi Sánchez marketplace.',
  robots: { index: true, follow: true },
  ...marketLandingMetadata('us'),
}

/** Literal US landing adapter; the implementation is shared with Mexico. */
export default function UnitedStatesMarketplacePage() {
  return MarketHomePage({ market: 'us' })
}
