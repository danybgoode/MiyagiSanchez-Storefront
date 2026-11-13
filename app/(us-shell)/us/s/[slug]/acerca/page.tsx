import { getLanguagePreference } from '@/lib/site-language-server'
import { ShopAcercaPage, generateShopAcercaMetadata } from '@/app/(shell)/s/[slug]/acerca/page'

type Props = { params: Promise<{ slug: string }> }
export function generateMetadata({ params }: Props) { return generateShopAcercaMetadata({ params, market: 'us', marketBasePath: '/us' }) }
export default async function UnitedStatesShopAboutPage({ params }: Props) { return ShopAcercaPage({ params, market: 'us', marketBasePath: '/us', language: await getLanguagePreference() }) }
