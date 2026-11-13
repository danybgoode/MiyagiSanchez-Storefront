import { GLOBAL_LANDING_EN } from '@/lib/global-landing-copy'
import {
  createSellerAcquisitionOgImage,
  sellerAcquisitionOgContentType,
  sellerAcquisitionOgSize,
} from '@/app/(shell)/mx/vende/_components/SellerAcquisitionOgImage'

// `/en` is the English shop builder, and the link to share in an English post. Until 2026-11-13 it had no preview
// image at all — the `/` image is a sibling of `(site)/page.tsx` and does not reach this route group — so an English
// share went out as a bare text card while the Spanish one carried the pitch.
const ui = GLOBAL_LANDING_EN

export const alt = ui.metadata.title
export const size = sellerAcquisitionOgSize
export const contentType = sellerAcquisitionOgContentType

export default function Image() {
  return createSellerAcquisitionOgImage({
    eyebrow: ui.eyebrow,
    title: ui.heroTitle,
    lead: ui.heroLead,
    path: '/en',
    tags: ['0% commission', 'Mexico · United States', 'AI'],
  })
}
