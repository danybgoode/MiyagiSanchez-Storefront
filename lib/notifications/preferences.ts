/**
 * Pure notification-preference model + resolver.
 *
 * No `server-only`, no `next/*` imports — so the Playwright runner (and any unit
 * test) can import this module directly. Per LEARNINGS: a unit-tested helper must
 * not pull in `next/cache`/`server-only`; keep the pure logic here and let the
 * server-only dispatcher (`dispatch.ts`) import *it*.
 *
 * Model: a seller's preferences form a grid of event-groups × channels. The store
 * is sparse — only explicit toggles are persisted. An absent row resolves to
 * **enabled** (`DEFAULT_PREFS`), so the 164 existing sellers (zero rows) keep
 * today's behaviour with no backfill.
 */

// `onboarding` (prompt-to-shop S5.4, D19): the day 1/3/7 reminders to finish a shop. A SELLER group — it is about the
// merchant's own shop — so it sits here and never in `BUYER_EVENT_GROUPS`. `notification_preferences.event_group` has
// no CHECK constraint (verified live before S5), so a new group needs no migration.
export const EVENT_GROUPS = ['orders', 'offers', 'payments', 'returns', 'mensajes', 'onboarding'] as const
export type EventGroup = (typeof EVENT_GROUPS)[number]

export const CHANNELS = ['email', 'push', 'telegram'] as const
export type Channel = (typeof CHANNELS)[number]

/**
 * Concrete seller-facing events → their preference group. Sprint 1 routes only
 * the two already-durable events. Sprint 3 adds the genuinely buyer-/system-
 * triggered seller events: `buyer_reported_paid` → payments (the money-path
 * keystone, #3b's durable event) and `return_requested` → returns.
 *
 * Deliberately NOT routed through the seam (seller-self-triggered → notifying the
 * seller of their own click is noise): `payment_confirmed`, `order_shipped`,
 * `order_delivered`. Their state vocabulary still lives in
 * `lib/manual-payment-state.ts`; the seam just doesn't echo them back to the actor.
 *
 * `ml_order_*` (ml-orders-native S2 · US-5): unlike native `order_shipped`/
 * `order_delivered` above, an ML order's shipped/delivered/cancelled transitions
 * are NEVER seller-initiated in Miyagi — they're driven by Mercado Libre / the
 * backend reconcile job — so all four ML lifecycle events route through `orders`,
 * consistent with (not an exception to) the self-notify rule.
 */
export const EVENT_GROUP = {
  new_order: 'orders',
  offer_made: 'offers',
  // A buyer's question. Added 2026-08-15: conversations had NO group, so
  // `/api/conversations/start` notified nobody and a reply sent web push only —
  // which is a silent no-op for the majority of sellers, who have no subscription.
  conversation_message: 'mensajes',
  buyer_reported_paid: 'payments',
  return_requested: 'returns',
  ml_order_new: 'orders',
  ml_order_shipped: 'orders',
  ml_order_delivered: 'orders',
  ml_order_cancelled: 'orders',
  // Platform-triggered, never the seller's own click: the cron sends it to a merchant who stopped half way.
  p2s_nudge: 'onboarding',
} as const satisfies Record<string, EventGroup>
export type SellerEventKind = keyof typeof EVENT_GROUP

/** Shape of a persisted `notification_preferences` record. */
export type PrefRow = { channel: string; event_group: string; enabled: boolean }

/** Resolved grid: group → channel → enabled. */
export type Prefs = Record<EventGroup, Record<Channel, boolean>>

/**
 * Per-channel default when a seller has no explicit row.
 *   email / push → ON (default-on = zero regression for the 164 existing sellers).
 *   telegram     → OFF (opt-in): Telegram couldn't deliver before Sprint 2, so a
 *                  freshly-linked seller doesn't get flooded — they turn on the
 *                  groups they want. There is no regression either way (net-new).
 */
export const CHANNEL_DEFAULTS: Record<Channel, boolean> = {
  email: true,
  push: true,
  telegram: false,
}

// ── Generic, audience-agnostic core ───────────────────────────────────────────
// One grid-build + overlay engine, shared by both audiences (the seller groups
// above and the buyer namespace at the bottom of this file). Per LEARNINGS (#5
// retro): extract the seam once, then project each audience onto it — so a second
// audience reuses the channel logic verbatim instead of forking the resolver.

/** Build a fresh grid (group → channel → default) for an arbitrary group set. */
function buildGrid<G extends string>(groups: readonly G[]): Record<G, Record<Channel, boolean>> {
  return groups.reduce((acc, g) => {
    acc[g] = CHANNELS.reduce((c, ch) => {
      c[ch] = CHANNEL_DEFAULTS[ch]
      return c
    }, {} as Record<Channel, boolean>)
    return acc
  }, {} as Record<G, Record<Channel, boolean>>)
}

function isChannel(v: string): v is Channel {
  return (CHANNELS as readonly string[]).includes(v)
}

/**
 * Overlay persisted rows on a fresh default grid for the given group set. Rows
 * whose group isn't in `groups` (or whose channel is unknown) are ignored — this
 * is the audience isolation: resolving the buyer grid never reads a seller
 * `orders` row, and resolving the seller grid never reads a `buyer.*` row.
 */
function overlayRows<G extends string>(
  groups: readonly G[],
  rows: PrefRow[] | null | undefined,
): Record<G, Record<Channel, boolean>> {
  const grid = buildGrid(groups)
  const isGroup = (v: string): v is G => (groups as readonly string[]).includes(v)
  for (const row of rows ?? []) {
    if (isGroup(row.event_group) && isChannel(row.channel)) {
      grid[row.event_group][row.channel] = !!row.enabled
    }
  }
  return grid
}

/** The default grid: email/push on, telegram opt-in (off). */
export const DEFAULT_PREFS: Prefs = buildGrid(EVENT_GROUPS)

/** Overlay persisted seller rows on the defaults. Unknown/invalid keys ignored. */
export function resolvePrefs(rows: PrefRow[] | null | undefined): Prefs {
  return overlayRows(EVENT_GROUPS, rows)
}

/**
 * Is `channel` enabled for `group` in these prefs? Falls back to the channel's
 * own default if the cell is unknown (email/push on, telegram off).
 */
export function isChannelEnabled(prefs: Prefs, group: EventGroup, channel: Channel): boolean {
  return prefs[group]?.[channel] ?? CHANNEL_DEFAULTS[channel]
}

/** A persisted Telegram link (or null when the seller hasn't connected one). */
export type TelegramLink = { chat_id: string } | null

/**
 * Resolve the Telegram target for an event: the seller's linked chat_id when the
 * group is enabled on Telegram AND a link exists; otherwise null (no send). Pure
 * so the dispatcher's linked/unlinked/group-off decision is unit-testable.
 */
export function telegramTarget(prefs: Prefs, group: EventGroup, link: TelegramLink): string | null {
  if (!link) return null
  return isChannelEnabled(prefs, group, 'telegram') ? link.chat_id : null
}

/** Resolve the preference group for a concrete event kind. */
export function groupForEvent(kind: SellerEventKind): EventGroup {
  return EVENT_GROUP[kind]
}

// ── Settings copy (es-MX, matches the seller portal) ──────────────────────────────
//
// The label + one-line summary of what each group actually notifies about. Lives
// here (next-free, the EVENT_GROUP source of truth) so the settings UI and the
// completeness spec share ONE definition — the summary can't drift from what the
// seam really sends. es-MX, consistent with the rest of the seller portal.

export const GROUP_COPY: Record<EventGroup, { label: string; summary: string }> = {
  orders:   { label: 'Pedidos',      summary: 'Cuando recibes una venta nueva.' },
  offers:   { label: 'Ofertas',      summary: 'Cuando alguien hace una oferta.' },
  payments: { label: 'Pagos',        summary: 'Cuando el comprador avisa que ya pagó.' },
  returns:  { label: 'Devoluciones', summary: 'Cuando un comprador solicita una devolución.' },
  mensajes: { label: 'Mensajes',     summary: 'Cuando alguien te escribe sobre un anuncio.' },
  onboarding: { label: 'Arma tu tienda', summary: 'Un recordatorio del paso que te falta para publicar tu tienda.' },
}

// ══════════════════════════════════════════════════════════════════════════════
// BUYER audience (epic #5b) — a second namespace over the SAME tables + channels.
//
// Buyer preference groups are stored in `notification_preferences` with an
// audience-namespaced `event_group` (`buyer.compras` … ) so they never collide
// with the seller keys (`orders|offers|payments|returns`). A person who is both
// buyer and seller therefore keeps two independent grids in one table — no new
// column, no migration. The pure core above (`buildGrid`/`overlayRows`/channel
// defaults) is reused verbatim; only the group set, the copy, the event map and
// the **forced-on receipt** are buyer-specific.
// ══════════════════════════════════════════════════════════════════════════════

export const BUYER_EVENT_GROUPS = [
  'buyer.compras',
  'buyer.envios',
  'buyer.ofertas',
  'buyer.devoluciones',
  'buyer.mensajes',
] as const
export type BuyerEventGroup = (typeof BUYER_EVENT_GROUPS)[number]

/** Resolved buyer grid: buyer-group → channel → enabled. */
export type BuyerPrefs = Record<BuyerEventGroup, Record<Channel, boolean>>

/**
 * The one cell that can never be turned off: the purchase + payment **receipt**
 * email. Enforced in the resolver (single source of truth), not just hidden in
 * the UI — so no caller, API write, or agent can suppress a buyer's receipt.
 */
export const BUYER_FORCED_ON: { group: BuyerEventGroup; channel: Channel } = {
  group: 'buyer.compras',
  channel: 'email',
}

export function isBuyerForcedCell(group: BuyerEventGroup, channel: Channel): boolean {
  return group === BUYER_FORCED_ON.group && channel === BUYER_FORCED_ON.channel
}

/**
 * Concrete buyer-facing events → their preference group.
 *   Compras      — order + payment confirmed (receipt; email forced-on).
 *   Envíos       — shipped + delivered.
 *   Ofertas      — the seller's response to the buyer's offer.
 *   Devoluciones — return request confirmed / accepted / declined.
 * Sprint 1 routes Envíos / Ofertas / Devoluciones; Compras is wired in Sprint 2
 * (it fires from the Stripe/MP payment webhooks — off the money-path this sprint).
 */
export const BUYER_EVENT_GROUP = {
  order_confirmed:   'buyer.compras',
  payment_confirmed: 'buyer.compras',
  order_shipped:     'buyer.envios',
  order_delivered:   'buyer.envios',
  offer_accepted:    'buyer.ofertas',
  offer_countered:   'buyer.ofertas',
  offer_declined:    'buyer.ofertas',
  return_requested:  'buyer.devoluciones',
  return_accepted:   'buyer.devoluciones',
  return_declined:   'buyer.devoluciones',
  conversation_message: 'buyer.mensajes',
} as const satisfies Record<string, BuyerEventGroup>
export type BuyerEventKind = keyof typeof BUYER_EVENT_GROUP

/** Resolve the buyer preference group for a concrete buyer event kind. */
export function groupForBuyerEvent(kind: BuyerEventKind): BuyerEventGroup {
  return BUYER_EVENT_GROUP[kind]
}

/**
 * Overlay persisted buyer rows on the buyer defaults, then **force the receipt
 * cell on** unconditionally. Seller rows (group ∉ BUYER_EVENT_GROUPS) are ignored
 * by `overlayRows` → buyer/seller isolation. Absent rows ⇒ buyer defaults
 * (email/push on, telegram opt-in off) — no backfill for existing buyers.
 */
export function resolveBuyerPrefs(rows: PrefRow[] | null | undefined): BuyerPrefs {
  const prefs = overlayRows(BUYER_EVENT_GROUPS, rows) as BuyerPrefs
  prefs[BUYER_FORCED_ON.group][BUYER_FORCED_ON.channel] = true
  return prefs
}

/** The default buyer grid (receipt forced on; email/push on; telegram off). */
export const BUYER_DEFAULT_PREFS: BuyerPrefs = resolveBuyerPrefs(null)

/**
 * Is `channel` enabled for buyer `group`? The forced receipt cell is always on,
 * regardless of any stored value; otherwise falls back to the channel default.
 */
export function isBuyerChannelEnabled(
  prefs: BuyerPrefs,
  group: BuyerEventGroup,
  channel: Channel,
): boolean {
  if (isBuyerForcedCell(group, channel)) return true
  return prefs[group]?.[channel] ?? CHANNEL_DEFAULTS[channel]
}

/**
 * Resolve the buyer's Telegram target for an event (Sprint 2 wires the send):
 * the linked chat_id when the group is on for Telegram AND a link exists; else
 * null. Pure, so the dispatcher's linked/unlinked/group-off decision is testable.
 */
export function buyerTelegramTarget(
  prefs: BuyerPrefs,
  group: BuyerEventGroup,
  link: TelegramLink,
): string | null {
  if (!link) return null
  return isBuyerChannelEnabled(prefs, group, 'telegram') ? link.chat_id : null
}

// ── Buyer settings copy (es-MX) ───────────────────────────────────────────────
// Single source the buyer preference center renders AND the completeness spec
// checks — so the per-group summary can't drift from what the seam sends.

export const BUYER_GROUP_COPY: Record<BuyerEventGroup, { label: string; summary: string }> = {
  'buyer.compras':      { label: 'Compras',      summary: 'Confirmación de tu compra y de tu pago.' },
  'buyer.envios':       { label: 'Envíos',       summary: 'Cuando tu pedido se envía y cuando llega.' },
  'buyer.ofertas':      { label: 'Ofertas',      summary: 'Cuando el vendedor responde tu oferta.' },
  'buyer.devoluciones': { label: 'Devoluciones', summary: 'Avances de tus solicitudes de devolución.' },
  'buyer.mensajes':     { label: 'Mensajes',     summary: 'Cuando el vendedor responde tu mensaje.' },
}

// ── Dual-audience Telegram (epic #5b · Sprint 2) ──────────────────────────────
// `telegram_links` is one shared row per person (PK clerk_user_id). Per-audience
// "use" is derived from the prefs, not the link: a person uses Telegram for an
// audience iff they have an enabled telegram pref in that audience's groups. This
// lets an unlink (buyer or seller) delete the shared row ONLY when no audience
// still uses it — no schema change.

export type Audience = 'seller' | 'buyer'

/** Does `audience` still have any Telegram-enabled group in these pref rows? */
export function audienceTelegramInUse(
  rows: PrefRow[] | null | undefined,
  audience: Audience,
): boolean {
  const groups = new Set<string>(audience === 'seller' ? EVENT_GROUPS : BUYER_EVENT_GROUPS)
  for (const r of rows ?? []) {
    if (r.channel === 'telegram' && !!r.enabled && groups.has(r.event_group)) return true
  }
  return false
}
