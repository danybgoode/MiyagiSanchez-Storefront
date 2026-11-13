import { getLanguagePreference } from '@/lib/site-language-server'
import { ShopFaqPage, generateShopFaqMetadata } from '@/app/(shell)/s/[slug]/faq/page'

type Props = { params: Promise<{ slug: string }> }
export function generateMetadata({ params }: Props) { return generateShopFaqMetadata({ params, market: 'us', marketBasePath: '/us' }) }
export default async function UnitedStatesShopFaqPage({ params }: Props) { return ShopFaqPage({ params, market: 'us', marketBasePath: '/us', language: await getLanguagePreference() }) }
