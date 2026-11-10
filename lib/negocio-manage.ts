/**
 * lib/negocio-manage.ts — the owner opens Stripe's page for their MONTHLY plan: card, invoices and cancelling (Daniel,
 * 2026-11-05: a merchant must be able to cancel the monthly plan themselves). Since plan-tienda S2.2 it opens the
 * page for whichever monthly plan the owner holds, Plan Negocio or Plan Tienda.
 *
 * The shop is the caller's own (the route reads it by `clerk_user_id`); nothing in the request names a shop or a
 * customer. The subscription is found in Stripe by the metadata our checkout writes on it (`kind`, `shop_id`,
 * `seller_clerk_id`), and it must match BOTH this shop and this user, so one owner can never open another's billing.
 *
 * One search per plan kind (`kind AND shop_id`), run together. Not one query: Stripe's search language cannot mix AND
 * with OR. And not "every subscription of this shop" filtered here: a shop that SELLS subscriptions has its buyers'
 * subscriptions under the same `shop_id`, and a page of them could push the plan's own subscription out of the result.
 *
 * Pure decision (`pickPlanSubscription`) + a thin shell with the Stripe calls injected.
 */
import { PAID_PLANS, PLAN_CHECKOUT_KINDS, paidPlanOfKind, type PaidPlan } from './plan-kind'

export type NegocioSubscriptionLike = {
  id: string
  status: string
  customer: string | { id: string } | null
  metadata: Record<string, string> | null
  created: number
}

/** Statuses an owner may still manage: paying, in its free period, or a failed payment Stripe is retrying. */
const MANAGEABLE = new Set(['active', 'trialing', 'past_due', 'unpaid'])

/**
 * Which plan's page to open when the shop holds BOTH for a while (D19: moving up to Negocio leaves the Tienda
 * subscription running until its period end): Negocio first, the plan «Tu suscripción» says the shop is on.
 *
 * Stripe's page is per CUSTOMER, and the portal is opened for the PICKED subscription's own customer — so it always
 * shows the plan that was picked. Our checkouts pass `customer_email`, not `customer`, so each checkout usually creates
 * its own Stripe customer and a Negocio and a Tienda subscription sit on DIFFERENT customers: the Negocio page will
 * usually not list the Tienda subscription. That is acceptable only because of D19: by the time a shop holds both, the
 * webhook has already set the Tienda one to end at its period end, so there is nothing left on it to manage. (If D19's
 * cancel failed, it alerted, and a person cancels it in Stripe.)
 */
const PLAN_RANK: Readonly<Record<PaidPlan, number>> = { negocio: 0, tienda: 1 }

/** The manageable monthly plan subscription of THIS shop and THIS user, with its customer id — or null. */
export function pickPlanSubscription(
  subs: readonly NegocioSubscriptionLike[],
  shopId: string,
  sellerClerkId: string,
): { subscriptionId: string; customerId: string; plan: PaidPlan } | null {
  const match = subs
    .map((s) => ({ s, plan: paidPlanOfKind(s.metadata?.kind) }))
    .filter((x): x is { s: NegocioSubscriptionLike; plan: PaidPlan } =>
      x.plan !== null &&
      x.s.metadata?.shop_id === shopId &&
      x.s.metadata?.seller_clerk_id === sellerClerkId &&
      MANAGEABLE.has(x.s.status),
    )
    .sort((a, b) => PLAN_RANK[a.plan] - PLAN_RANK[b.plan] || b.s.created - a.s.created)[0]
  if (!match) return null
  const customerId = typeof match.s.customer === 'string' ? match.s.customer : match.s.customer?.id ?? null
  return customerId ? { subscriptionId: match.s.id, customerId, plan: match.plan } : null
}

/** The newest manageable Negocio subscription of THIS shop and THIS user (the first name, Negocio only). */
export function pickNegocioSubscription(
  subs: readonly NegocioSubscriptionLike[],
  shopId: string,
  sellerClerkId: string,
): { subscriptionId: string; customerId: string } | null {
  const picked = pickPlanSubscription(subs.filter((s) => s.metadata?.kind === PLAN_CHECKOUT_KINDS.negocio), shopId, sellerClerkId)
  return picked ? { subscriptionId: picked.subscriptionId, customerId: picked.customerId } : null
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
    const pages = await Promise.all(
      PAID_PLANS.map((plan) => deps.searchSubscriptions(`metadata['kind']:'${PLAN_CHECKOUT_KINDS[plan]}' AND metadata['shop_id']:'${input.shopId}'`)),
    )
    subs = pages.flat()
  } catch {
    return { ok: false, status: 503, error: 'No pudimos abrir tus pagos ahora. Intenta en unos minutos.' }
  }
  const picked = pickPlanSubscription(subs, input.shopId, input.sellerClerkId)
  // Stripe's search can lag a minute behind a brand-new subscription, so "not found" says to try again shortly.
  if (!picked) {
    return { ok: false, status: 404, error: 'No encontramos un plan mensual en esta tienda. Si acabas de contratarlo, intenta en un minuto.' }
  }
  try {
    return { ok: true, url: await deps.createPortal(picked.customerId, input.returnUrl) }
  } catch {
    return { ok: false, status: 503, error: 'No pudimos abrir tus pagos ahora. Escríbenos y lo resolvemos contigo.' }
  }
}
