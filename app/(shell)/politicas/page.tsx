import { getLanguagePreference } from '@/lib/site-language-server'
import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import { getShop } from '@/lib/listings'
import { assertShopNotPreviewPrivate, isShopPreviewPrivateBySlug } from '@/lib/preview-access'
import PoliticasBody from '../_shop-content/PoliticasBody'
import type { Metadata } from 'next'

async function resolveChannelShop() {
  const channelSlug = (await headers()).get('x-miyagi-shop-slug')
  // No channel header ⇒ we're on the platform host, where a bare `/politicas`
  // has no meaning (the marketplace path is /s/[slug]/politicas) — self-404
  // without a Medusa fetch. The header is set ONLY by middleware.ts (never
  // client-controllable), so this is a hard boundary, not a spoofable one.
  if (!channelSlug) return null
  return getShop(channelSlug)
}

export async function generateMetadata(): Promise<Metadata> {
  const shop = await resolveChannelShop()
  if (!shop) return { title: 'Página no encontrada' }
  // Don't leak a preview-private shop's name in the <title>. Guarded explicitly
  // rather than relying on Next discarding metadata when the body notFound()s —
  // that behavior was asserted in review but never actually verified.
  if (await isShopPreviewPrivateBySlug(shop.slug, shop.clerk_user_id)) return { title: 'Página no encontrada' }
  return { title: `Políticas — ${shop.name}` }
}

// Channel path (subdomain / custom domain): /politicas. Shop identity comes
// from the request header middleware.ts sets, never from the URL.
export default async function ChannelPoliticasPage() {
  const shop = await resolveChannelShop()
  if (!shop) notFound()
  // Consent-safe previews: this is the CHANNEL-native page (subdomain / custom
  // domain serve it directly; middleware rewrites only `/` and `/convocatoria`),
  // so it needs the guard independently of the /s/[slug] variant.
  await assertShopNotPreviewPrivate(shop)

  return <PoliticasBody shop={shop} basePath="" language={await getLanguagePreference()} />
}
