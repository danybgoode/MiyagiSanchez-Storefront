import es from '@/locales/es.json'
import {
  createSellerAcquisitionOgImage,
  sellerAcquisitionOgContentType,
  sellerAcquisitionOgSize,
} from '@/app/(shell)/mx/vende/_components/SellerAcquisitionOgImage'

// `/` is the Mexico shop builder (root-shop-builder-home D4), so a link to the bare domain shared
// on WhatsApp previews the seller pitch, not the old country picker. Moved here from
// `app/(shell)/mx/vende/opengraph-image.tsx`, which went away with the page it described.
const ui = es.sellerAcquisition.anchor

export const alt = ui.metadata.ogAlt
export const size = sellerAcquisitionOgSize
export const contentType = sellerAcquisitionOgContentType

export default function Image() {
  return createSellerAcquisitionOgImage({
    eyebrow: ui.eyebrow,
    title: ui.heroTitle,
    lead: ui.heroLead,
    path: '/',
    tags: ['0% comisión', 'México', 'IA'],
  })
}
