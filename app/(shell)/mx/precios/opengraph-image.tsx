import es from '@/locales/es.json'
import { createMarketingOgImage, marketingOgContentType, marketingOgSize } from '@/lib/marketing-og'
import { fillFixedPricingTokens } from '@/lib/pricing-catalog'

const ui = es.precios

export const alt = ui.metadata.ogAlt
export const size = marketingOgSize
export const contentType = marketingOgContentType

export default function Image() {
  return createMarketingOgImage({
    eyebrow: ui.eyebrow,
    title: ui.heroTitle,
    // The lead holds `{token}`s (the trial length, Plan Tienda's «desde» price): fill them, or the card shows braces.
    lead: fillFixedPricingTokens(ui.heroLead, 'es'),
    path: '/mx/precios',
    // «Sin planes» stopped being true with the two paid plans (plan-tienda S2.3).
    tags: ['0% comisión', 'IVA incluido', 'México'],
  })
}
