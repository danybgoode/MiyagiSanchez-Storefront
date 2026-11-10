/**
 * The monthly check-in's I/O (business-infrastructure S3.4, D12). Every decision lives in `checkin.ts`.
 *
 * - rows: every `business_models` row (service role; the table is small and bounded by shops).
 * - ledger: `GET /internal/profit/ledger?seller_id=` on the backend with the shared internal secret — the same read
 *   the seller's own «Ganancias» uses (backend `readSellerLedger`). Without the secret it is "could not read".
 * - claim: a conditional `last_checkin_period` write, read back — a second run the same month claims nothing.
 * - send: `dispatchToSeller` group `onboarding`, so the merchant's own channel switches decide email/push/Telegram.
 */

import 'server-only'
import { db } from '@/lib/supabase'
import { sendBusinessCheckin } from '@/lib/email'
import { dispatchToSeller } from '@/lib/notifications/dispatch'
import type { ProfitEvent, ProfitOrderInfo } from '@/lib/profit'
import { CHECKIN_COPY } from './copy'
import { moveSentence } from './explain'
import { reportedPeriod, type CheckinDeps, type CheckinMessage, type CheckinRow } from './checkin'
import { getShop } from '@/lib/listings'
import { planGetsCheckin } from '@/lib/plan'
import { resolvePlan } from '@/lib/plan-server'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const INTERNAL_SECRET = process.env.MEDUSA_INTERNAL_SECRET ?? ''
const SITE = 'https://miyagisanchez.com'
/** One run's ceiling: far above today's shops, and bounded. */
const BATCH = 500

async function readLedgerInternal(sellerId: string): Promise<{ events: ProfitEvent[]; orders: ProfitOrderInfo[] } | null> {
  if (!INTERNAL_SECRET || !/^[A-Za-z0-9_]{1,80}$/.test(sellerId)) return null
  try {
    const res = await fetch(`${MEDUSA_BASE}/internal/profit/ledger?seller_id=${encodeURIComponent(sellerId)}`, {
      headers: { 'x-internal-secret': INTERNAL_SECRET },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as { events?: unknown; orders?: unknown } | null
    if (!body || !Array.isArray(body.events) || !Array.isArray(body.orders)) return null
    return { events: body.events as ProfitEvent[], orders: body.orders as ProfitOrderInfo[] }
  } catch {
    return null
  }
}

function telegramText(shopName: string, m: CheckinMessage, next: string | null): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)
  return [
    `<b>${esc(CHECKIN_COPY.subject(shopName, m.month))}</b>`,
    esc(CHECKIN_COPY.sold(m.month, m.sold)),
    esc(m.needed != null ? CHECKIN_COPY.versus(m.needed, m.sold) : CHECKIN_COPY.noGoal),
    ...(next ? [`${esc(CHECKIN_COPY.next)} ${esc(next)}`] : []),
    `${SITE}/shop/manage/plan`,
  ].join('\n')
}

export function checkinDeps(): CheckinDeps {
  return {
    readRows: async () => {
      const { data, error } = await db
        .from('business_models')
        .select('id, seller_id, clerk_user_id, shop_slug, inputs, last_checkin_period')
        // Only who still needs this month's: a full batch can never starve the rows past it (PR #468 review).
        .or(`last_checkin_period.is.null,last_checkin_period.neq.${reportedPeriod(new Date())}`)
        .order('created_at', { ascending: true })
        .limit(BATCH)
      return error || !Array.isArray(data) ? null : (data as CheckinRow[])
    },
    readLedger: readLedgerInternal,
    claim: async (rowId, period) => {
      const { data, error } = await db
        .from('business_models')
        .update({ last_checkin_period: period })
        .eq('id', rowId)
        .or(`last_checkin_period.is.null,last_checkin_period.neq.${period}`)
        .select('id')
      return !error && Array.isArray(data) && data.length === 1
    },
    send: async (row, message) => {
      const shop = row.shop_slug ? await getShop(row.shop_slug).catch(() => null) : null
      const shopName = shop?.name ?? row.shop_slug ?? 'Tu tienda'
      const next = message.next ? moveSentence(message.next) : null
      // `dispatchToSeller` swallows every channel error by design; the email's own result is surfaced here so the
      // run's `failed` count is real (PR #468 review). Push/Telegram stay best-effort, as everywhere.
      let emailFailed: string | null = null
      await dispatchToSeller(row.clerk_user_id, {
        group: 'onboarding',
        email: async (to) => {
          const r = await sendBusinessCheckin({ to, shopName, rowId: row.id, message, nextText: next })
          if (!r.ok) emailFailed = r.reason
        },
        push: { kind: 'business_checkin', title: CHECKIN_COPY.subject(shopName, message.month), body: CHECKIN_COPY.sold(message.month, message.sold), url: '/shop/manage/plan', tag: `business-checkin-${row.id}-${message.period}` },
        telegram: telegramText(shopName, message, next),
      })
      if (emailFailed) throw new Error(`email ${emailFailed}`)
    },
    // D9: the check-in is part of Negocio and its trial. Read uncached — a daily job, and the plan must be today's.
    planIncludesCheckin: async (row) => {
      if (!row.shop_slug) return null
      const { data, error } = await db.from('marketplace_shops').select('id, clerk_user_id, metadata').eq('slug', row.shop_slug).maybeSingle()
      if (error || !data) return null
      const shop = data as { id: string; clerk_user_id: string | null; metadata: unknown }
      const plan = await resolvePlan(shop.metadata, { sellerClerkId: shop.clerk_user_id, shopId: shop.id })
      return plan.reason === 'unavailable' ? null : planGetsCheckin(plan)
    },
    now: () => new Date(),
    log: (line) => console.info('[business-checkin]', JSON.stringify(line)),
  }
}
