import { notFound, redirect } from 'next/navigation'
import { isLikelyListingId } from '@/lib/route-shape'
import { resolveShopPresentation } from '@/lib/shop-presentation/context'

/**
 * The `/us` adapter of the shop-scoped PDP (`market-route-population` mirrors every
 * MX catalog route and requires a market DECISION, not only a URL prefix).
 *
 * The decision: Mexico has `/mx/s/<slug>/l/<id>` because a Mexican shop can sell
 * a product it never published into the marketplace («Solo mi tienda»). That is a
 * Mexico-only capability (owned-shop-operating-channel non-goal), so every US shop
 * product lives at `/us/l/<id>` — US shops link there (`shopListingBase`), and a
 * hand-typed shop-scoped US URL for a real US shop is sent there. Temporary, not
 * permanent: if US ever gains shop-only products, this page becomes the real one.
 */
export default async function UsShopScopedListingPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>
}) {
  const { slug, id } = await params
  if (!isLikelyListingId(id)) notFound()
  // Resolves only a real, public shop in the US market (shape-checks the slug too).
  const ctx = await resolveShopPresentation(slug, { marketBasePath: '/us', market: 'us' })
  if (!ctx) notFound()
  redirect(`/us/l/${id}`)
}
