import { getLanguagePreference } from '@/lib/site-language-server'
import {
  ShopFaqPage,
  generateShopFaqMetadata,
} from '@/app/(shell)/s/[slug]/faq/page'

type Props = { params: Promise<{ slug: string }> }

export function generateMetadata({ params }: Props) {
  return generateShopFaqMetadata({ params, market: 'mx', marketBasePath: '/mx' })
}

export default async function MexicoShopFaqPage({ params }: Props) {
  return ShopFaqPage({ params, market: 'mx', marketBasePath: '/mx', language: await getLanguagePreference() })
}
