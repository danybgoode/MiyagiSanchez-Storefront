import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { getShop } from '@/lib/listings'
import { isShopPreviewPrivateBySlug } from '@/lib/preview-access'
import { isLikelyShopSlug } from '@/lib/route-shape'
import { readPublicWall } from '@/lib/wall/public'
import { resolvePublicWallShop } from '@/lib/wall/store'
import { WALL_PAGE_SIZE } from '@/lib/wall/validate'
import { shopListingBase } from '@/lib/shop-presentation/chrome'

/**
 * Living Shop — the public Wall's next page (epic 07, Story 2.1).
 *
 * `GET /api/shop/wall?slug=<slug>&offset=<n>` — anonymous, published-and-effective
 * entries only. Drafts and not-yet-due scheduled entries are excluded by
 * `readPublicWall`, which is the SAME function the homepage renders through
 * (`lib/wall/public.ts`); a second read path here is how a draft eventually leaks
 * out of one of them.
 *
 * WHITE-LABEL BOUNDARY: on a subdomain or custom domain, middleware sets
 * `x-miyagi-shop-slug` and that header WINS over the query string. A tenant host
 * therefore serves only its own Wall — the query parameter cannot be used to read
 * another merchant's shop from inside their branded channel. The header is set by
 * middleware alone and stripped from any client that tries to inject it on a
 * platform host, so this is a real boundary and not a spoofable one.
 */

export const dynamic = 'force-dynamic'

/** Never let a caller ask for an unbounded page (S7.4). */
const MAX_OFFSET = 5_000

export async function GET(req: NextRequest) {
  const channelSlug = (await headers()).get('x-miyagi-shop-slug')
  const querySlug = req.nextUrl.searchParams.get('slug')
  const slug = channelSlug ?? querySlug

  if (!slug || !isLikelyShopSlug(slug)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const rawOffset = Number(req.nextUrl.searchParams.get('offset') ?? '0')
  const offset = Number.isFinite(rawOffset) ? Math.min(Math.max(0, Math.floor(rawOffset)), MAX_OFFSET) : 0

  // Three states, never two. `getShop` answers null when Medusa REPLIES that no
  // such seller exists, but THROWS when Medusa cannot be reached at all — and
  // those are different facts. Collapsing the second into a 404 would tell a
  // crawler a live merchant's shop is gone during a backend blip, which is the
  // confident falsehood this codebase keeps paying for.
  let seller: Awaited<ReturnType<typeof getShop>>
  try {
    seller = await getShop(slug)
  } catch (err) {
    console.error('[wall] seller lookup unavailable:', err)
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
  if (!seller) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // A preview-private shop is private on every channel, this one included — the
  // Wall would otherwise be a side door onto a merchant who has not consented to
  // being public yet.
  if (await isShopPreviewPrivateBySlug(seller.slug, seller.clerk_user_id)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // Two different shops, deliberately: `seller` is the MEDUSA seller (commerce,
  // trust flags, preview state) and `wallShop` is the Supabase mirror row whose
  // id this table's foreign key actually references. See `resolvePublicWallShop`.
  const wallShop = await resolvePublicWallShop(seller.slug)
  if (!wallShop) return NextResponse.json({ entries: [], hasMore: false, total: 0 })

  const page = await readPublicWall({
    shopId: wallShop.id,
    shopSlug: wallShop.slug,
    // Relative hrefs on an owned host; the marketplace prefix otherwise. The
    // channel header is what tells the two apart, exactly as the pages do it.
    basePath: channelSlug ? '' : `/mx/s/${wallShop.slug}`,
    // Where product cards point — the one decision in `shopListingBase` (see `ShopBases`).
    listingBase: shopListingBase({ onOwnedHost: !!channelSlug, marketBasePath: '/mx', shopSlug: wallShop.slug }),
    offset,
    pageSize: WALL_PAGE_SIZE,
  })

  return NextResponse.json(
    { entries: page.entries, hasMore: page.hasMore, total: page.total },
    // Short, shared cache: the Wall changes when a merchant posts, and a publish
    // already busts the shop's own render through `revalidateTag('listings')`.
    { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=120' } },
  )
}
