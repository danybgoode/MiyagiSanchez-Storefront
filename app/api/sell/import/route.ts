import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { validateRows, type CatalogImportRow } from '@/lib/catalog-import'
import { ingestImageUrls } from '@/lib/image-ingest'
import { buildCreateBody, createSellerProduct } from '@/lib/seller-product-create'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

/** Max rows accepted per request. The client sends the catalog in chunks of
 *  this size and renders live progress, so no single request can time out. */
const CHUNK_MAX = 25

function medusaFetch(path: string, clerkJwt: string, options?: RequestInit) {
  return fetch(`${MEDUSA_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': PUB_KEY,
      Authorization: `Bearer ${clerkJwt}`,
      ...(options?.headers ?? {}),
    },
  })
}

type RowResult = {
  line: number
  title: string
  status: 'created' | 'updated' | 'failed'
  product_id?: string
  reason?: string
  images_failed?: number
}

const isStockable = (lt?: string) => (lt ?? 'product') === 'product'

function buildUpdateBody(row: CatalogImportRow) {
  const listingType = row.listing_type ?? 'product'
  const priceCents = row.price != null ? Math.round(row.price * 100) : null
  const body: Record<string, unknown> = {
    title: row.title.trim(),
    description: row.description?.trim() || null,
    weight_grams: row.weight_grams ?? null,
    metadata: {
      external_id: row.external_id ?? null,
      ...(listingType === 'product' && row.condition ? { condition: row.condition } : {}),
    },
  }
  if (priceCents != null) body.price_cents = priceCents
  // Quantity only applies to stockable products; sending it to a service 422s.
  if (isStockable(listingType) && row.quantity != null) body.quantity = Math.max(0, Math.floor(row.quantity))
  // Unit cost (COGS) — resolves to the sole variant on the backend; a
  // multi-variant listing 422s per-row ("especifica variant_id"), reported
  // honestly in that row's result instead of killing the batch.
  if (row.unit_cost != null) body.unit_cost_cents = Math.round(row.unit_cost * 100)
  // Only include attrs when the row actually specifies vehicle-spec/trust
  // columns — the backend's attrs update is a shallow merge (confirmed in
  // apps/backend seller-product-update.ts), so omitting the key here never
  // wipes attrs a seller already set by hand; sending an empty object would
  // be a needless no-op write on every re-import row that skips these columns.
  if (row.attrs && Object.keys(row.attrs).length > 0) body.attrs = row.attrs
  return body
}

export async function POST(req: NextRequest) {
  const { userId, getToken } = await auth()
  if (!userId) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  const clerkJwt = await getToken()
  if (!clerkJwt) return NextResponse.json({ error: 'Error de autenticación.' }, { status: 401 })

  let body: { rows?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Datos inválidos.' }, { status: 400 })
  }

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return NextResponse.json({ error: 'No hay productos para importar.' }, { status: 422 })
  }
  if (body.rows.length > CHUNK_MAX) {
    return NextResponse.json({ error: `Máximo ${CHUNK_MAX} productos por lote.` }, { status: 422 })
  }

  // Re-validate server-side — never trust the client.
  const staged = validateRows(body.rows)

  // Authoritative external_id → product_id map for upsert (fetched per request).
  const map = new Map<string, string>()
  const listRes = await medusaFetch('/store/sellers/me/products?limit=200', clerkJwt)
  if (listRes.status === 404) {
    return NextResponse.json({ error: 'No tienes una tienda. Crea una antes de importar.' }, { status: 404 })
  }
  if (listRes.ok) {
    const data = (await listRes.json()) as {
      listings?: Array<{ id: string; metadata?: Record<string, unknown> | null }>
    }
    for (const l of data.listings ?? []) {
      const ext = l.metadata?.external_id
      if (typeof ext === 'string' && ext.trim()) map.set(ext, l.id)
    }
  }

  const results: RowResult[] = []

  for (const s of staged) {
    const title = (s.row.title || '(sin título)').slice(0, 80)
    if (!s.valid) {
      results.push({ line: s.line, title, status: 'failed', reason: s.issues.find((i) => i.level === 'error')?.message ?? 'Fila inválida.' })
      continue
    }

    const extId = s.row.external_id
    const existingId = extId ? map.get(extId) : undefined

    try {
      if (existingId) {
        const res = await medusaFetch(`/store/sellers/me/products/${existingId}`, clerkJwt, {
          method: 'PATCH',
          body: JSON.stringify(buildUpdateBody(s.row)),
        })
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { message?: string }
          results.push({ line: s.line, title, status: 'failed', reason: err.message ?? `Error ${res.status} al actualizar.` })
          continue
        }
        results.push({ line: s.line, title, status: 'updated', product_id: existingId })
      } else {
        // Pull remote images into our R2 asset pipeline (graceful per-image).
        const ingest = await ingestImageUrls(userId, s.row.images ?? [], s.row.title)
        // The shared create path (lib/seller-product-create.ts) — the photo → product confirm calls it too.
        const created = await createSellerProduct(clerkJwt, buildCreateBody(s.row, ingest.images))
        if (!created.ok) {
          results.push({ line: s.line, title, status: 'failed', reason: created.message ?? `Error ${created.status} al crear.` })
          continue
        }
        // Track within this batch so a repeated external_id updates instead of duplicating.
        if (extId) map.set(extId, created.productId)
        results.push({
          line: s.line, title, status: 'created', product_id: created.productId,
          ...(ingest.failed > 0 ? { images_failed: ingest.failed } : {}),
        })
      }
    } catch (e) {
      results.push({ line: s.line, title, status: 'failed', reason: e instanceof Error ? e.message : 'Error inesperado.' })
    }
  }

  return NextResponse.json({ results })
}
