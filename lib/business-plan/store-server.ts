/**
 * The business model's I/O (business-infrastructure D6, D11). Every decision lives in the pure modules
 * (`model.ts`, `sales.ts`, `edit.ts`); this file only reads and writes.
 *
 * Ownership: the seller is resolved from the caller's OWN Clerk token (`/store/sellers/me`), never from a request body
 * or a URL — and the row is keyed by that seller id. One merchant cannot name another's model.
 *
 * Writes are conditional on the `updated_at` the read saw and `.select()` the row back: supabase-js reports no error
 * for an UPDATE that matched nothing (team memory: a read is not a claim).
 */

import 'server-only'
import { db } from '@/lib/supabase'
import { findKeptDraft } from '@/lib/prompt-to-shop/claim-server'
import type { ProfitEvent, ProfitOrderInfo } from '@/lib/profit'
import { mergeShop, readInputs, seedFromDraft, type BusinessInputs } from './model'
import { productsFrom, salesFrom, windowMonths } from './sales'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

export interface ModelRow {
  id: string
  seller_id: string
  inputs: BusinessInputs
  explanation: unknown
  last_checkin_period: string | null
  updated_at: string
}

const COLUMNS = 'id, seller_id, inputs, explanation, last_checkin_period, updated_at'

export async function readModel(sellerId: string): Promise<ModelRow | null | 'unavailable'> {
  const { data, error } = await db.from('business_models').select(COLUMNS).eq('seller_id', sellerId).maybeSingle()
  if (error) return 'unavailable'
  if (!data) return null
  const row = data as Omit<ModelRow, 'inputs'> & { inputs: unknown }
  return { ...row, inputs: readInputs(row.inputs) }
}

/** Create the row once. A concurrent create loses the unique race and re-reads the winner's row. */
async function createModel(owner: { sellerId: string; clerkUserId: string; slug: string }, inputs: BusinessInputs, draftId: string | null): Promise<ModelRow | 'unavailable'> {
  const { error } = await db.from('business_models').insert({
    seller_id: owner.sellerId, clerk_user_id: owner.clerkUserId, shop_slug: owner.slug, draft_id: draftId, inputs,
  })
  // 23505 = unique_violation: someone else created it first; theirs stands.
  if (error && error.code !== '23505') return 'unavailable'
  const row = await readModel(owner.sellerId)
  return row && row !== 'unavailable' ? row : 'unavailable'
}

/** One conditional write. `null` = the row changed since it was read (or vanished): never report a save that did not happen. */
export async function writeInputs(row: Pick<ModelRow, 'id' | 'updated_at'>, inputs: BusinessInputs): Promise<ModelRow | null | 'unavailable'> {
  const { data, error } = await db
    .from('business_models')
    .update({ inputs, updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('updated_at', row.updated_at)
    .select(COLUMNS)
  if (error) return 'unavailable'
  if (!Array.isArray(data) || data.length !== 1) return null
  const r = data[0] as Omit<ModelRow, 'inputs'> & { inputs: unknown }
  return { ...r, inputs: readInputs(r.inputs) }
}

/** The seller-scoped reads the plan needs, with the caller's own token. `null` = could not read (never "empty"). */
async function sellerGet(path: string, clerkJwt: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${MEDUSA_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', 'x-publishable-api-key': PUB_KEY, Authorization: `Bearer ${clerkJwt}` },
      cache: 'no-store',
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

export interface LoadedModel {
  row: ModelRow
  /** What could not be read this time — named on the page, never silently treated as zero. */
  unavailable: Array<'products' | 'sales'>
}

/**
 * The shop's model, current: created on first visit (seeded from the kept prompt-to-shop draft when there is one), then
 * merged with what the shop's catalog and ledger say now (D7 provenance rules), and saved when that changed anything.
 */
export async function loadModel(
  owner: { sellerId: string; clerkUserId: string; slug: string },
  clerkJwt: string,
  now = new Date(),
): Promise<LoadedModel | 'unavailable'> {
  let row = await readModel(owner.sellerId)
  if (row === 'unavailable') return 'unavailable'
  if (!row) {
    const kept = await findKeptDraft(owner.clerkUserId, null)
    const draft = kept && kept !== 'unavailable' && kept.sellerId === owner.sellerId ? kept : null
    const seed = draft ? seedFromDraft(draft.blocks.catalog ?? [], draft.blocks.numbers ?? null, now.toISOString()) : { offers: [], fixed_costs: [] }
    const created = await createModel(owner, seed, draft?.id ?? null)
    if (created === 'unavailable') return 'unavailable'
    row = created
  }

  const unavailable: LoadedModel['unavailable'] = []
  const [productsBody, ledgerBody] = await Promise.all([
    sellerGet('/store/sellers/me/products?limit=200&offset=0', clerkJwt),
    sellerGet('/store/sellers/me/profit', clerkJwt),
  ])
  const products = productsBody === null ? null : productsFrom(productsBody)
  const ledger = ledgerBody as { events?: unknown; orders?: unknown } | null
  const ledgerOk = !!ledger && Array.isArray(ledger.events) && Array.isArray(ledger.orders)
  if (products === null) unavailable.push('products')
  if (!ledgerOk) unavailable.push('sales')
  // Without the catalog there is nothing to merge into: the stored model stands, and the page names the gap.
  if (products === null) return { row, unavailable }

  const merged = mergeShop(
    row.inputs,
    products,
    ledgerOk ? salesFrom(ledger!.events as ProfitEvent[], ledger!.orders as ProfitOrderInfo[], now) : null,
    { months: windowMonths(), at: now.toISOString() },
  )
  if (JSON.stringify(merged) === JSON.stringify(row.inputs)) return { row, unavailable }
  const saved = await writeInputs(row, merged)
  // A concurrent writer won: show what they saved rather than our merge of a stale read.
  if (saved === null) {
    const fresh = await readModel(owner.sellerId)
    return fresh && fresh !== 'unavailable' ? { row: fresh, unavailable } : 'unavailable'
  }
  return saved === 'unavailable' ? { row: { ...row, inputs: merged }, unavailable } : { row: saved, unavailable }
}
