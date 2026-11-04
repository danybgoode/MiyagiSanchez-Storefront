/**
 * The handoff's I/O (business-infrastructure S5, D17). Every decision is in `handoff.ts`.
 *
 * Ownership: a thread stores the shop owner's Clerk id at the time it was left, and every read and write of it is
 * scoped by that id, resolved from the CALLER's own session (`auth()`), never from a body or URL.
 */

import 'server-only'
import { db } from '@/lib/supabase'
import { readShopFresh } from '@/lib/listings'
import { isShopClaimed } from '@/lib/claim'
import { isShopPreviewPrivateBySlug } from '@/lib/preview-access'
import { checkRateLimit } from '@/lib/ratelimit'
import { dispatchToSeller } from '@/lib/notifications/dispatch'
import { sendShopAnswerToBuyer, sendShopQuestionToOwner } from '@/lib/email'
import { applyStoreConfig } from '@/lib/apply-config-manifest'
import { chatTokenSecret } from './server'
import { purgeCutoff, type ClaimedThread, type HandoffShop, type LeaveDeps, type ReplyDeps } from './handoff'

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)

export async function readHandoffShop(slug: string): Promise<HandoffShop | null | 'unavailable'> {
  const read = await readShopFresh(slug)
  if (read.state === 'unavailable') return 'unavailable'
  if (read.state === 'absent') return null
  const shop = read.shop
  if (!isShopClaimed(shop) || !shop.clerk_user_id) return null
  if (await isShopPreviewPrivateBySlug(shop.slug, shop.clerk_user_id)) return null
  return { slug: shop.slug, name: shop.name, sellerId: shop.id, ownerClerkUserId: shop.clerk_user_id }
}

export function leaveDeps(ip: string): LeaveDeps {
  return {
    rateAllowed: async (slug) => {
      // Its OWN buckets, sized for owner alerts, not chat turns (PR #470 review): each leave emails the owner.
      const [byIp, byShop] = await Promise.all([checkRateLimit('shop_chat_leave_ip', ip), checkRateLimit('shop_chat_leave_shop', slug)])
      return byIp.allowed && byShop.allowed
    },
    readShop: readHandoffShop,
    store: async ({ shop, question, transcript, email }) => {
      const { data, error } = await db
        .from('shop_chat_threads')
        .insert({ seller_id: shop.sellerId, owner_clerk_user_id: shop.ownerClerkUserId, shop_slug: shop.slug, question, transcript, buyer_email: email })
        .select('id')
        .single()
      return error || !data ? null : (data as { id: string }).id
    },
    notifyOwner: async (shop, threadId, question, transcript) => {
      await dispatchToSeller(shop.ownerClerkUserId, {
        group: 'mensajes',
        email: async (to) => { await sendShopQuestionToOwner({ to, shopName: shop.name, threadId, question, transcript }) },
        push: { kind: 'new_message', title: `${shop.name}: te dejaron una pregunta`, body: question.slice(0, 120), url: '/shop/manage/preguntas', tag: `shop-question-${threadId}` },
        telegram: `<b>${escapeHtml(shop.name)}: te dejaron una pregunta</b>\n${escapeHtml(question)}\nhttps://miyagisanchez.com/shop/manage/preguntas`,
      })
    },
    secret: chatTokenSecret(),
    now: () => Date.now(),
  }
}

export interface OwnerThread {
  id: string
  question: string
  transcript: Array<{ role: string; text: string }>
  status: 'open' | 'answered'
  reply: string | null
  created_at: string
  answered_at: string | null
  shop_slug: string
}

/** The caller's own threads, open first. `null` = could not read (never "none"). */
export async function listOwnerThreads(ownerClerkUserId: string): Promise<OwnerThread[] | null> {
  const { data, error } = await db
    .from('shop_chat_threads')
    .select('id, question, transcript, status, reply, created_at, answered_at, shop_slug')
    .eq('owner_clerk_user_id', ownerClerkUserId)
    .order('status', { ascending: false }) // 'open' sorts after 'answered' alphabetically; descending puts open first
    .order('created_at', { ascending: false })
    .limit(100)
  return error || !Array.isArray(data) ? null : (data as OwnerThread[])
}

export function replyDeps(owner: { clerkUserId: string; clerkJwt: string | null }): ReplyDeps {
  let shopSlug: string | null = null
  return {
    claim: async (threadId, ownerClerkUserId, reply) => {
      const { data, error } = await db
        .from('shop_chat_threads')
        .update({ status: 'answered', reply, answered_at: new Date().toISOString() })
        .eq('id', threadId)
        .eq('owner_clerk_user_id', ownerClerkUserId)
        .eq('status', 'open')
        .select('id, question, buyer_email, shop_slug')
      if (error) return 'unavailable'
      const row = Array.isArray(data) && data.length === 1 ? (data[0] as { id: string; question: string; buyer_email: string | null; shop_slug: string }) : null
      if (!row) return null
      shopSlug = row.shop_slug
      const read = await readShopFresh(row.shop_slug)
      const thread: ClaimedThread = {
        id: row.id, question: row.question, buyerEmail: row.buyer_email, shopSlug: row.shop_slug,
        shopName: read.state === 'resolved' ? read.shop.name : row.shop_slug,
      }
      return thread
    },
    release: async (threadId, ownerClerkUserId, reply) => {
      await db
        .from('shop_chat_threads')
        .update({ status: 'open', reply: null, answered_at: null })
        .eq('id', threadId)
        .eq('owner_clerk_user_id', ownerClerkUserId)
        .eq('status', 'answered')
        .eq('reply', reply)
    },
    emailBuyer: async (thread, reply) => {
      if (!thread.buyerEmail) return false
      const r = await sendShopAnswerToBuyer({ to: thread.buyerEmail, shopName: thread.shopName, shopSlug: thread.shopSlug, threadId: thread.id, question: thread.question, reply })
      return r.ok
    },
    readFaq: async () => {
      if (!shopSlug) return 'unavailable'
      const read = await readShopFresh(shopSlug)
      if (read.state !== 'resolved') return 'unavailable'
      // The shop must still be the caller's: a FAQ is written to the caller's own shop only.
      if (read.shop.clerk_user_id !== owner.clerkUserId) return 'unavailable'
      // …and it must be the shop the write lands on: `applyStoreConfig` writes the caller's OLDEST shop. Today no owner
      // has two (checked 2026-11-04), but nothing enforces it — never write one shop's FAQ into another (PR #470 review).
      const { data: target } = await db.from('marketplace_shops').select('slug').eq('clerk_user_id', owner.clerkUserId).order('created_at', { ascending: true }).limit(1).maybeSingle()
      if ((target as { slug?: string } | null)?.slug !== shopSlug) return 'unavailable'
      return ((read.shop.metadata as { settings?: { faq?: unknown } } | null)?.settings?.faq) ?? null
    },
    writeFaq: async (items) => {
      const result = await applyStoreConfig(owner.clerkUserId, owner.clerkJwt, { content: { faq: { items } } })
      return result.ok && result.appliedAny
    },
  }
}

/** Null the buyer emails of threads answered more than 90 days ago (run by the daily check-in timer). */
export async function purgeAnsweredEmails(now = new Date()): Promise<number | null> {
  const cutoff = purgeCutoff(now)
  const { data, error } = await db
    .from('shop_chat_threads')
    .update({ buyer_email: null })
    .not('buyer_email', 'is', null)
    // Answered more than 90 days ago, OR left unanswered for more than 90 days.
    // Values quoted: an ISO timestamp carries '.' and ':', which PostgREST's or() grammar would otherwise split on.
    .or(`answered_at.lt."${cutoff}",and(status.eq.open,created_at.lt."${cutoff}")`)
    .select('id')
  return error ? null : Array.isArray(data) ? data.length : 0
}
