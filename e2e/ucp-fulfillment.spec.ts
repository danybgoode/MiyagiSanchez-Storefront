import { expect, test } from '@playwright/test'
import {
  normalizeShippingDestination,
  projectUcpFulfillment,
  resolveUcpFulfillmentSelection,
  type BackendDeliveryMethod,
  type BackendShippingRate,
} from '../lib/ucp/fulfillment'

const LISTING_ID = 'prod_shipping_fixture'
const SHIPPING: BackendDeliveryMethod = {
  id: 'shipping',
  label: 'Envío a domicilio',
  note: 'Cotiza y elige paquetería antes de pagar.',
  requires_address: true,
}
const PICKUP: BackendDeliveryMethod = {
  id: 'local_pickup',
  label: 'Recolección en mano',
  note: 'Elige dónde recoger tu pedido.',
  requires_pickup_spot: true,
  pickup_spots: [
    { id: 'centro', name: 'Centro', address: 'Av. Juárez 10', hours: '10:00–18:00' },
    { id: 'norte', name: 'Norte', address: 'Calz. Norte 20' },
  ],
}
const DESTINATION = {
  name: 'Buyer Test',
  phone: '5555555555',
  line1: 'Av. Insurgentes Sur',
  ext_number: '1234',
  int_number: '5',
  line2: 'Del Valle',
  city: 'Benito Juárez',
  state: 'Ciudad de México',
  state_code: 'CX',
  postal_code: '03100',
  country: 'MX',
}
const RATES: BackendShippingRate[] = [
  {
    id: 'dhl:express:rate_live', rateId: 'rate_live', carrier: 'dhl', service: 'express',
    amountCents: 18900, currency: 'MXN', deliveryEstimate: 2, deliveryLabel: '2 días hábiles',
  },
  {
    id: 'correos:impresos:flat', rateId: 'correos_impresos_flat', carrier: 'correos_mx', service: 'Económico',
    amountCents: 7300, currency: 'MXN', deliveryEstimate: null, deliveryLabel: 'Económico · 4–10 días · sin rastreo',
  },
]

test.describe('UCP fulfillment projection', () => {
  test('shipping without a complete destination is recoverable missing input, not an empty quote', () => {
    const result = projectUcpFulfillment({
      listingId: LISTING_ID,
      deliveryMethods: [SHIPPING],
      destination: normalizeShippingDestination({ postal_code: '03100' }),
      rateSource: { state: 'not_requested' },
    })

    expect(result?.shipping_quote_state).toBe('destination_required')
    expect(result?.methods).toHaveLength(1)
    expect(result?.methods[0]).toMatchObject({ id: 'shipping', type: 'shipping', line_item_ids: [LISTING_ID] })
    expect(result?.methods[0].groups?.[0].options).toEqual([])
  })

  test('carrier options keep backend order and expose only server-derived minor-unit totals', () => {
    const destination = normalizeShippingDestination(DESTINATION)
    const result = projectUcpFulfillment({
      listingId: LISTING_ID,
      deliveryMethods: [SHIPPING],
      destination,
      rateSource: { state: 'available', rates: RATES },
    })

    expect(result?.shipping_quote_state).toBe('options_present')
    const method = result?.methods[0]
    expect(method?.selected_destination_id).toBe(method?.destinations?.[0].id)
    expect(method?.groups?.[0].options.map(option => ({
      title: option.title,
      carrier: option.carrier,
      amount: option.totals[0].amount,
    }))).toEqual([
      { title: 'DHL · express', carrier: 'dhl', amount: 18900 },
      { title: 'Correos MX · Económico', carrier: 'correos_mx', amount: 7300 },
    ])

    const changed = projectUcpFulfillment({
      listingId: LISTING_ID,
      deliveryMethods: [SHIPPING],
      destination: normalizeShippingDestination({ ...DESTINATION, postal_code: '44100' }),
      rateSource: { state: 'available', rates: RATES },
    })
    expect(changed?.methods[0].groups?.[0].options[0].id).not.toBe(method?.groups?.[0].options[0].id)
  })

  test('known-empty and unavailable remain different public states', () => {
    const destination = normalizeShippingDestination(DESTINATION)
    const empty = projectUcpFulfillment({
      listingId: LISTING_ID, deliveryMethods: [SHIPPING], destination,
      rateSource: { state: 'available', rates: [] },
    })
    const unavailable = projectUcpFulfillment({
      listingId: LISTING_ID, deliveryMethods: [SHIPPING], destination,
      rateSource: { state: 'unavailable' },
    })
    const missingQuote = projectUcpFulfillment({
      listingId: LISTING_ID, deliveryMethods: [SHIPPING], destination,
      rateSource: { state: 'not_requested' },
    })

    expect(empty?.shipping_quote_state).toBe('known_empty')
    expect(unavailable?.shipping_quote_state).toBe('unavailable')
    expect(missingQuote?.shipping_quote_state).toBe('unavailable')
  })

  test('pickup spots become stable retail destinations with a zero-cost option', () => {
    const result = projectUcpFulfillment({
      listingId: LISTING_ID,
      deliveryMethods: [PICKUP],
      destination: normalizeShippingDestination(undefined),
      rateSource: { state: 'not_requested' },
    })

    expect(result?.shipping_quote_state).toBe('not_applicable')
    expect(result?.methods[0]).toMatchObject({ id: 'pickup', type: 'pickup' })
    expect(result?.methods[0].destinations?.map(destination => destination.name)).toEqual(['Centro', 'Norte'])
    expect(result?.methods[0].groups?.[0].options[0].totals).toEqual([
      { type: 'fulfillment', display_text: 'Recolección', amount: 0 },
    ])
  })

  test('non-physical delivery catalog entries do not fabricate fulfillment', () => {
    const result = projectUcpFulfillment({
      listingId: LISTING_ID,
      deliveryMethods: [{ id: 'digital', label: 'Entrega digital', note: 'Después del pago.' }],
      destination: normalizeShippingDestination(undefined),
      rateSource: { state: 'not_requested' },
    })
    expect(result).toBeNull()
  })
})

test.describe('UCP fulfillment selection', () => {
  test('shipping resolves from the fresh matching rate and never from caller money fields', () => {
    const destination = normalizeShippingDestination(DESTINATION)
    const projected = projectUcpFulfillment({
      listingId: LISTING_ID, deliveryMethods: [SHIPPING], destination,
      rateSource: { state: 'available', rates: RATES },
    })!
    const optionId = projected.methods[0].groups![0].options[0].id
    const destinationId = projected.methods[0].selected_destination_id!

    const result = resolveUcpFulfillmentSelection({
      listingId: LISTING_ID,
      methodId: 'shipping',
      destinationId,
      optionId,
      destination,
      deliveryMethods: [SHIPPING],
      rateSource: { state: 'available', rates: RATES },
    })

    expect(result).toEqual({
      ok: true,
      value: {
        fulfillmentMethod: 'shipping',
        shippingAddress: DESTINATION,
        shippingQuote: {
          rateId: 'rate_live', carrier: 'dhl', service: 'express', amountCents: 18900,
          currency: 'MXN', deliveryEstimate: 2, deliveryLabel: '2 días hábiles',
        },
      },
    })
  })

  test('the backend rate signature rides into the shipping quote unchanged', () => {
    const destination = normalizeShippingDestination(DESTINATION)
    const rates = RATES.map(r => ({ ...r, signature: '123.sig' }))
    const projected = projectUcpFulfillment({
      listingId: LISTING_ID, deliveryMethods: [SHIPPING], destination,
      rateSource: { state: 'available', rates },
    })!
    const result = resolveUcpFulfillmentSelection({
      listingId: LISTING_ID, methodId: 'shipping',
      destinationId: projected.methods[0].selected_destination_id!,
      optionId: projected.methods[0].groups![0].options[0].id,
      destination, deliveryMethods: [SHIPPING],
      rateSource: { state: 'available', rates },
    })
    expect(result.ok && result.value.shippingQuote?.signature).toBe('123.sig')
  })

  test('a returned option id fails after the destination changes', () => {
    const original = normalizeShippingDestination(DESTINATION)
    const projected = projectUcpFulfillment({
      listingId: LISTING_ID, deliveryMethods: [SHIPPING], destination: original,
      rateSource: { state: 'available', rates: RATES },
    })!
    const optionId = projected.methods[0].groups![0].options[0].id
    const destinationId = projected.methods[0].selected_destination_id!

    const result = resolveUcpFulfillmentSelection({
      listingId: LISTING_ID,
      methodId: 'shipping',
      destinationId,
      optionId,
      destination: normalizeShippingDestination({ ...DESTINATION, postal_code: '44100' }),
      deliveryMethods: [SHIPPING],
      rateSource: { state: 'available', rates: RATES },
    })
    expect(result).toEqual({ ok: false, code: 'shipping_destination_not_current' })
  })

  test('pickup validates the current spot and requires the buyer-proposed appointment', () => {
    const projected = projectUcpFulfillment({
      listingId: LISTING_ID,
      deliveryMethods: [PICKUP],
      destination: normalizeShippingDestination(undefined),
      rateSource: { state: 'not_requested' },
    })!
    const destinationId = projected.methods[0].destinations![0].id

    expect(resolveUcpFulfillmentSelection({
      listingId: LISTING_ID,
      methodId: 'pickup',
      destinationId,
      appointment: { date: '2026-08-20', window: '10:00–12:00' },
      destination: normalizeShippingDestination(undefined),
      deliveryMethods: [PICKUP],
      rateSource: { state: 'not_requested' },
    })).toEqual({
      ok: true,
      value: {
        fulfillmentMethod: 'local_pickup',
        pickupSpotId: 'centro',
        pickupAppointment: { date: '2026-08-20', window: '10:00–12:00' },
      },
    })

    expect(resolveUcpFulfillmentSelection({
      listingId: LISTING_ID,
      methodId: 'pickup',
      destinationId,
      destination: normalizeShippingDestination(undefined),
      deliveryMethods: [PICKUP],
      rateSource: { state: 'not_requested' },
    })).toEqual({ ok: false, code: 'pickup_appointment_required' })
  })

  test('a pickup spot without configured id/name keeps its projection fallback into checkout metadata', () => {
    const anonymousPickup: BackendDeliveryMethod = {
      ...PICKUP,
      pickup_spots: [{ address: 'Ubicación a confirmar' }],
    }
    const projected = projectUcpFulfillment({
      listingId: LISTING_ID,
      deliveryMethods: [anonymousPickup],
      destination: normalizeShippingDestination(undefined),
      rateSource: { state: 'not_requested' },
    })!

    expect(resolveUcpFulfillmentSelection({
      listingId: LISTING_ID,
      methodId: 'pickup',
      destinationId: projected.methods[0].destinations![0].id,
      appointment: { date: '2026-08-20', window: '10:00–12:00' },
      destination: normalizeShippingDestination(undefined),
      deliveryMethods: [anonymousPickup],
      rateSource: { state: 'not_requested' },
    })).toMatchObject({
      ok: true,
      value: { fulfillmentMethod: 'local_pickup', pickupSpotId: 'spot-0' },
    })
  })
})
