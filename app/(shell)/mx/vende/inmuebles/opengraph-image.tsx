import { sellerAcquisitionOgContentType, sellerAcquisitionOgSize } from '../_components/SellerAcquisitionOgImage'
import { businessTypeOgAlt, businessTypeOgImage } from '../_components/business-type-route'

export const alt = businessTypeOgAlt('inmuebles')
export const size = sellerAcquisitionOgSize
export const contentType = sellerAcquisitionOgContentType

export default function Image() {
  return businessTypeOgImage('inmuebles')
}
