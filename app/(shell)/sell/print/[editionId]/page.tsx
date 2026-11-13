import { redirect } from 'next/navigation'
import { auth, currentUser } from '@clerk/nextjs/server'
import PrintAdBuilder, { type BuilderEdition, type BuilderListing, type SellerPrefill } from './PrintAdBuilder'
import { listingUrlFor, shopUrlFor } from '@/lib/market-url'

export const metadata = { title: { absolute: 'Diseña tu anuncio impreso — Miyagi Sánchez' } }

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'

function medusaFetch(path: string, clerkJwt: string) {
  return fetch(`${MEDUSA_BASE}${path}`, {
    headers: { 'x-publishable-api-key': PUB_KEY, Authorization: `Bearer ${clerkJwt}` },
    cache: 'no-store',
  })
}

export default async function PrintAdBuilderPage({ params, searchParams }: {
  params: Promise<{ editionId: string }>
  searchParams: Promise<{ submission?: string }>
}) {
  const { editionId } = await params
  const { submission: initialSubmissionId } = await searchParams
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const { getToken } = await auth()
  const clerkJwt = await getToken()
  if (!clerkJwt) redirect('/sign-in')

  // ── Seller (must exist) ───────────────────────────────────────────────────
  const sellerRes = await medusaFetch('/store/sellers/me', clerkJwt)
  if (sellerRes.status === 404) redirect('/sell')
  if (!sellerRes.ok) throw new Error('No se pudo cargar tu tienda.')
  const { seller } = await sellerRes.json()

  const settings = (seller.metadata?.settings ?? {}) as {
    theme?: { social?: { whatsapp?: string } }
    checkout?: { phone?: string }
  }
  const whatsapp: string | null =
    settings.theme?.social?.whatsapp ?? settings.checkout?.phone ?? null
  const prefill: SellerPrefill = {
    seller_id: seller.id,
    name: seller.name,
    slug: seller.slug,
    logo_url: seller.logo_url ?? null,
    location: seller.location ?? null,
    whatsapp,
    shop_url: shopUrlFor(SITE_URL, seller.slug),
  }

  // ── Open edition (find by id among open editions) ─────────────────────────
  const edRes = await fetch(`${SITE_URL}/api/print/editions?status=open`, { cache: 'no-store' })
  const edData = edRes.ok ? await edRes.json() : { editions: [] }
  const edition: BuilderEdition | undefined =
    (edData.editions ?? []).find((e: BuilderEdition) => e.id === editionId)
  if (!edition) redirect('/shop/manage')
  const platformSellerId: string | null = edData.platform_seller_id ?? null

  // ── Seller's own listings (for the "feature a listing" picker) ────────────
  interface RawProduct { id: string; title: string; status?: string; images?: Array<{ url?: string }> }
  const prodRes = await medusaFetch('/store/sellers/me/products?limit=200', clerkJwt)
  const prodData = prodRes.ok ? await prodRes.json() : { listings: [] }
  const listings: BuilderListing[] = ((prodData.listings ?? []) as RawProduct[])
    .filter((l) => l.status === 'active' || l.status === 'published')
    .map((l) => ({
      id: l.id,
      title: l.title,
      image: l.images?.[0]?.url ?? null,
      url: listingUrlFor(SITE_URL, l.id),
    }))

  return (
    <PrintAdBuilder
      edition={edition}
      prefill={prefill}
      listings={listings}
      initialSubmissionId={initialSubmissionId ?? null}
      platformSellerId={platformSellerId}
    />
  )
}
