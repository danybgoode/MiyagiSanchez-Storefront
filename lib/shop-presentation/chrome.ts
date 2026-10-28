/**
 * Living Shop — what the shop's chrome shows (epic 07, Sprint 8).
 *
 * Pure and next-free: these functions decide WHAT a header, hero, rail panel or
 * post head displays, given data the page already fetched. The components render
 * the result and hold no derivation of their own, which is what makes every
 * "…and what is withheld when the data is absent" rule testable without a
 * browser.
 *
 * The governing rule, stated once: **a panel with nothing real behind it does
 * not render.** The concept mockup is full of plausible copy — "Usually ships in
 * 2–4 days", "Next market: Roma Norte" — and inventing that for a shop that
 * never configured it would be the confident falsehood this codebase keeps
 * paying for. Every derivation below returns null rather than a placeholder.
 */

import type { Shop } from '@/lib/types'

/**
 * 🚨 A SHOP HAS TWO BASES, AND CONFUSING THEM 404s.
 *
 * `shopBase` is where the shop's OWN routes live — `/tienda`, `/colecciones`,
 * `/c/[handle]`, `/acerca`. On the marketplace that is `/mx/s/<slug>`; on an
 * owned host it is `''`.
 *
 * `listingBase` is where a PRODUCT lives, and a product is NOT shop-scoped on
 * the marketplace: the PDP is `/mx/l/<id>`, never `/mx/s/<slug>/l/<id>` — no
 * such route exists. On an owned host the two coincide (`''`), which is exactly
 * why the mistake was invisible until someone opened a marketplace shop.
 *
 * Reported live: every product on `/mx/s/el-manchon/tienda` 404'd, while the
 * same product from the homepage grid worked, because the homepage happened to
 * build its own links from the market base and everything I added built them
 * from the shop base.
 *
 * Returning them as one object with two names is deliberate: a single
 * `basePath` string invites exactly this bug, and a call site that has to pick
 * between two named fields has to think about which one it means.
 */
export interface ShopBases {
  /** `/mx/s/<slug>` on the marketplace, `''` on an owned host. */
  shopBase: string
  /** `/mx` on the marketplace, `''` on an owned host. Products live here. */
  listingBase: string
}

/** The PDP href for a listing. The ONE place that knows a product is not shop-scoped. */
export function listingHref(bases: Pick<ShopBases, 'listingBase'>, listingId: string): string {
  return `${bases.listingBase}/l/${listingId}`
}

/**
 * The shop index's product-grid columns. Lives here, not beside the grid component, so the prompt-to-shop canvas
 * can lay its example cards out on the very same columns without importing the cart-aware card (and its client JS).
 */
export const SHOP_INDEX_GRID_CLASS = 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3'

/** Initials for a shop with no logo. Two letters, from the first two words. */
export function shopInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export interface HeroContent {
  /** Category · location, or just one of them. Null when the shop has neither. */
  eyebrow: string | null
  /** The display headline — the tagline if authored, else the shop's name. */
  headline: string
  /** The lead paragraph. Null when the shop has no description. */
  lead: string | null
  /** Whether there is enough here to be worth a hero at all. */
  substantial: boolean
}

/**
 * The hero's words.
 *
 * `substantial` is the honest half: a shop with no tagline AND no description
 * has nothing to say yet, so the page renders identity only rather than a
 * headline-sized restatement of the shop's own name over an empty frame.
 */
export function heroContent(shop: Pick<Shop, 'name' | 'description' | 'location'>, tagline: string | null): HeroContent {
  const trimmedTagline = tagline?.trim() || null
  const description = shop.description?.trim() || null
  const location = shop.location?.trim() || null
  return {
    eyebrow: location,
    headline: trimmedTagline || shop.name,
    lead: description,
    substantial: !!(trimmedTagline || description),
  }
}

export interface TrustChip {
  key: 'verified' | 'ships' | 'pickup'
}

/**
 * The About panel's chips — only facts the shop actually carries.
 *
 * The mockup shows three; a real shop may warrant none, and three chips that
 * are true of every shop would say nothing about this one.
 */
export function trustChips(input: {
  verified: boolean
  shipsNationwide: boolean
  localPickup: boolean
}): TrustChip[] {
  const chips: TrustChip[] = []
  if (input.verified) chips.push({ key: 'verified' })
  if (input.shipsNationwide) chips.push({ key: 'ships' })
  if (input.localPickup) chips.push({ key: 'pickup' })
  return chips
}

export interface ShopStatus {
  /** e.g. "2–4 días" — the seller's own configured processing time. */
  dispatch: string | null
  /** The next upcoming event's title + date, already formatted by the caller. */
  nextEvent: string | null
}

/** True when the Shop-status panel has at least one real fact to show. */
export function hasShopStatus(status: ShopStatus): boolean {
  return !!(status.dispatch || status.nextEvent)
}

/**
 * A relative day label for a Wall post: today, yesterday, N days ago, or an
 * absolute date beyond the cutoff.
 *
 * Returns a KEY plus its value rather than a sentence, so the caller supplies
 * the localized string — building "Hace 3 días" here would hardcode Spanish
 * into a surface that renders in two languages.
 */
export type RelativeDay =
  | { kind: 'today' }
  | { kind: 'yesterday' }
  | { kind: 'days'; days: number }
  | { kind: 'absolute' }

export function relativeDay(iso: string, now: Date, cutoffDays = 7): RelativeDay {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return { kind: 'absolute' }
  // Compare CALENDAR days, not elapsed hours: something posted at 23:00 is
  // "yesterday" at 01:00, not "today", and a merchant reads it that way.
  const startOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const days = Math.round((startOf(now) - startOf(new Date(then))) / 86_400_000)
  if (days <= 0) return { kind: 'today' }
  if (days === 1) return { kind: 'yesterday' }
  if (days < cutoffDays) return { kind: 'days', days }
  return { kind: 'absolute' }
}

/**
 * WHICH rail panels have something real in them.
 *
 * 🚨 ONE DERIVATION, because there were two and they disagreed. The page counted
 * panels from `[about||contacts, collections, dispatch]` while the component
 * decided to render the About panel from `about || chips || contacts ||
 * claimHref` — so an unclaimed shop with no About (`el-manchon`) rendered a
 * panel the count said did not exist, the second track never opened, and the
 * Wall stacked full-width above a lone floating panel. Two independent
 * derivations of the same question is the trap this epic has now hit three
 * times; the count and the render read this function.
 */
export interface RailInputs {
  about: string | null
  chipCount: number
  contactCount: number
  hasClaim: boolean
  collectionCount: number
  hasStatus: boolean
}

export interface RailPanels {
  about: boolean
  collections: boolean
  status: boolean
  count: number
}

export function railPanels(input: RailInputs): RailPanels {
  const about = !!input.about || input.chipCount > 0 || input.contactCount > 0 || input.hasClaim
  const collections = input.collectionCount > 0
  const status = input.hasStatus
  return { about, collections, status, count: [about, collections, status].filter(Boolean).length }
}

/**
 * Whether the supporting rail should occupy its own grid track.
 *
 * EVERY THEME GETS THE SHELL. The design concept uses one Wall-beside-rail
 * layout for all of its themes and overrides it for none; making it a per-recipe
 * choice was an invention, and it left the four presets that predate the Wall
 * rendering a lone column that reads as a leftover. So the only question left is
 * the honest one: is there anything to put in the rail?
 *
 * A rail of empty panels is an empty column wearing a border — which is the
 * defect this predicate originally shipped to close.
 */
export function railOccupiesTrack(panelCount: number): boolean {
  return panelCount > 0
}

/**
 * Whether the Wall should render as a narrow column at all.
 *
 * A Wall in a 1fr track with NO rail beside it is a full-width column of posts,
 * which reads as a broken layout rather than a feed — reported live on
 * `el-manchon`. When the rail is not taking a track, the shell constrains the
 * Wall to a readable measure instead of letting it span the page.
 */
export function wallIsNarrow(railInTrack: boolean): boolean {
  return !railInTrack
}
