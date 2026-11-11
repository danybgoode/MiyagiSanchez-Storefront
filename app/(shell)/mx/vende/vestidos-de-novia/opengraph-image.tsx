import { sellerAcquisitionOgContentType, sellerAcquisitionOgSize } from '../_components/SellerAcquisitionOgImage'
import { businessTypeOgAlt, businessTypeOgImage } from '../_components/business-type-route'

export const alt = businessTypeOgAlt('vestidos-de-novia')
export const size = sellerAcquisitionOgSize
export const contentType = sellerAcquisitionOgContentType

export default function Image() {
  return businessTypeOgImage('vestidos-de-novia')
}
