/**
 * lib/meta-pixel.ts
 *
 * The Meta (Facebook/Instagram) Pixel for paid seller-acquisition campaigns: WHERE it loads and WHICH of our own
 * analytics events it hears. Pure — the loader (`app/components/MetaPixel.tsx`) and the event pusher
 * (`lib/analytics-events.ts`) are the only I/O.
 *
 * Why a constant and not a `NEXT_PUBLIC_*` env var: a Pixel ID is public by design (it ships in every page's JS), and a
 * `NEXT_PUBLIC_*` value only exists if the Docker build passes it as a build arg — a missed arg is a Pixel that is
 * silently absent in prod while every check stays green. The dataset is «Miyagi Sánchez web» in the Miyagi Sánchez
 * business portfolio (1798467634739290), created 2026-11-17.
 */

import { shouldLoadAnalytics } from './analytics-gating'

export const META_PIXEL_ID = '29512612288367811'

/**
 * Production hosts only. GA4 also loads on localhost and previews (its container id is absent there, so it never
 * does in practice); the Pixel id is a constant, so without this every dev session and preview would feed the ad
 * account's audiences and conversion counts — and Meta optimises spend on exactly those counts.
 */
const PIXEL_HOSTS = new Set(['miyagisanchez.com', 'www.miyagisanchez.com'])

export function shouldLoadMetaPixel(loc: { hostname: string | null | undefined; pathname: string | null | undefined }): boolean {
  if (!shouldLoadAnalytics(loc)) return false // never on white-label shops, the embed, or a pay link
  const host = (loc.hostname ?? '').split(':')[0].trim().toLowerCase()
  return PIXEL_HOSTS.has(host)
}

export type MetaPixelCall = readonly ['track' | 'trackCustom', string]

/**
 * Our funnel event → the Pixel event Meta optimises on. An ALLOW-list on purpose: every other `dataLayer` event stays
 * in GA4 only. Standard events (`Lead`, `CompleteRegistration`) are what Ads Manager can optimise a campaign for;
 * the later steps are custom so they can become custom conversions without pretending to be something they are not.
 */
const PIXEL_EVENTS: Readonly<Record<string, MetaPixelCall>> = {
  p2s_describe_submitted: ['track', 'Lead'], // a merchant described their business in the builder box
  p2s_kept: ['track', 'CompleteRegistration'], // they kept the shop (signed in and claimed it)
  p2s_payments_connected: ['trackCustom', 'PaymentsConnected'],
  p2s_published: ['trackCustom', 'ShopPublished'], // the shop is live — the activation we judge the campaign by
}

export function metaPixelCallFor(eventName: string): MetaPixelCall | null {
  return Object.prototype.hasOwnProperty.call(PIXEL_EVENTS, eventName) ? PIXEL_EVENTS[eventName] : null
}

export type Fbq = (...args: unknown[]) => void

/**
 * Forward one of our events to the Pixel. Sends the event NAME only, never our params: GA4 keeps the detail, Meta needs
 * only the fact to optimise and build audiences, and nothing a merchant typed about their business leaves for an ad
 * network. Returns whether a call was made. No `fbq` (not loaded here, or blocked by an ad blocker) is a no-op.
 */
export function forwardToMetaPixel(eventName: string, fbq: Fbq | null | undefined): boolean {
  const call = metaPixelCallFor(eventName)
  if (!call || typeof fbq !== 'function') return false
  try {
    fbq(call[0], call[1])
  } catch {
    return false // an ad network failing must never break the funnel that called it
  }
  return true
}
