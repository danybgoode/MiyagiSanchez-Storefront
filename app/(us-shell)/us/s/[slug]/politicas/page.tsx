import { getLanguagePreference } from '@/lib/site-language-server'
import { ShopPoliticasPage, generateShopPoliciesMetadata } from '@/app/(shell)/s/[slug]/politicas/page'

type Props = { params: Promise<{ slug: string }> }
export function generateMetadata({ params }: Props) { return generateShopPoliciesMetadata({ params, market: 'us', marketBasePath: '/us' }) }
export default async function UnitedStatesShopPoliciesPage({ params }: Props) { return ShopPoliticasPage({ params, market: 'us', marketBasePath: '/us', language: await getLanguagePreference() }) }
