/**
 * lib/negocio-manage.ts — the owner opens Stripe's page for their MONTHLY Plan Negocio: card, invoices and cancelling
 * (Daniel, 2026-11-05: a merchant must be able to cancel the monthly plan themselves).
 *
 * The shop is the caller's own (the route reads it by `clerk_user_id`); nothing in the request names a shop or a
 * customer. The subscription is found in Stripe by the metadata the Negocio checkout writes on it (`kind`, `shop_id`,
 * `seller_clerk_id`), and it must match BOTH this shop and this user, so one owner can never open another's billing.
 *
 * Pure decision (`pickNegocioSubscription`) + a thin shell with the Stripe calls injected.
 */
import { NEGOCIO_CHECKOUT_KIND } from './negocio-kind'

export type NegocioSubscriptionLike = {
  id: string
  status: string
  customer: string | { id: string } | null
  metadata: Record<string, string> | null
  created: number
}

/** Statuses an owner may still manage: paying, in its free period, or a failed payment Stripe is retrying. */
const MANAGEABLE = new Set(['active', 'trialing', 'past_due', 'unpaid'])

/** The newest manageable Negocio subscription of THIS shop and THIS user, with its customer id — or null. */
export function pickNegocioSubscription(
  subs: readonly NegocioSubscriptionLike[],
  shopId: string,
  sellerClerkId: string,
): { subscriptionId: string; customerId: string } | null {
  const match = subs
    .filter((s) =>
      s.metadata?.kind === NEGOCIO_CHECKOUT_KIND &&
      s.metadata?.shop_id === shopId &&
      s.metadata?.seller_clerk_id === sellerClerkId &&
      MANAGEABLE.has(s.status),
    )
    .sort((a, b) => b.created - a.created)[0]
  if (!match) return null
  const customerId = typeof match.customer === 'string' ? match.customer : match.customer?.id ?? null
  return customerId ? { subscriptionId: match.id, customerId } : null
}

/** A Stripe search query value must be a plain id: anything with a quote or a backslash could change the query. */
export function isSafeSearchValue(v: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(v)
}

export type NegocioManageDeps = {
  searchSubscriptions: (query: string) => Promise<NegocioSubscriptionLike[]>
  createPortal: (customerId: string, returnUrl: string) => Promise<string>
}

export type NegocioManageResult = { ok: true; url: string } | { ok: false; status: number; error: string }

export async function startNegocioManage(
  input: { shopId: string; sellerClerkId: string; returnUrl: string },
  deps: NegocioManageDeps,
): Promise<NegocioManageResult> {
  if (!isSafeSearchValue(input.shopId)) return { ok: false, status: 400, error: 'Tienda no válida.' }
  let subs: NegocioSubscriptionLike[]
  try {
    subs = await deps.searchSubscriptions(`metadata['kind']:'${NEGOCIO_CHECKOUT_KIND}' AND metadata['shop_id']:'${input.shopId}'`)
  } catch {
    return { ok: false, status: 503, error: 'No pudimos abrir tus pagos ahora. Intenta en unos minutos.' }
  }
  const picked = pickNegocioSubscription(subs, input.shopId, input.sellerClerkId)
  // Stripe's search can lag a minute behind a brand-new subscription, so "not found" says to try again shortly.
  if (!picked) {
    return { ok: false, status: 404, error: 'No encontramos un Plan Negocio mensual en esta tienda. Si acabas de contratarlo, intenta en un minuto.' }
  }
  try {
    return { ok: true, url: await deps.createPortal(picked.customerId, input.returnUrl) }
  } catch {
    return { ok: false, status: 503, error: 'No pudimos abrir tus pagos ahora. Escríbenos y lo resolvemos contigo.' }
  }
}
