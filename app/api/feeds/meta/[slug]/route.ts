import { publicCatalogModel } from '@/lib/share-kit/catalog-server'
import { feedSlugFromSegment, metaFeedResponse } from '@/lib/share-kit/meta-feed'

/**
 * GET /api/feeds/meta/<slug>.csv — a shop's product feed for Meta Commerce Manager (share-kit S3.2, D18).
 *
 * Public, because Meta fetches it on a schedule with no credentials. It publishes only what the public catalog page
 * already shows, through the same loader. An unknown, preview-private or non-Mexico shop is a 404, and so is an
 * unclaimed one: a feed is a merchant's own sales channel, and nobody has claimed that shop to plug it in. A partial
 * read is a 503, never a short feed. Cached an hour at the edge; Meta reads it at most hourly.
 */

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const slug = feedSlugFromSegment((await params).slug)
  const plan = metaFeedResponse(slug ? await publicCatalogModel(slug) : null)
  if (plan.status === 404) return new Response('Not found', { status: 404 })
  if (plan.status === 503) {
    return new Response('Catalog temporarily unavailable', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '300' } })
  }
  return new Response(plan.csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `inline; filename="${slug}-meta.csv"`,
      'Cache-Control': 'public, s-maxage=3600',
    },
  })
}
