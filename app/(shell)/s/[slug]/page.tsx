import { headers } from 'next/headers'
import { applyPreviewOverlay } from '@/lib/shop-presentation/preview'
import { getLanguagePreference } from '@/lib/site-language-server'
import {
  ShopPage as renderShopPage,
  generateShopMetadata as renderShopMetadata,
  type ShopRequestContext,
} from './ShopRenderer'

type MetadataArgs = Parameters<typeof renderShopMetadata>[0]
type PageArgs = Parameters<typeof renderShopPage>[0]

async function requestContext(): Promise<ShopRequestContext> {
  const requestHeaders = await headers()
  const channel = requestHeaders.get('x-miyagi-channel')
  return {
    channel: channel === 'marketplace' || channel === 'subdomain' || channel === 'custom' || channel === 'embed'
      ? channel
      : undefined,
    domain: requestHeaders.get('x-miyagi-domain'),
    language: await getLanguagePreference(),
  }
}

export async function generateShopMetadata(args: MetadataArgs) {
  return renderShopMetadata({ ...args, requestContext: await requestContext() })
}

export const generateMetadata = generateShopMetadata

export async function ShopPage(args: PageArgs) {
  const search = (await args.searchParams) ?? {}
  return renderShopPage({
    ...args,
    requestContext: await requestContext(),
    settingsOverlay: (slug, persisted) => applyPreviewOverlay(slug, persisted, search),
  })
}

export default ShopPage
