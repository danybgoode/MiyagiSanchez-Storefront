import { expect, test } from '@playwright/test'
import {
  classifyEnvelope,
  buildLifecycleTrackPayload,
  MERCHANT_LIFECYCLE_EVENTS,
  MAX_SUBJECT_ID_LENGTH,
  isCapturedOrder, shopIdForEmissionSubject } from '../lib/merchant-lifecycle'
import {
  lifecycleFixtures,
  shapingFixtures,
  allFixtures,
  fixturesDigest,
} from './_fixtures/merchant-lifecycle'

/**
 * Golden Beans event-destination-router · Story 3.1 — pure-seam coverage for the
 * merchant lifecycle projection.
 *
 * These run against the SHARED fixture file (Sprint 3 QA: identical fixtures in both
 * repos' suites). No network, no DB, no browser — `classifyEnvelope` is zero-import
 * precisely so every branch is reachable here rather than only through whatever path a
 * well-formed HTTP request happens to walk.
 */

test.describe('merchant lifecycle · shared fixtures', () => {
  test('the fixture file covers all fourteen lifecycle events, exactly once each', () => {
    // Sprint 3 (founding-merchant-activation-ops, README D2) grew the vocabulary
    // from 6 to 14 — the fixture file grew with it (see its own $comment).
    const covered = lifecycleFixtures.map((f) => f.envelope.type)
    expect([...covered].sort()).toEqual([...MERCHANT_LIFECYCLE_EVENTS].sort())
  })

  test('the fixture file is unmodified — golden-beans asserts the same digest', () => {
    // If this fails, the fixtures changed. That is allowed; update BOTH repos and both
    // digests in the same change, or the "identical fixtures" claim is no longer true.
    // KNOWN DRIFT as of Sprint 3: this repo's fixture file and pinned digest were
    // updated to add the 8 new stage events; golden-beans' copy needs the SAME
    // update (owed — see the sprint report, not done in this PR: "do NOT edit that
    // repo" per the build brief). Until that lands, this specific cross-repo
    // equality claim is aspirational for the new 8, not yet re-verified against a
    // live golden-beans copy — only THIS repo's own digest is checked below.
    expect(fixturesDigest()).toMatch(/^[0-9a-f]{64}$/)
    expect(fixturesDigest()).toBe(FIXTURES_SHA256)
  })

  for (const fixture of allFixtures) {
    test(`classify · ${fixture.name}`, () => {
      const decision = classifyEnvelope(fixture.envelope)
      expect(decision.kind).toBe(fixture.expect.kind)
      if (fixture.expect.reason) {
        expect((decision as { reason?: string }).reason).toBe(fixture.expect.reason)
      }
      if (fixture.expect.merchantId) {
        expect((decision as { merchantId?: string }).merchantId).toBe(fixture.expect.merchantId)
      }
    })
  }

  test('a lifecycle fixture normalises occurredAt to UTC ISO', () => {
    const decision = classifyEnvelope(lifecycleFixtures[0].envelope)
    expect(decision.kind).toBe('lifecycle')
    if (decision.kind !== 'lifecycle') return
    expect(decision.occurredAt).toBe('2026-07-22T10:00:00.000Z')
    expect(decision.eventId).toBe(lifecycleFixtures[0].envelope.id)
  })

  test('an equivalent non-UTC spelling produces the SAME instant', () => {
    // Two spellings of one moment must not become two comparable-looking timestamps in
    // the projection.
    const decision = classifyEnvelope({
      id: 'tz-check',
      type: 'merchant.claimed',
      occurredAt: '2026-07-22T05:00:00-05:00',
      data: { subject: { type: 'merchant', id: 'shop_1' } },
    })
    expect(decision.kind).toBe('lifecycle')
    if (decision.kind !== 'lifecycle') return
    expect(decision.occurredAt).toBe('2026-07-22T10:00:00.000Z')
  })
})

test.describe('merchant lifecycle · classify hostile input', () => {
  const notObjects: unknown[] = [null, undefined, 'a string', 42, true, ['array']]
  for (const value of notObjects) {
    test(`rejects a non-object body: ${JSON.stringify(value) ?? 'undefined'}`, () => {
      expect(classifyEnvelope(value)).toEqual({ kind: 'invalid', reason: 'not_an_object' })
    })
  }

  test('rejects a subject id longer than golden-beans permits', () => {
    const decision = classifyEnvelope({
      id: 'oversize',
      type: 'merchant.claimed',
      occurredAt: '2026-07-22T10:00:00.000Z',
      data: { subject: { type: 'merchant', id: 'x'.repeat(MAX_SUBJECT_ID_LENGTH + 1) } },
    })
    expect(decision).toEqual({ kind: 'invalid', reason: 'missing_merchant_subject' })
  })

  test('rejects an id that is only whitespace — a PK must be a real value', () => {
    expect(classifyEnvelope({ id: '   ', type: 'merchant.claimed', occurredAt: '2026-07-22T10:00:00Z' }))
      .toEqual({ kind: 'invalid', reason: 'missing_id' })
  })

  test('`test: false` is NOT a test send — only literal true is', () => {
    // The producer never sends `false`; a receiver that treated any `test` key as truthy
    // (or as present-means-test) would drop real events on the floor.
    const decision = classifyEnvelope({
      id: 'not-a-test',
      type: 'merchant.claimed',
      occurredAt: '2026-07-22T10:00:00.000Z',
      test: false,
      data: { subject: { type: 'merchant', id: 'shop_1' } },
    })
    expect(decision.kind).toBe('lifecycle')
  })

  test('a non-lifecycle event is IGNORED, never invalid — the destination gets every project event', () => {
    for (const fixture of shapingFixtures) {
      if (fixture.expect.kind !== 'ignored') continue
      expect(classifyEnvelope(fixture.envelope).kind).toBe('ignored')
    }
  })
})

test.describe('merchant lifecycle · track payload (producer half)', () => {
  const AT = new Date('2026-07-22T10:00:00.000Z')

  test('carries the merchant subject golden-beans routes on', () => {
    const payload = buildLifecycleTrackPayload('merchant.first_sale', {
      merchantId: 'shop_abc',
      occurredAt: AT,
    })
    expect(payload).toEqual({
      userId: 'shop_abc',
      event: 'merchant.first_sale',
      featureId: 'merchant-lifecycle',
      tags: { shop_id: 'shop_abc' },
      context: {
        version: 1,
        subject: { type: 'merchant', id: 'shop_abc' },
        occurredAt: '2026-07-22T10:00:00.000Z',
        idempotencyKey: 'shop_abc:merchant.first_sale',
      },
    })
  })

  test('adds a validated market code as a tag only when it is known', () => {
    expect(buildLifecycleTrackPayload('merchant.claimed', {
      merchantId: 'relationship_abc',
      marketCode: 'us',
    }).tags).toEqual({ shop_id: 'relationship_abc', market_code: 'us' })
    expect(buildLifecycleTrackPayload('merchant.claimed', {
      merchantId: 'relationship_abc',
    }).tags).toEqual({ shop_id: 'relationship_abc' })
  })

  test('the idempotency key is stable per (merchant, milestone) across rebuilds', () => {
    // This is what makes an AMBIGUOUS send safe to retry: golden-beans enforces
    // UNIQUE (project_id, idempotency_key) and returns the EXISTING event, so a retry
    // after a timed-out-but-accepted send resolves to one canonical event, one
    // delivery, one milestone.
    const a = buildLifecycleTrackPayload('merchant.first_sale', { merchantId: 'shop_abc' })
    const b = buildLifecycleTrackPayload('merchant.first_sale', { merchantId: 'shop_abc' })
    expect(a.context.idempotencyKey).toBe(b.context.idempotencyKey)
  })

  test('different milestones and different merchants never share a key', () => {
    const keys = new Set<string>()
    for (const merchantId of ['shop_a', 'shop_b']) {
      for (const event of MERCHANT_LIFECYCLE_EVENTS) {
        keys.add(buildLifecycleTrackPayload(event, { merchantId }).context.idempotencyKey)
      }
    }
    expect(keys.size).toBe(2 * MERCHANT_LIFECYCLE_EVENTS.length)
  })

  test('an oversized merchant id truncates the ID, never the event name', () => {
    // Truncating the event name would collide two DIFFERENT milestones for the same
    // merchant into one key — a silent loss. Truncating the id degrades into a
    // collision between two merchants' SAME milestone, which is the lesser failure.
    const key = buildLifecycleTrackPayload('merchant.three_products_live', {
      merchantId: 'x'.repeat(400),
    }).context.idempotencyKey
    expect(key.length).toBeLessThanOrEqual(128) // golden-beans' hard limit
    expect(key.endsWith(':merchant.three_products_live')).toBe(true)
  })

  test('context.version is 1 — golden-beans REJECTS an absent or unknown version', () => {
    const payload = buildLifecycleTrackPayload('merchant.claimed', { merchantId: 'shop_abc' })
    expect(payload.context.version).toBe(1)
  })

  test('occurredAt always carries a time and an explicit UTC offset', () => {
    // A bare date ("2026-07-22") names 24+ instants; golden-beans rejects it outright.
    const payload = buildLifecycleTrackPayload('merchant.claimed', { merchantId: 'shop_abc' })
    expect(payload.context.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  test('correlationId is included only when supplied — never sent as null', () => {
    const without = buildLifecycleTrackPayload('merchant.claimed', { merchantId: 'shop_abc' })
    expect('correlationId' in without.context).toBe(false)

    const with_ = buildLifecycleTrackPayload('merchant.claimed', {
      merchantId: 'shop_abc',
      correlationId: 'pv_1',
    })
    expect(with_.context.correlationId).toBe('pv_1')
  })

  test('NO PII can reach the payload — tags are an allow-list, not a redaction pass', () => {
    // Golden Beans forwards tenant metadata VALUES verbatim to every destination without
    // inspecting them, so anything personal that reaches it has already left our control.
    // The guarantee here is structural: a caller passing extra fields has nowhere to put
    // them, so this cannot regress by someone adding a spread.
    const payload = buildLifecycleTrackPayload('merchant.claimed', {
      merchantId: 'shop_abc',
      productCount: 3,
      // @ts-expect-error — deliberately passing fields the type does not allow
      email: 'merchant@example.com',
      whatsapp: '+52 55 1234 5678',
      shopName: 'Bonsáis del Valle',
    })
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('merchant@example.com')
    expect(serialized).not.toContain('1234')
    expect(serialized).not.toContain('Bonsáis')
    expect(payload.tags).toEqual({ shop_id: 'shop_abc', product_count: 3 })
  })

  test('a STAGE event (Sprint 3, all 14 types) carries no PII, from a full relationship fixture', () => {
    // Sprint 3, Story 3.2's build contract: "extend the contract spec to cover all 14
    // types and assert a STAGE event's payload carries no business_name, contact_name,
    // phone, email, Instagram handle, note or objection — asserted against the real
    // builder, from a relationship fixture that populates every one of those fields."
    //
    // `buildLifecycleTrackPayload`'s signature doesn't even ACCEPT a relationship
    // object — every real call site (`evaluateRelationship`, `emitStageTransition`,
    // `emitMerchantLifecycleForShop`) passes only the opaque relationship id as
    // `merchantId`. This fixture stands in for "a relationship row with every PII
    // field populated" so the assertion is against concrete candidate STRINGS, not a
    // structural argument alone — the same technique as the six-event PII test above,
    // widened to source its needles from a realistic full record and to walk every
    // one of the 14 types (13 stages + preview_approved).
    const piiRelationshipFixture = {
      id: 'a1a1a1a1-1a1a-4a1a-8a1a-1a1a1a1a1a1a',
      business_name: 'Bonsáis del Valle',
      contact_name: 'María Fernanda López',
      phone_e164: '+525512345678',
      email_normalized: 'maria.lopez@example.com',
      instagram_handle: '@bonsaisdelvalle',
      fit_note: 'El dueño mencionó que quiere vender en línea antes de diciembre.',
      objections: 'Le preocupa el tiempo que toma tomar fotos de cada pieza.',
    }
    const piiNeedles = [
      piiRelationshipFixture.business_name,
      piiRelationshipFixture.contact_name,
      piiRelationshipFixture.phone_e164,
      piiRelationshipFixture.email_normalized,
      piiRelationshipFixture.instagram_handle,
      piiRelationshipFixture.fit_note,
      piiRelationshipFixture.objections,
    ]

    for (const event of MERCHANT_LIFECYCLE_EVENTS) {
      // The relationship id — the opaque subject, never anything from the fixture
      // above — is the ONLY thing a real call site ever derives from the relationship.
      const payload = buildLifecycleTrackPayload(event, {
        merchantId: piiRelationshipFixture.id,
        occurredAt: AT,
        productCount: 3,
      })
      const serialized = JSON.stringify(payload)
      for (const needle of piiNeedles) {
        expect(serialized, `${event} payload must not contain "${needle}"`).not.toContain(needle)
      }
      // The subject IS allowed to carry the opaque id — that's the whole point.
      expect(serialized).toContain(piiRelationshipFixture.id)
    }
  })

  test('every one of the fourteen events builds a routable payload', () => {
    for (const event of MERCHANT_LIFECYCLE_EVENTS) {
      const payload = buildLifecycleTrackPayload(event, { merchantId: 'shop_abc', occurredAt: AT })
      expect(payload.event).toBe(event)
      expect(payload.context.subject).toEqual({ type: 'merchant', id: 'shop_abc' })
    }
  })
})

test.describe('merchant lifecycle · the loop closes', () => {
  test('what we emit, classified as what we would receive back', () => {
    // The round trip in one assertion: our track payload → the envelope golden-beans
    // builds from the stored row → our own classifier. If the two halves ever disagree
    // about the subject key, this is where it shows up rather than in production.
    for (const event of MERCHANT_LIFECYCLE_EVENTS) {
      const emitted = buildLifecycleTrackPayload(event, {
        merchantId: 'shop_abc',
        occurredAt: new Date('2026-07-22T10:00:00.000Z'),
      })
      // buildEventEnvelope's transform: snake_cased columns back out, nulls omitted.
      const delivered = {
        id: 'evt-round-trip',
        type: emitted.event,
        occurredAt: emitted.context.occurredAt,
        data: {
          userId: emitted.userId,
          featureId: emitted.featureId,
          tags: emitted.tags,
          subject: emitted.context.subject,
        },
      }
      const decision = classifyEnvelope(delivered)
      expect(decision.kind).toBe('lifecycle')
      if (decision.kind !== 'lifecycle') continue
      expect(decision.merchantId).toBe('shop_abc')
      expect(decision.type).toBe(event)
    }
  })
})

/**
 * Pinned sha256 of e2e/_fixtures/merchant-lifecycle.fixtures.json.
 * The golden-beans suite pins the SAME value against its own copy — that is what makes
 * "identical fixtures in both repos" a checked fact rather than a claim in a doc.
 *
 * Updated Sprint 3 (founding-merchant-activation-ops) for the 8 added lifecycle
 * fixtures — golden-beans' pinned copy is OWED the same update (see the sprint report).
 */
const FIXTURES_SHA256 = 'b53f300bdd967bfe21dadbc7543655ccf36f95d27e643625fbb68df5739f3671'

test.describe('merchant lifecycle · isCapturedOrder (the first_sale gate)', () => {
  const captured = { status: 'paid', payment_captured: true }

  test('requires BOTH signals — a captured order with a stuck status counts', () => {
    expect(isCapturedOrder(captured)).toBe(true)
  })

  test('AUTHORIZED-but-not-captured is refused, even though status says "paid"', () => {
    // The gap this gate exists to close. `status` initialises to 'paid' in
    // normalizeMedusaOrder and is only demoted for cancel/refund/return or an uncaptured
    // MANUAL method — so a card order at payment_status 'authorized' arrives as 'paid'.
    // Reading status alone would grant the write-once first_sale milestone off a
    // fall-through default. This is the assertion that fails if the gate is removed.
    expect(isCapturedOrder({ status: 'paid', payment_captured: false })).toBe(false)
  })

  test('a MISSING payment_captured fails closed — an older backend must not grant it', () => {
    // Deploy ordering: until MiyagiSanchez-Backend PR 109 rolled, the field was absent.
    // Deferring the milestone is recoverable; granting it wrongly is not.
    expect(isCapturedOrder({ status: 'paid' })).toBe(false)
  })

  test('only literal true counts — truthy strings and 1 do not', () => {
    expect(isCapturedOrder({ status: 'paid', payment_captured: 'yes' })).toBe(false)
    expect(isCapturedOrder({ status: 'paid', payment_captured: 1 })).toBe(false)
  })

  test('a captured order whose sale did NOT stick is refused', () => {
    // payment_captured deliberately ignores returns/cancellations (a return is not a
    // refund), so those arrive captured:true with status 'refunded'. The allow-list is
    // what excludes them — which is why both signals are required.
    expect(isCapturedOrder({ status: 'refunded', payment_captured: true })).toBe(false)
    expect(isCapturedOrder({ status: 'pending_payment', payment_captured: true })).toBe(false)
  })

  test('an unknown status is refused even when captured', () => {
    expect(isCapturedOrder({ status: 'some_new_state', payment_captured: true })).toBe(false)
  })

  test('every allow-listed status counts when captured', () => {
    for (const status of ['paid', 'processing', 'shipped', 'delivered', 'fulfilled', 'completed']) {
      expect(isCapturedOrder({ status, payment_captured: true }), status).toBe(true)
    }
  })

  test('a garbage order object is refused rather than throwing', () => {
    expect(isCapturedOrder({})).toBe(false)
    expect(isCapturedOrder({ status: null, payment_captured: null })).toBe(false)
  })
})

test.describe('shopIdForEmissionSubject — emission subjects back to shops (2026-10-29)', () => {
  // Real ids from the production incident: the sweep read 29 relationship ids as shop ids, found no shop row for
  // any of them, and counted each as an error, so the cron answered 503 every day.
  const REL = '0d6c9a52-7f3e-4b1a-9c55-2f1e8b7a4d10'
  const SHOP = '9f8eb59b-5638-4e34-a037-c9ad57d7fcc3'
  const SCOUTED_REL = '5b2f0c1e-8d4a-4e7f-b1c3-6a9d2e0f7c44'
  const LEGACY_SHOP = '11d0bcd9-9689-4f8c-aa9c-b9055741e2d3'
  const rels = new Map<string, string | null>([
    [REL, SHOP],
    [SCOUTED_REL, null],
  ])

  test('a relationship id maps to its shop', () => {
    expect(shopIdForEmissionSubject(REL, rels)).toBe(SHOP)
  })

  test('a relationship with no shop yet has nothing for the shop sweep', () => {
    expect(shopIdForEmissionSubject(SCOUTED_REL, rels)).toBeNull()
  })

  test('a pre-Sprint-3 row already holds a shop id and passes through unchanged', () => {
    expect(shopIdForEmissionSubject(LEGACY_SHOP, rels)).toBe(LEGACY_SHOP)
  })

  test('an empty subject maps to nothing', () => {
    expect(shopIdForEmissionSubject('', rels)).toBeNull()
  })
})
