import 'server-only'

import type { CheckoutShippingAddress } from '../cart'
import type { BackendDeliveryMethod, BackendShippingRate, ShippingRateSource } from './fulfillment'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const MEDUSA_PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

interface RawPaymentMethod {
  id: string
  kind?: string
  sub_options?: Array<{ type: string }>
}

export type BackendCheckoutOptionsSource =
  | {
      state: 'available'
      paymentMethods: RawPaymentMethod[]
      deliveryMethods: BackendDeliveryMethod[]
      onlyCoordinated: boolean
      coordNote: string | null
    }
  | { state: 'unavailable' }

interface FulfillmentServerDeps {
  fetch: typeof fetch
  medusaBase: string
  publishableKey: string
}

const DEFAULT_DEPS: FulfillmentServerDeps = {
  fetch,
  medusaBase: MEDUSA_BASE,
  publishableKey: MEDUSA_PUB_KEY,
}

export async function fetchBackendCheckoutOptions(
  input: {
    sellerRef: string
    listingType: string
    isDigital: boolean
    deliveryMode: 'carrier' | 'arranged'
  },
  deps: FulfillmentServerDeps = DEFAULT_DEPS,
): Promise<BackendCheckoutOptionsSource> {
  try {
    const qs = new URLSearchParams({
      listing_type: input.listingType,
      is_digital: String(input.isDigital),
      delivery_mode: input.deliveryMode,
    })
    const response = await deps.fetch(
      `${deps.medusaBase}/store/sellers/${encodeURIComponent(input.sellerRef)}/checkout-options?${qs}`,
      { headers: { 'x-publishable-api-key': deps.publishableKey } },
    )
    if (!response.ok) return { state: 'unavailable' }
    const data = await response.json() as {
      payment_methods?: unknown
      delivery_methods?: unknown
      only_coordinated?: unknown
    }
    if (!Array.isArray(data.payment_methods) || !Array.isArray(data.delivery_methods)) {
      return { state: 'unavailable' }
    }
    const paymentMethods = data.payment_methods.filter((method): method is RawPaymentMethod =>
      !!method && typeof method === 'object' && typeof (method as RawPaymentMethod).id === 'string')
    const deliveryMethods = data.delivery_methods.filter((method): method is BackendDeliveryMethod =>
      !!method && typeof method === 'object' && typeof (method as BackendDeliveryMethod).id === 'string'
      && typeof (method as BackendDeliveryMethod).label === 'string'
      && typeof (method as BackendDeliveryMethod).note === 'string')
    // A partial catalog is not authoritative. Refuse the entire source instead
    // of silently turning a malformed entry into "this seller does not offer it".
    if (paymentMethods.length !== data.payment_methods.length || deliveryMethods.length !== data.delivery_methods.length) {
      return { state: 'unavailable' }
    }
    const coordMethod = deliveryMethods.find(method => method.id === 'coord')
    return {
      state: 'available',
      paymentMethods,
      deliveryMethods,
      onlyCoordinated: data.only_coordinated === true,
      coordNote: coordMethod?.note ?? null,
    }
  } catch {
    return { state: 'unavailable' }
  }
}

function readRate(value: unknown): BackendShippingRate | null {
  if (!value || typeof value !== 'object') return null
  const rate = value as Record<string, unknown>
  if (
    typeof rate.id !== 'string'
    || typeof rate.rateId !== 'string'
    || typeof rate.carrier !== 'string'
    || typeof rate.service !== 'string'
    || typeof rate.amountCents !== 'number'
    || !Number.isFinite(rate.amountCents)
    || typeof rate.currency !== 'string'
  ) return null
  return {
    id: rate.id,
    rateId: rate.rateId,
    carrier: rate.carrier,
    service: rate.service,
    amountCents: rate.amountCents,
    currency: rate.currency,
    deliveryEstimate: typeof rate.deliveryEstimate === 'number' ? rate.deliveryEstimate : null,
    deliveryLabel: typeof rate.deliveryLabel === 'string' ? rate.deliveryLabel : null,
    signature: typeof rate.signature === 'string' ? rate.signature : null,
  }
}

export async function fetchBackendShippingRates(
  input: { listingId: string; address: CheckoutShippingAddress },
  deps: FulfillmentServerDeps = DEFAULT_DEPS,
): Promise<ShippingRateSource> {
  try {
    const response = await deps.fetch(`${deps.medusaBase}/store/envia/rates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-publishable-api-key': deps.publishableKey,
      },
      body: JSON.stringify({ listingId: input.listingId, address: input.address }),
    })
    if (!response.ok) return { state: 'unavailable' }
    const data = await response.json() as { rates?: unknown }
    if (!Array.isArray(data.rates)) return { state: 'unavailable' }
    const rates = data.rates.map(readRate)
    if (rates.some(rate => rate === null)) return { state: 'unavailable' }
    return { state: 'available', rates: rates as BackendShippingRate[] }
  } catch {
    return { state: 'unavailable' }
  }
}
