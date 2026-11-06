/**
 * lib/promoter-panel.ts — the promoter panel's pure rules (epic 08 · promoter-panel). Next-free and dependency-free,
 * so the Playwright `api` runner tests them directly.
 *
 * - Where the merchant sells today (D6), stored in `merchant_relationships.current_channels`, and the path it gives
 *   step 2 «Sus productos» (D9).
 * - The import cap (D4, Daniel 2026-11-05): up to 150 products are part of opening the shop, in every package; a bigger
 *   catalog is the paid «Migración con consultor», and the merchant can always import the rest for free from their own
 *   panel after the claim. 150 is `MIGRATION_FLAT_LISTING_CAP` — the same number the paid migration's flat price covers.
 */
import { MIGRATION_FLAT_LISTING_CAP } from './migration-estimate'

/** Where a merchant sells today. A closed list: the panel shows it as a dropdown, never free text (Daniel). */
export const SELLS_TODAY = ['none', 'social', 'mercadolibre', 'shopify', 'tiendanube', 'woocommerce', 'bigcartel', 'other'] as const
export type SellsToday = (typeof SELLS_TODAY)[number]

export function isSellsToday(value: unknown): value is SellsToday {
  return typeof value === 'string' && (SELLS_TODAY as readonly string[]).includes(value)
}

/** Step 2's path: a Shopify import, an export file, the Mercado Libre note, or typed cards. Cards are always below. */
export type StepTwoPath = 'shopify' | 'file' | 'mercadolibre' | 'cards'

export function stepTwoPath(sellsToday: unknown): StepTwoPath {
  if (sellsToday === 'shopify') return 'shopify'
  // Big Cartel publishes no product export (only orders — its help center, read 2026-11-05), so it types its products.
  if (sellsToday === 'tiendanube' || sellsToday === 'woocommerce') return 'file'
  if (sellsToday === 'mercadolibre') return 'mercadolibre'
  return 'cards'
}

/** How many products an import in the panel brings (D4). */
export const PROMOTER_IMPORT_CAP = MIGRATION_FLAT_LISTING_CAP

/**
 * How many of `total` new products an import may add, given the products the shop ALREADY has (pr-reviewer, #480):
 * the 150 are for opening the shop, so re-sending a file or confirming a batch twice can't add products 151–300.
 * An unreadable count is never passed here — the caller fails closed first.
 */
export function importCapPlan(total: number, alreadyInShop = 0): { take: number; overCap: number } {
  const safe = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  const have = Number.isFinite(alreadyInShop) && alreadyInShop > 0 ? Math.floor(alreadyInShop) : 0
  const room = Math.max(0, PROMOTER_IMPORT_CAP - have)
  const take = Math.min(safe, room)
  return { take, overCap: safe - take }
}

/**
 * One import at a time per shop (Codex security, #480): two simultaneous imports both passed the "already have it?"
 * check and created the same products. The lock is a dated key on the shop's metadata, claimed with a guarded write;
 * a lock older than the TTL is stale (a crashed request) and may be taken over.
 */
export const IMPORT_LOCK_KEY = 'import_lock'
export const IMPORT_LOCK_TTL_MS = 10 * 60 * 1000

export function importLockState(metadata: unknown, now: Date = new Date()): 'free' | 'busy' {
  const meta = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {}
  const lock = meta[IMPORT_LOCK_KEY] as { at?: unknown } | null | undefined
  if (!lock || typeof lock !== 'object' || typeof lock.at !== 'string') return 'free'
  const at = Date.parse(lock.at)
  return Number.isFinite(at) && now.getTime() - at < IMPORT_LOCK_TTL_MS ? 'busy' : 'free'
}

const onlyDigits = (v: string) => v.replace(/\D/g, '')

/**
 * The WhatsApp as the promoter sees it: a Mexican number as its 10 digits; any other country kept whole with its `+`,
 * so saving never turns a `+1…` number into a `+52…` one (pr-reviewer, #481).
 */
export function whatsappForDisplay(e164: string | null | undefined): string {
  if (!e164) return ''
  return e164.startsWith('+52') ? onlyDigits(e164).slice(-10) : e164
}

/** 10 digits (Mexico), or a full international number with its `+` (11–15 digits). */
export function whatsappIsValid(value: string): boolean {
  const d = onlyDigits(value)
  return value.trim().startsWith('+') ? d.length >= 11 && d.length <= 15 : d.length === 10
}

/** What the form sends: an international number as typed (with `+`), a Mexican one as its digits. */
export function whatsappForSave(value: string): string {
  return value.trim().startsWith('+') ? value.trim() : onlyDigits(value)
}

/**
 * The lead's `current_channels` after a save: our «¿Vende hoy en otra plataforma?» answer replaces only our own value,
 * and anything else already there (a founding-merchant application's free text) stays (pr-reviewer, #481).
 */
export function mergeCurrentChannels(existing: readonly string[], ours: SellsToday | null): string[] {
  return [...existing.filter((c) => !isSellsToday(c)), ...(ours ? [ours] : [])]
}
