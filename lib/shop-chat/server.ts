/**
 * The shop's chat — the real I/O behind `ChatDeps` (business-infrastructure S4). Every decision is in `handler.ts`.
 *
 * - The shop: Medusa seller by slug (`readShopFresh`), claimed (`isShopClaimed`), not preview-private; its public
 *   listings (`readShopListings`). Settings are the public projection the shop pages already render (FAQ, about,
 *   returns policy, how it charges and delivers).
 * - The spend: `spend_ai_allowance` with kind `daily_budget` on its own subjects (the table's CHECK allows only
 *   version/photo/daily_budget; the photo analysis uses the same pattern). An RPC error is a refusal (fails closed).
 * - The model: the same Gemini-on-Vertex credential and timeout as prompt-to-shop (`callModelBody`).
 * - The chat token's key is derived from the Turnstile secret with a fixed label: no new secret to provision, and it
 *   rotates with Turnstile (the chat cannot run without Turnstile anyway).
 */

import 'server-only'
import { createHmac } from 'node:crypto'
import { db } from '@/lib/supabase'
import { readShopFresh, readShopListings } from '@/lib/listings'
import { isShopClaimed } from '@/lib/claim'
import { isShopPreviewPrivateBySlug } from '@/lib/preview-access'
import { checkRateLimit } from '@/lib/ratelimit'
import { budgetPeriod, monthPeriod } from '@/lib/prompt-to-shop/allowance'
import { planForSlug } from '@/lib/plan-by-slug-server'
import { allowanceFor } from '@/lib/plan-allowances'
import { callModelBody } from '@/lib/prompt-to-shop/server'
import { verifyTurnstile } from '@/lib/prompt-to-shop/turnstile'
import type { ChatDeps, ChatShopRead } from './handler'

export function chatTokenSecret(): string {
  const base = process.env.TURNSTILE_SECRET_KEY?.trim()
  return base ? createHmac('sha256', base).update('miyagi-shop-chat-token-v1').digest('hex') : ''
}

export async function readChatShop(slug: string): Promise<ChatShopRead | null | 'unavailable'> {
  const read = await readShopFresh(slug)
  if (read.state === 'unavailable') return 'unavailable'
  if (read.state === 'absent') return null
  const shop = read.shop
  // An unclaimed shop has nobody to answer for it; a preview-private one is not public at all.
  if (!isShopClaimed(shop)) return null
  if (await isShopPreviewPrivateBySlug(shop.slug, shop.clerk_user_id)) return null
  const { listings } = await readShopListings(shop.slug)
  return {
    shop: {
      slug: shop.slug,
      name: shop.name,
      description: shop.description,
      location: shop.location,
      // The PUBLIC projection the backend already sanitized (no CLABE, no account ids).
      metadata: (shop.metadata as Record<string, unknown> | null) ?? null,
    },
    products: listings
      .filter((l) => l.status === 'published' || l.status === 'active')
      .map((l) => ({
        id: l.id,
        title: l.title,
        description: l.description,
        price_cents: l.price_cents,
        currency: l.currency,
        listing_type: l.listing_type,
        in_stock: l.in_stock,
        available_quantity: l.available_quantity ?? null,
        variant_count: l.variant_count,
      })),
  }
}

export async function spendChat(subject: string, cap: number): Promise<boolean> {
  const { data, error } = await db.rpc('spend_ai_allowance', {
    p_subject: subject,
    p_kind: 'daily_budget',
    p_period: budgetPeriod(new Date()),
    p_cap: cap,
  })
  // The RPC answers the NEW count, or NULL once the cap is reached. Anything else is a refusal.
  return !error && typeof data === 'number'
}

/** One answer from the shop's MONTHLY plan allowance (plans-gratis-negocio D8). NULL from the RPC = the cap is reached. */
export async function spendChatMonth(subject: string, cap: number): Promise<boolean> {
  const { data, error } = await db.rpc('spend_ai_allowance', {
    p_subject: subject,
    p_kind: 'chat_month',
    p_period: monthPeriod(new Date()),
    p_cap: cap,
  })
  return !error && typeof data === 'number'
}

/** The shop's monthly chat answers for its plan, or null when the plan could not be read (the handler then uses
 *  Gratis's, the lower amount). */
export async function chatMonthlyCap(slug: string): Promise<number | null> {
  const plan = await planForSlug(slug)
  return plan ? allowanceFor(plan.plan).chatAnswersPerMonth : null
}

export function chatDeps(ip: string): ChatDeps {
  return {
    rateAllowed: async (slug) => {
      const [byIp, byShop] = await Promise.all([checkRateLimit('shop_chat_ip', ip), checkRateLimit('shop_chat_shop', slug)])
      return byIp.allowed && byShop.allowed
    },
    readShop: readChatShop,
    verifyTurnstile: async (token) => (await verifyTurnstile({ secret: process.env.TURNSTILE_SECRET_KEY, token, ip })).ok,
    spend: spendChat,
    monthlyCap: chatMonthlyCap,
    spendMonth: spendChatMonth,
    callModel: (body) => callModelBody(body),
    secret: chatTokenSecret(),
    now: () => Date.now(),
    log: (line) => console.info('[shop-chat]', JSON.stringify(line)),
  }
}
