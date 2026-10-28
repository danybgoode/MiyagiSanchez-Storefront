/**
 * Prompt-to-shop — the real I/O behind the day 1/3/7 nudges (epic S5.4). Every decision lives in `nudges.ts`.
 *
 * A cron has no Clerk session, so the shop's products are read through the backend's service route
 * `GET /internal/seller-products?seller_slug=` (the same `querySellerCatalog` the seller's own list uses), with the
 * shared internal secret. A read that fails makes that candidate `published: null` — "could not tell" — and the
 * selection skips it; it never becomes "no products, nudge away".
 */

import 'server-only'
import { db } from '@/lib/supabase'
import { sendP2sNudge } from '@/lib/email'
import { dispatchToSeller } from '@/lib/notifications/dispatch'
import { DELETED_STATUS } from '@/lib/listing-lifecycle'
import { isShopSlug } from '@/lib/share-link'
import { GUIDE_SHOP_COLUMNS, guideProductCount, guideStepsFor, type GuideShopRow } from '@/lib/setup-guide-source'
import type { PrefRow } from '@/lib/notifications/preferences'
import { NUDGE_COPY, NUDGE_STEP_COPY } from './copy'
import { NUDGE_WINDOW_DAYS, sentNudges, withNudge, type NudgeCandidate, type NudgeCronDeps, type NudgeDay } from './nudges'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const INTERNAL_SECRET = process.env.MEDUSA_INTERNAL_SECRET ?? ''
const SITE = 'https://miyagisanchez.com'
const DAY_MS = 24 * 60 * 60 * 1000
/** One run's ceiling. A daily cron over a seven-day window; far above today's volume, and bounded. */
const BATCH = 200
const CLAIM_ATTEMPTS = 3
/** Candidates read in parallel at a time. */
export const CANDIDATE_CHUNK = 10

interface DraftRow {
  id: string
  claimed_by: string | null
  claimed_at: string | null
  identity: { name?: unknown } | null
  block_status: unknown
}

type ShopRow = GuideShopRow & { id: string; slug: string }

/** The seller's products by slug, drafts included. `null` = could not read. */
async function listProductsInternal(slug: string): Promise<Array<{ id: string; status: string }> | null> {
  if (!INTERNAL_SECRET) return null
  // Defence in depth: the slug is also encoded below, but a value that is not a shop slug never reaches the backend.
  if (!isShopSlug(slug)) return null
  try {
    const res = await fetch(`${MEDUSA_BASE}/internal/seller-products?seller_slug=${encodeURIComponent(slug)}`, {
      headers: { 'x-internal-secret': INTERNAL_SECRET },
      cache: 'no-store',
    })
    if (!res.ok) return null
    const data = (await res.json().catch(() => null)) as { listings?: Array<{ id?: unknown; status?: unknown }> } | null
    if (!Array.isArray(data?.listings)) return null
    return data.listings
      .filter((l): l is { id: string; status: string } => typeof l.id === 'string' && typeof l.status === 'string')
      .map((l) => ({ id: l.id, status: l.status }))
  } catch {
    return null
  }
}

async function deletedIds(shopId: string): Promise<Set<string> | null> {
  const { data, error } = await db.from('marketplace_listings').select('medusa_product_id').eq('shop_id', shopId).eq('status', DELETED_STATUS)
  if (error) return null
  return new Set((data ?? []).map((r) => r.medusa_product_id as string | null).filter((id): id is string => !!id))
}

async function candidateFor(row: DraftRow): Promise<NudgeCandidate> {
  const base: NudgeCandidate = {
    draftId: row.id,
    shopName: typeof row.identity?.name === 'string' ? row.identity.name : '',
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    email: null,
    sent: sentNudges(row.block_status),
    published: null,
    steps: null,
    prefs: null,
  }
  if (!row.claimed_by) return base

  const [shopRead, prefsRead] = await Promise.all([
    db.from('marketplace_shops')
      .select(`id, slug, ${GUIDE_SHOP_COLUMNS}`)
      .eq('clerk_user_id', row.claimed_by)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    db.from('notification_preferences').select('channel, event_group, enabled').eq('clerk_user_id', row.claimed_by),
  ])
  const prefs = prefsRead.error ? null : ((prefsRead.data as PrefRow[] | null) ?? [])
  const shop = shopRead.error ? null : (shopRead.data as ShopRow | null)
  if (!shop?.slug) return { ...base, prefs }

  const [products, deleted] = await Promise.all([listProductsInternal(shop.slug), deletedIds(shop.id)])
  if (!products || !deleted) return { ...base, prefs }
  const own = products.filter((p) => !deleted.has(p.id))
  return {
    ...base,
    prefs,
    published: own.some((p) => p.status === 'active'),
    // The checklist exactly as the canvas builds it: the same row, the same product count.
    steps: guideStepsFor(shop, guideProductCount(products, deleted)),
  }
}

/** Kept drafts whose keep is between one day and the end of day 7 ago. */
async function loadCandidates(now: Date): Promise<NudgeCandidate[] | null> {
  const { data, error } = await db
    .from('shop_drafts')
    .select('id, claimed_by, claimed_at, identity, block_status')
    .not('claimed_by', 'is', null)
    .not('claimed_seller_id', 'is', null)
    .gte('claimed_at', new Date(now.getTime() - NUDGE_WINDOW_DAYS * DAY_MS).toISOString())
    .lte('claimed_at', new Date(now.getTime() - DAY_MS).toISOString())
    .order('claimed_at', { ascending: true })
    .limit(BATCH)
  if (error) return null
  const rows = (data as DraftRow[] | null) ?? []
  // Bounded concurrency: each candidate costs up to four reads (shop, prefs, products, deleted ids), so the batch runs
  // CANDIDATE_CHUNK at a time rather than all 200 at once against Supabase and the backend.
  const out: NudgeCandidate[] = []
  for (let i = 0; i < rows.length; i += CANDIDATE_CHUNK) {
    out.push(...(await Promise.all(rows.slice(i, i + CANDIDATE_CHUNK).map(candidateFor))))
  }
  return out
}

/**
 * Record the milestone on the draft: an optimistic write guarded on `updated_at`, scoped to the keeper, that reads
 * the row back. `block_status` is merged (`withNudge`), never replaced, so S4's `photo_confirms` survives — and a photo
 * confirm racing this write makes one of the two re-read and re-apply, not overwrite.
 */
async function claim(draftId: string, day: NudgeDay, at: string): Promise<boolean> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const { data, error } = await db.from('shop_drafts').select('block_status, updated_at, claimed_by').eq('id', draftId).maybeSingle()
    if (error || !data) return false
    const row = data as { block_status: unknown; updated_at: string; claimed_by: string | null }
    if (!row.claimed_by) return false
    const next = withNudge(row.block_status, day, at)
    if (!next) return false
    const prev = Date.parse(row.updated_at)
    const stamp = new Date(Number.isFinite(prev) ? Math.max(Date.now(), prev + 1) : Date.now()).toISOString()
    const { data: written, error: writeError } = await db
      .from('shop_drafts')
      .update({ block_status: next, updated_at: stamp })
      .eq('id', draftId)
      .eq('claimed_by', row.claimed_by)
      .eq('updated_at', row.updated_at)
      .select('id')
    if (writeError) return false
    if (Array.isArray(written) && written.length === 1) return true
  }
  return false
}

export function nudgeCronDeps(): NudgeCronDeps {
  return {
    loadCandidates,
    claim,
    send: async ({ draftId, clerkUserId, day, step, shopName: name }) => {
      const shopName = name || 'Tu tienda'
      const copy = NUDGE_STEP_COPY[step]
      await dispatchToSeller(clerkUserId, {
        group: 'onboarding',
        email: async (to) => {
          const r = await sendP2sNudge({ to, shopName, step, day, draftId })
          if (!r.ok) console.error('[p2s] nudge email failed', r.reason)
        },
        push: { kind: 'onboarding_nudge', title: NUDGE_COPY.pushTitle(shopName), body: copy.title, url: '/sell/armar', tag: `p2s-nudge-${draftId}` },
        telegram: `<b>${escapeHtml(NUDGE_COPY.heading(shopName))}</b>\n${escapeHtml(copy.title)}. ${escapeHtml(copy.lead)}\n${SITE}/sell/armar`,
      })
      console.info('[p2s]', JSON.stringify({ step: 'nudge', draft_id: draftId, day, next: step }))
    },
    now: () => new Date(),
    log: (line) => console.error('[p2s]', JSON.stringify(line)),
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
