import { satisfactionAnswered } from '@/lib/growth-track'
import { redirect } from 'next/navigation'
import { auth, currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { ensureSupabaseShopMirror, syncSupabaseListingMirror, type MedusaSellerForMirror } from '@/lib/provisioning'
import { filterOutDeleted } from '@/lib/listing-lifecycle'
import ManageDashboard from './ManageDashboard'
import { personalizeSetupSteps } from '@/lib/setup-guide'
import { guideProductCount, guideStepsFor } from '@/lib/setup-guide-source'
import { fetchDeletedListingIds, fetchGuideShop } from '@/lib/setup-guide-server'
import { getTenantIntake } from '@/lib/tenant-intake'

export const metadata = {
  title: 'Mi tienda — Miyagi Sánchez',
}

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

interface MedusaListingForManage {
  id: string
  title: string
  price_cents: number | null
  currency: string
  category: string | null
  listing_type: string
  condition: string | null
  status: string
  views: number
  images: Array<{ url: string; alt?: string | null }>
  created_at: string
}

function medusaFetch(path: string, clerkJwt: string) {
  return fetch(`${MEDUSA_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': PUB_KEY,
      Authorization: `Bearer ${clerkJwt}`,
    },
    cache: 'no-store',
  })
}

export default async function ManagePage() {
  const user = await currentUser()
  // Middleware protects this route, but be defensive
  if (!user) redirect('/sign-in')

  const { getToken } = await auth()
  const clerkJwt = await getToken()
  if (!clerkJwt) redirect('/sign-in')

  // Medusa owns sellers/products after the migration. The Supabase mirror is
  // kept only for seller-console features that still use UUID foreign keys.
  const sellerRes = await medusaFetch('/store/sellers/me', clerkJwt)
  if (sellerRes.status === 404) redirect('/sell')
  if (!sellerRes.ok) throw new Error('No se pudo cargar tu tienda.')

  const { seller } = await sellerRes.json() as { seller: MedusaSellerForMirror }
  const shopMirror = await ensureSupabaseShopMirror(seller, user.id)

  const productsRes = await medusaFetch('/store/sellers/me/products?limit=200', clerkJwt)
  const productsData = productsRes.ok
    ? await productsRes.json() as { listings?: MedusaListingForManage[] }
    : { listings: [] }

  // Deploy-lag safety: until the backend native soft-delete is live, a deleted
  // product may still come back from Medusa as a draft. Hide anything the mirror
  // already marks 'deleted' — and exclude it from the resync below so we never
  // clobber that 'deleted' back to 'draft' (which would resurrect it in the edit
  // guard). Once soft-delete deploys, Medusa omits the product → this set is
  // empty → no-op. (LEARNINGS → frontend degrades gracefully in the lag window.)
  // The same read the owner canvas (/sell/armar) uses, so both count the same products (lib/setup-guide-server.ts).
  const deletedIds = shopMirror?.id ? await fetchDeletedListingIds(shopMirror.id) : new Set<string>()

  const listings = filterOutDeleted(
    (productsData.listings ?? []).map((listing) => ({
    id: listing.id,
    title: listing.title,
    price_cents: listing.price_cents,
    currency: listing.currency,
    category: listing.category,
    listing_type: listing.listing_type,
    condition: listing.condition,
    status: listing.status,
    views: listing.views,
    images: listing.images.map((image) => ({
      url: image.url,
      ...(image.alt ? { alt: image.alt } : {}),
    })),
    created_at: listing.created_at,
  })),
    deletedIds,
  )

  if (shopMirror?.id) {
    await Promise.all(
      listings.map((listing) =>
        syncSupabaseListingMirror(shopMirror.id, {
          id: listing.id,
          title: listing.title,
          price_cents: listing.price_cents,
          currency: listing.currency,
          condition: listing.condition,
          listing_type: listing.listing_type,
          category: listing.category,
          images: listing.images,
          status: listing.status,
        }),
      ),
    )
  }

  // ── Fetch listings + pending offers + pending orders + the setup-guide shop
  // row in parallel. The guide row mirrors the exact columns settings/page.tsx
  // reads (`lib/setup-guide.ts`'s ShopRow) so completion state can never drift
  // between the settings index and this card.
  const [{ count: pendingOffersCount }, { count: pendingOrdersCount }, { data: guideShop }, intake] = shopMirror?.id
    ? await Promise.all([
        db
          .from('marketplace_offers')
          .select('id', { count: 'exact', head: true })
          .eq('shop_id', shopMirror.id)
          .eq('status', 'pending'),
        db
          .from('marketplace_orders')
          .select('id', { count: 'exact', head: true })
          .eq('shop_id', shopMirror.id)
          .in('status', ['paid', 'processing']),
        fetchGuideShop(user.id).then((data) => ({ data: data ?? null })),
        getTenantIntake(user.id),
      ])
    : [{ count: 0 }, { count: 0 }, { data: null }, null]

  const guideSettings = (guideShop?.metadata as { settings?: { guide?: { guide_dismissed?: boolean; share_done?: boolean; satisfaction_answered?: boolean } } } | null)?.settings?.guide
  // `guideStepsFor` + `guideProductCount` are the SAME calls the owner canvas makes (prompt-to-shop D17): the two
  // surfaces show one percentage for one shop. `personalizeSetupSteps` only reorders, so it cannot change it.
  const setupSteps = guideShop
    ? personalizeSetupSteps(guideStepsFor(guideShop, guideProductCount(listings, deletedIds)), intake)
    : []
  // Fail-safe: an absent/malformed flag reads as false — show the guide.
  const guideDismissed = !!guideSettings?.guide_dismissed
  // The route's own rule (key present = answered), so the page can never show an ask the claim would refuse.
  const guideSatisfactionAnswered = satisfactionAnswered(guideShop?.metadata)

  return (
    <ManageDashboard
      shop={{
        id: seller.id,
        slug: seller.slug,
        name: seller.name,
        location: seller.location ?? null,
      }}
      initialListings={listings}
      pendingOffersCount={pendingOffersCount ?? 0}
      pendingOrdersCount={pendingOrdersCount ?? 0}
      setupSteps={setupSteps}
      guideDismissed={guideDismissed}
      guideSatisfactionAnswered={guideSatisfactionAnswered}
    />
  )
}
