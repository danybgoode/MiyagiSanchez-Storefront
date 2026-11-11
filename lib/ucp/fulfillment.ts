import { createHash } from 'crypto'
import type {
  CheckoutFulfillmentMethod,
  CheckoutShippingAddress,
  CheckoutShippingQuote,
} from '../cart'

export interface BackendPickupSpot {
  id?: string
  name?: string
  address?: string
  hours?: string
  scheduling_url?: string
  notes?: string
  instructions?: string
}

export interface BackendDeliveryMethod {
  id: 'local_pickup' | 'shipping' | 'digital' | 'service' | 'rental' | 'coord' | 'manual_carrier'
  label: string
  note: string
  requires_address?: boolean
  requires_pickup_spot?: boolean
  pickup_spots?: BackendPickupSpot[]
}

export interface BackendShippingRate {
  id: string
  rateId: string
  carrier: string
  service: string
  amountCents: number
  currency: string
  deliveryEstimate?: number | null
  deliveryLabel?: string | null
  signature?: string | null
}

export type ShippingRateSource =
  | { state: 'not_requested' }
  | { state: 'unavailable' }
  | { state: 'available'; rates: BackendShippingRate[] }

export type NormalizedShippingDestination =
  | { complete: false; missing_fields: string[] }
  | {
      complete: true
      address: CheckoutShippingAddress
      signature: string
      ucp: {
        street_address: string
        extended_address?: string
        address_locality: string
        address_region: string
        address_country: string
        postal_code: string
        first_name?: string
        phone_number?: string
      }
    }

export interface UcpFulfillmentOption {
  id: string
  title: string
  description?: string
  carrier?: string
  totals: Array<{ type: 'fulfillment'; display_text: string; amount: number }>
}

export interface UcpFulfillmentMethod {
  id: 'shipping' | 'pickup'
  type: 'shipping' | 'pickup'
  line_item_ids: string[]
  destinations?: Array<{
    id: string
    name?: string
    address?: { street_address?: string }
    street_address?: string
    extended_address?: string
    address_locality?: string
    address_region?: string
    address_country?: string
    postal_code?: string
    first_name?: string
    phone_number?: string
  }>
  selected_destination_id?: string | null
  groups?: Array<{
    id: string
    line_item_ids: string[]
    selected_option_id?: string | null
    options: UcpFulfillmentOption[]
  }>
}

export interface UcpFulfillment {
  methods: UcpFulfillmentMethod[]
  available_methods: Array<{
    type: 'shipping' | 'pickup'
    line_item_ids: string[]
    fulfillable_on: 'now'
    description: string
  }>
  /** Miyagi state extension: prevents an outage from reading as a confident empty quote. */
  shipping_quote_state: 'not_applicable' | 'destination_required' | 'options_present' | 'known_empty' | 'unavailable'
}

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

/**
 * The web checkout's address contract is the one the Medusa quote/label route accepts.
 * Normalize it once here so discovery and selection hash and send identical bytes.
 */
export function normalizeShippingDestination(value: unknown): NormalizedShippingDestination {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const address: CheckoutShippingAddress = {
    name: clean(raw.name),
    phone: clean(raw.phone),
    line1: clean(raw.line1),
    ext_number: clean(raw.ext_number),
    int_number: clean(raw.int_number),
    line2: clean(raw.line2),
    city: clean(raw.city),
    state: clean(raw.state),
    state_code: clean(raw.state_code)?.toUpperCase(),
    postal_code: clean(raw.postal_code),
    country: (clean(raw.country) ?? 'MX').toUpperCase(),
  }

  const missing: string[] = []
  if (!address.name) missing.push('name')
  if (!address.line1) missing.push('line1')
  if (!address.ext_number) missing.push('ext_number')
  if (!address.city) missing.push('city')
  if (!address.state_code && !address.state) missing.push('state')
  if (!address.postal_code) missing.push('postal_code')
  if (address.country !== 'MX') missing.push('country_must_be_MX')
  if (missing.length) return { complete: false, missing_fields: missing }

  const normalized = address as Required<Pick<CheckoutShippingAddress,
    'name' | 'line1' | 'ext_number' | 'city' | 'postal_code' | 'country'
  >> & CheckoutShippingAddress
  const region = normalized.state_code ?? normalized.state!
  const streetAddress = `${normalized.line1} ${normalized.ext_number}`
  const signature = [
    normalized.name.toLowerCase(), normalized.phone?.toLowerCase() ?? '',
    normalized.line1.toLowerCase(), normalized.ext_number.toLowerCase(),
    normalized.int_number?.toLowerCase() ?? '', normalized.line2?.toLowerCase() ?? '',
    normalized.city.toLowerCase(), region.toLowerCase(), normalized.postal_code,
    normalized.country,
  ].join('|')

  return {
    complete: true,
    address: normalized,
    signature,
    ucp: {
      street_address: streetAddress,
      ...(normalized.int_number ? { extended_address: normalized.int_number } : {}),
      address_locality: normalized.city,
      address_region: region,
      address_country: normalized.country,
      postal_code: normalized.postal_code,
      ...(normalized.name ? { first_name: normalized.name } : {}),
      ...(normalized.phone ? { phone_number: normalized.phone } : {}),
    },
  }
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 24)}`
}

function pickupDestinationId(listingId: string, spotId: string): string {
  return stableId('pickup', listingId, spotId)
}

function pickupSpotInternalId(spot: BackendPickupSpot, index: number): string {
  return spot.id ?? spot.name ?? `spot-${index}`
}

function shippingDestinationId(listingId: string, destination: NormalizedShippingDestination & { complete: true }): string {
  return stableId('destination', listingId, destination.signature)
}

function shippingOptionId(
  listingId: string,
  destination: NormalizedShippingDestination & { complete: true },
  rate: BackendShippingRate,
): string {
  return stableId('shipping', listingId, destination.signature, rate.id || rate.rateId)
}

function carrierTitle(carrier: string): string {
  const known: Record<string, string> = {
    dhl: 'DHL', fedex: 'FedEx', ups: 'UPS', correos_mx: 'Correos MX',
  }
  return known[carrier.toLowerCase()] ?? carrier
    .split(/[_-]/)
    .map(part => part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ')
}

function projectShippingMethod(input: {
  listingId: string
  destination: NormalizedShippingDestination
  rateSource: ShippingRateSource
}): UcpFulfillmentMethod {
  const { listingId, destination, rateSource } = input
  const options = destination.complete && rateSource.state === 'available'
    ? rateSource.rates.map(rate => ({
        id: shippingOptionId(listingId, destination, rate),
        title: `${carrierTitle(rate.carrier)} · ${rate.service}`,
        ...(rate.deliveryLabel
          ? { description: rate.deliveryLabel }
          : rate.deliveryEstimate
            ? { description: `${rate.deliveryEstimate} días hábiles` }
            : {}),
        carrier: rate.carrier,
        totals: [{ type: 'fulfillment' as const, display_text: 'Envío', amount: rate.amountCents }],
      }))
    : []
  const destinationId = destination.complete ? shippingDestinationId(listingId, destination) : null

  return {
    id: 'shipping',
    type: 'shipping',
    line_item_ids: [listingId],
    ...(destination.complete ? {
      destinations: [{ id: destinationId!, ...destination.ucp }],
      selected_destination_id: destinationId,
    } : {}),
    groups: [{
      id: stableId('group', listingId, 'shipping'),
      line_item_ids: [listingId],
      selected_option_id: null,
      options,
    }],
  }
}

function projectPickupMethod(listingId: string, method: BackendDeliveryMethod): UcpFulfillmentMethod {
  const spots = method.pickup_spots ?? []
  const destinations = spots.map((spot, index) => {
    const internalId = pickupSpotInternalId(spot, index)
    return {
      id: pickupDestinationId(listingId, internalId),
      name: spot.name ?? spot.address ?? `Punto de entrega ${index + 1}`,
      ...(spot.address ? { address: { street_address: spot.address } } : {}),
    }
  })
  return {
    id: 'pickup',
    type: 'pickup',
    line_item_ids: [listingId],
    ...(destinations.length ? { destinations, selected_destination_id: null } : {}),
    groups: [{
      id: stableId('group', listingId, 'pickup'),
      line_item_ids: [listingId],
      selected_option_id: null,
      options: [{
        id: stableId('pickup-option', listingId),
        title: method.label,
        description: method.note,
        totals: [{ type: 'fulfillment', display_text: 'Recolección', amount: 0 }],
      }],
    }],
  }
}

export function projectUcpFulfillment(input: {
  listingId: string
  deliveryMethods: BackendDeliveryMethod[]
  destination: NormalizedShippingDestination
  rateSource: ShippingRateSource
}): UcpFulfillment | null {
  const physical = input.deliveryMethods.filter(method => method.id === 'shipping' || method.id === 'local_pickup')
  if (!physical.length) return null

  const hasShipping = physical.some(method => method.id === 'shipping')
  const methods = physical.map(method => method.id === 'shipping'
    ? projectShippingMethod(input)
    : projectPickupMethod(input.listingId, method))
  const shippingQuoteState: UcpFulfillment['shipping_quote_state'] = !hasShipping
    ? 'not_applicable'
    : !input.destination.complete
      ? 'destination_required'
      : input.rateSource.state === 'unavailable'
        ? 'unavailable'
        : input.rateSource.state === 'available' && input.rateSource.rates.length > 0
            ? 'options_present'
          : input.rateSource.state === 'available'
            ? 'known_empty'
            // A complete destination without a quote is not an invitation to
            // retry the address; callers must never read it as a known-empty
            // delivery result.
            : 'unavailable'

  return {
    methods,
    available_methods: physical.map(method => ({
      type: method.id === 'shipping' ? 'shipping' : 'pickup',
      line_item_ids: [input.listingId],
      fulfillable_on: 'now',
      description: method.note,
    })),
    shipping_quote_state: shippingQuoteState,
  }
}

export type FulfillmentSelectionResult =
  | {
      ok: true
      value: {
        fulfillmentMethod: CheckoutFulfillmentMethod
        shippingAddress?: CheckoutShippingAddress
        shippingQuote?: CheckoutShippingQuote
        pickupSpotId?: string
        pickupAppointment?: { date: string; window: string }
      }
    }
  | {
      ok: false
      code:
        | 'method_not_current'
        | 'shipping_address_required'
        | 'shipping_destination_required'
        | 'shipping_destination_not_current'
        | 'shipping_source_unavailable'
        | 'shipping_option_required'
        | 'option_not_current'
        | 'pickup_destination_required'
        | 'pickup_destination_not_current'
        | 'pickup_appointment_required'
    }

export function resolveUcpFulfillmentSelection(input: {
  listingId: string
  methodId: unknown
  destinationId?: unknown
  optionId?: unknown
  appointment?: unknown
  destination: NormalizedShippingDestination
  deliveryMethods: BackendDeliveryMethod[]
  rateSource: ShippingRateSource
}): FulfillmentSelectionResult {
  const methodId = clean(input.methodId)
  if (methodId === 'shipping') {
    if (!input.deliveryMethods.some(method => method.id === 'shipping')) {
      return { ok: false, code: 'method_not_current' }
    }
    if (!input.destination.complete) return { ok: false, code: 'shipping_address_required' }
    const destinationId = clean(input.destinationId)
    if (!destinationId) return { ok: false, code: 'shipping_destination_required' }
    if (destinationId !== shippingDestinationId(input.listingId, input.destination)) {
      return { ok: false, code: 'shipping_destination_not_current' }
    }
    if (input.rateSource.state !== 'available') return { ok: false, code: 'shipping_source_unavailable' }
    const optionId = clean(input.optionId)
    if (!optionId) return { ok: false, code: 'shipping_option_required' }
    const rate = input.rateSource.rates.find(candidate =>
      shippingOptionId(input.listingId, input.destination as NormalizedShippingDestination & { complete: true }, candidate) === optionId)
    if (!rate) return { ok: false, code: 'option_not_current' }

    return {
      ok: true,
      value: {
        fulfillmentMethod: 'shipping',
        shippingAddress: input.destination.address,
        shippingQuote: {
          rateId: rate.rateId,
          carrier: rate.carrier,
          service: rate.service,
          amountCents: rate.amountCents,
          currency: rate.currency,
          deliveryEstimate: rate.deliveryEstimate ?? null,
          deliveryLabel: rate.deliveryLabel ?? null,
          ...(rate.signature ? { signature: rate.signature } : {}),
        },
      },
    }
  }

  if (methodId === 'pickup') {
    const pickup = input.deliveryMethods.find(method => method.id === 'local_pickup')
    if (!pickup) return { ok: false, code: 'method_not_current' }
    const spots = pickup.pickup_spots ?? []
    const destinationId = clean(input.destinationId)
    if (pickup.requires_pickup_spot && !destinationId) {
      return { ok: false, code: 'pickup_destination_required' }
    }
    const spotIndex = destinationId
      ? spots.findIndex((candidate, index) =>
          pickupDestinationId(input.listingId, pickupSpotInternalId(candidate, index)) === destinationId)
      : -1
    const spot = spotIndex >= 0 ? spots[spotIndex] : undefined
    if (destinationId && !spot) return { ok: false, code: 'pickup_destination_not_current' }

    const rawAppointment = input.appointment && typeof input.appointment === 'object'
      ? input.appointment as Record<string, unknown>
      : {}
    const date = clean(rawAppointment.date)
    const window = clean(rawAppointment.window)
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !window) {
      return { ok: false, code: 'pickup_appointment_required' }
    }
    return {
      ok: true,
      value: {
        fulfillmentMethod: 'local_pickup',
        ...(spot ? { pickupSpotId: pickupSpotInternalId(spot, spotIndex) } : {}),
        pickupAppointment: { date, window },
      },
    }
  }

  return { ok: false, code: 'method_not_current' }
}
