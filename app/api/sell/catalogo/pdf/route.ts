import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { getClientIp } from '@/lib/ratelimit'
import { serveCatalogPdf } from '@/lib/share-kit/catalog-pdf'
import { catalogPdfDeps } from '@/lib/share-kit/catalog-pdf-server'
import { catalogPdfResponse } from '@/lib/share-kit/catalog-pdf-response'

/**
 * GET /api/sell/catalogo/pdf — the signed-in merchant's own catalog PDF (share-kit S2.3, D16), the «Descargar» button.
 * The shop comes from the Clerk session, never a parameter — the same scoping as `/api/sell/shop/qr` — and then it is
 * exactly the public route's handler.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  const { data: shop } = await db
    .from('marketplace_shops')
    .select('slug')
    .eq('clerk_user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!shop?.slug) return NextResponse.json({ error: 'Tienda no encontrada.' }, { status: 404 })

  return catalogPdfResponse(await serveCatalogPdf(shop.slug, getClientIp(req), catalogPdfDeps))
}
