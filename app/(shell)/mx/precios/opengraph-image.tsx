import es from '@/locales/es.json'
import { createMarketingOgImage, marketingOgContentType, marketingOgSize } from '@/lib/marketing-og'

const ui = es.precios

export const alt = ui.metadata.ogAlt
export const size = marketingOgSize
export const contentType = marketingOgContentType

export default function Image() {
  return createMarketingOgImage({
    eyebrow: ui.eyebrow,
    title: ui.heroTitle,
    lead: ui.heroLead,
    path: '/mx/precios',
    tags: ['0% comisión', 'Sin planes', 'México'],
  })
}
