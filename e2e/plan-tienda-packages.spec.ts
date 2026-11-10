/**
 * The promoter's three packages with three free months on top (epic 08 · plan-tienda-three-free-months S4.1, README
 * D11, D12, D13).
 *
 * The grants are exercised through the REAL plan seam (`decideNegocioPayment`, `decideTiendaPayment`,
 * `grantWriteRpcArgs`) against an in-memory stand-in for `merge_shop_metadata_guards` that applies the patch only when
 * every guard still holds — so replay, a crash between the two writes and the dates are the dates production writes.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import {
  PACKAGES,
  PACKAGE_SKUS,
  RETIRED_PACKAGE_SKUS,
  SELLABLE_PACKAGE_SKUS,
  applyPackageGrants,
  isPackageSku,
  isRetiredPackageSku,
  isSellablePackageSku,
  packageMonths,
  packageSentence,
  packageSplit,
  type PackageGrantDeps,
  type PackageGrantInput,
} from '../lib/promoter-packages'
import { isValidRatePct } from '../lib/promoter-commission'
import { PROMOTER_SKUS } from '../lib/promoter-skus'
import { TRANSFER_SKUS } from '../lib/promoter-transfer'
import {
  NEGOCIO_GRANT_KEY,
  TIENDA_GRANT_KEY,
  decideNegocioPayment,
  decideTiendaPayment,
  grantWriteRpcArgs,
  readNegocioGrant,
  readTiendaGrant,
  type GrantWriteRpcArgs,
} from '../lib/plan'
import { receiptStatus, signReceiptToken, verifyReceiptToken } from '../lib/promoter-receipt'
import { decidePlanPayment } from '../lib/plan-payment'

const PAID = new Date('2026-11-10T12:00:00.000Z')

// ── An in-memory `merge_shop_metadata_guards` ─────────────────────────────────

function guardHolds(meta: Record<string, unknown>, g: GrantWriteRpcArgs['p_guards'][number]): boolean {
  if (g.mode === 'absent') return !(g.key in meta)
  if (g.mode === 'json_null') return g.key in meta && meta[g.key] === null
  return g.mode === 'equals' && g.key in meta && isDeepStrictEqual(meta[g.key], g.expected)
}

/** A shop row and the plan seam's appliers over it, with an optional crash after the Nth successful write. */
function shopStore(initial: Record<string, unknown>, opts: { crashAfterWrites?: number } = {}) {
  const state = { metadata: structuredClone(initial), writes: 0 }
  const rpc = (args: GrantWriteRpcArgs): boolean => {
    if (!args.p_guards.every((g) => guardHolds(state.metadata, g))) return false
    state.metadata = { ...state.metadata, ...structuredClone(args.p_patch) }
    state.writes += 1
    return true
  }
  const deps: PackageGrantDeps = {
    apply: async (plan, input: PackageGrantInput) => {
      if (opts.crashAfterWrites !== undefined && state.writes >= opts.crashAfterWrites) throw new Error('process died')
      const decision = plan === 'negocio' ? decideNegocioPayment(state.metadata, input) : decideTiendaPayment(state.metadata, input)
      if (decision.action !== 'write') return decision.action
      if (!rpc(grantWriteRpcArgs('shop-1', plan === 'negocio' ? NEGOCIO_GRANT_KEY : TIENDA_GRANT_KEY, decision))) throw new Error('guard fired')
      return 'written'
    },
  }
  return { state, deps }
}

const trial = (expires: string) => ({ negocio_trial: { started_at: '2026-11-10T00:00:00.000Z', expires_at: expires } })
const ends = (meta: Record<string, unknown>) => ({ negocio: readNegocioGrant(meta)?.expires_at ?? null, tienda: readTiendaGrant(meta)?.expires_at ?? null })

// ── The vocabulary and the money ──────────────────────────────────────────────

test.describe('the three packages on sale and the two retired ones (D11)', () => {
  test('three packages are sold, in this order; the retired two stay in the vocabulary', () => {
    expect([...SELLABLE_PACKAGE_SKUS]).toEqual(['tienda_anual', 'negocio_semestral', 'negocio_anual'])
    expect([...RETIRED_PACKAGE_SKUS]).toEqual(['negocio_arranque', 'setup_gratis'])
    for (const sku of [...SELLABLE_PACKAGE_SKUS, ...RETIRED_PACKAGE_SKUS]) {
      expect(isPackageSku(sku), sku).toBe(true)
      expect(PROMOTER_SKUS, sku).toContain(sku)
      expect(TRANSFER_SKUS, sku).toContain(sku)
    }
    for (const sku of RETIRED_PACKAGE_SKUS) {
      expect(isRetiredPackageSku(sku)).toBe(true)
      expect(isSellablePackageSku(sku)).toBe(false)
    }
    for (const sku of SELLABLE_PACKAGE_SKUS) expect(isRetiredPackageSku(sku)).toBe(false)
    // Every package is exactly one of the two.
    expect(PACKAGE_SKUS.length).toBe(SELLABLE_PACKAGE_SKUS.length + RETIRED_PACKAGE_SKUS.length)
    for (const share of ['tienda_renewal', 'negocio_upgrade']) expect(PROMOTER_SKUS).toContain(share)
  })

  test("each split from an INTEGER rate, exactly: Daniel's numbers", () => {
    expect(packageSplit('tienda_anual', 60)).toEqual({ chargeCents: 50_000, keepCents: 30_000, payPlatformCents: 20_000 })
    expect(packageSplit('negocio_semestral', 55)).toEqual({ chargeCents: 110_000, keepCents: 60_500, payPlatformCents: 49_500 })
    expect(packageSplit('negocio_anual', 55)).toEqual({ chargeCents: 200_000, keepCents: 110_000, payPlatformCents: 90_000 })
    expect(packageSentence('tienda_anual', 60)).toBe('Cobras $500. Le pasas $200 a Miyagi Sánchez. Te quedas $300')
    expect(packageSentence('negocio_semestral', 55)).toBe('Cobras $1,100. Le pasas $495 a Miyagi Sánchez. Te quedas $605')
  })

  test('the six-month package cannot be split 500 / 600 with an integer rate — the reason it is 495 / 605 (D12)', () => {
    expect(isValidRatePct(54.54)).toBe(false)
    for (let rate = 0; rate <= 100; rate += 1) expect(packageSplit('negocio_semestral', rate).keepCents, `rate ${rate}`).not.toBe(60_000)
  })

  test('what each package grants: three free months of Negocio on top of the paid time', () => {
    expect(PACKAGES.tienda_anual.grants).toEqual([{ plan: 'negocio', months: 3 }, { plan: 'tienda', months: 12 }])
    expect(PACKAGES.negocio_semestral.grants).toEqual([{ plan: 'negocio', months: 9 }])
    expect(PACKAGES.negocio_anual.grants).toEqual([{ plan: 'negocio', months: 15 }])
    expect(packageMonths('negocio_anual', 'negocio')).toBe(15)
    expect(packageMonths('tienda_anual', 'tienda')).toBe(12)
    // Retired: their ORIGINAL grants, so an old pending transfer can still be approved as sold.
    expect(PACKAGES.negocio_arranque.grants).toEqual([{ plan: 'negocio', months: 3 }])
    expect(PACKAGES.setup_gratis.grants).toEqual([])
  })
})

// ── The grants, written through the plan seam ─────────────────────────────────

test.describe('the grants are dated from the payment day (D11)', () => {
  test('tienda_anual on a new shop: Negocio 3 months, then Tienda 12 — a live trial does not push them back', async () => {
    const { state, deps } = shopStore(trial('2027-02-08T12:00:00.000Z'))
    expect(await applyPackageGrants({ sku: 'tienda_anual', shopId: 'shop-1', paymentId: 'cs_1', now: PAID }, deps)).toBe('written')
    expect(ends(state.metadata)).toEqual({ negocio: '2027-02-10T12:00:00.000Z', tienda: '2028-02-10T12:00:00.000Z' })
    // The trial is untouched: a package does not use it (rabbit hole).
    expect(state.metadata.negocio_trial).toEqual(trial('2027-02-08T12:00:00.000Z').negocio_trial)
  })

  test('the production loop carries ignoreTrial into the decision (lib/plan-payment.ts decidePlanPayment)', () => {
    const meta = trial('2027-06-01T00:00:00.000Z')
    const input = { shopId: 'shop-1', paymentId: 'cs_1', months: 3, note: 'promoter tienda_anual', now: PAID, ignoreTrial: true }
    const negocio = decidePlanPayment('negocio', meta, input)
    expect(negocio.action === 'write' && negocio.grant.expires_at).toBe('2027-02-10T12:00:00.000Z')
    // Without the flag the same payment would start after the trial: the flag is what makes the difference.
    const plain = decidePlanPayment('negocio', meta, { ...input, ignoreTrial: undefined })
    expect(plain.action === 'write' && plain.grant.expires_at).toBe('2027-09-01T00:00:00.000Z')
  })

  test('a trial that would outlast the free months still does not delay the paid ones', async () => {
    const { state, deps } = shopStore(trial('2027-06-01T00:00:00.000Z'))
    await applyPackageGrants({ sku: 'tienda_anual', shopId: 'shop-1', paymentId: 'cs_1', now: PAID }, deps)
    expect(ends(state.metadata)).toEqual({ negocio: '2027-02-10T12:00:00.000Z', tienda: '2028-02-10T12:00:00.000Z' })
  })

  test('negocio_semestral → 9 months; negocio_anual → 15 months, from the payment day', async () => {
    const six = shopStore(trial('2027-02-08T12:00:00.000Z'))
    await applyPackageGrants({ sku: 'negocio_semestral', shopId: 'shop-1', paymentId: 'cs_6', now: PAID }, six.deps)
    expect(ends(six.state.metadata)).toEqual({ negocio: '2027-08-10T12:00:00.000Z', tienda: null })
    const year = shopStore({})
    await applyPackageGrants({ sku: 'negocio_anual', shopId: 'shop-1', paymentId: 'cs_12', now: PAID }, year.deps)
    expect(ends(year.state.metadata)).toEqual({ negocio: '2028-02-10T12:00:00.000Z', tienda: null })
  })

  test('a live Tienda grant at payment time is kept: moved past the free Negocio months, then the 12 paid months added', async () => {
    const tienda = { type: 'one_time', granted_at: '2026-05-01T00:00:00.000Z', expires_at: '2027-05-01T00:00:00.000Z', payments: ['cs_old'] }
    const { state, deps } = shopStore({ tienda_grant: tienda })
    await applyPackageGrants({ sku: 'tienda_anual', shopId: 'shop-1', paymentId: 'cs_1', now: PAID }, deps)
    // 2027-05-01 + 3 (moved under the Negocio months, D4) + 12 (paid) = 2028-08-01.
    expect(ends(state.metadata)).toEqual({ negocio: '2027-02-10T12:00:00.000Z', tienda: '2028-08-01T00:00:00.000Z' })
    expect(readTiendaGrant(state.metadata)?.payments).toEqual(['cs_old', 'cs_1'])
    // negocio_anual over a live Tienda grant moves it by the 15 months it grants.
    const year = shopStore({ tienda_grant: tienda })
    await applyPackageGrants({ sku: 'negocio_anual', shopId: 'shop-1', paymentId: 'cs_12', now: PAID }, year.deps)
    expect(ends(year.state.metadata)).toEqual({ negocio: '2028-02-10T12:00:00.000Z', tienda: '2028-08-01T00:00:00.000Z' })
  })

  test('a live PAID Negocio term is never thrown away: the package adds after it', async () => {
    const negocio = { type: 'one_time', granted_at: '2026-01-01T00:00:00.000Z', expires_at: '2027-01-01T00:00:00.000Z' }
    const { state, deps } = shopStore({ negocio_grant: negocio })
    await applyPackageGrants({ sku: 'negocio_semestral', shopId: 'shop-1', paymentId: 'cs_6', now: PAID }, deps)
    expect(ends(state.metadata).negocio).toBe('2027-10-01T00:00:00.000Z')
  })

  test('a permanent Negocio: nothing is written, and no Tienda months are spent under it', async () => {
    const { state, deps } = shopStore({ negocio_grant: { type: 'comp', granted_at: '2026-01-01T00:00:00.000Z' } })
    expect(await applyPackageGrants({ sku: 'tienda_anual', shopId: 'shop-1', paymentId: 'cs_1', now: PAID }, deps)).toBe('comp')
    expect(state.writes).toBe(0)
    expect(state.metadata.tienda_grant).toBeUndefined()
  })

  test('the retired free setup grants nothing', async () => {
    const { state, deps } = shopStore({})
    expect(await applyPackageGrants({ sku: 'setup_gratis', shopId: 'shop-1', paymentId: 'cs_g', now: PAID }, deps)).toBe('none')
    expect(state.writes).toBe(0)
  })
})

test.describe('replay and a crash between the two writes (D11)', () => {
  test('a replayed webhook or a re-approved transfer adds nothing', async () => {
    const { state, deps } = shopStore(trial('2027-02-08T12:00:00.000Z'))
    await applyPackageGrants({ sku: 'tienda_anual', shopId: 'shop-1', paymentId: 'transfer:t1', now: PAID }, deps)
    const once = structuredClone(state.metadata)
    expect(await applyPackageGrants({ sku: 'tienda_anual', shopId: 'shop-1', paymentId: 'transfer:t1', now: new Date('2026-11-20T00:00:00.000Z') }, deps)).toBe('replay')
    expect(state.metadata).toEqual(once)
    expect(state.writes).toBe(2)
  })

  test('both grants carry the same payment id', async () => {
    const { state, deps } = shopStore({})
    await applyPackageGrants({ sku: 'tienda_anual', shopId: 'shop-1', paymentId: 'cs_1', now: PAID }, deps)
    expect(readNegocioGrant(state.metadata)?.payments).toEqual(['cs_1'])
    expect(readTiendaGrant(state.metadata)?.payments).toEqual(['cs_1'])
  })

  test('a crash after the Negocio write: the retry completes ONLY the Tienda half, landing on the same dates', async () => {
    const whole = shopStore(trial('2027-02-08T12:00:00.000Z'))
    await applyPackageGrants({ sku: 'tienda_anual', shopId: 'shop-1', paymentId: 'cs_1', now: PAID }, whole.deps)

    const crashed = shopStore(trial('2027-02-08T12:00:00.000Z'), { crashAfterWrites: 1 })
    await expect(applyPackageGrants({ sku: 'tienda_anual', shopId: 'shop-1', paymentId: 'cs_1', now: PAID }, crashed.deps)).rejects.toThrow('process died')
    expect(ends(crashed.state.metadata)).toEqual({ negocio: '2027-02-10T12:00:00.000Z', tienda: null })

    // The retry runs days later on a healthy process, over the half-written row.
    const retry = shopStore(crashed.state.metadata)
    expect(await applyPackageGrants({ sku: 'tienda_anual', shopId: 'shop-1', paymentId: 'cs_1', now: new Date('2026-11-13T09:00:00.000Z') }, retry.deps)).toBe('written')
    expect(retry.state.writes).toBe(1) // the Negocio half was a replay
    expect(ends(retry.state.metadata)).toEqual(ends(whole.state.metadata))
    expect(readNegocioGrant(retry.state.metadata)?.payments).toEqual(['cs_1'])
    // And a further replay repeats nothing.
    expect(await applyPackageGrants({ sku: 'tienda_anual', shopId: 'shop-1', paymentId: 'cs_1', now: PAID }, retry.deps)).toBe('replay')
  })

  test('the order is a choice, not a correctness condition: Tienda first lands on the same dates', async () => {
    const tiendaFirst = shopStore({})
    await tiendaFirst.deps.apply('tienda', { shopId: 'shop-1', paymentId: 'cs_1', months: 12, note: 'x', now: PAID, ignoreTrial: true })
    await tiendaFirst.deps.apply('negocio', { shopId: 'shop-1', paymentId: 'cs_1', months: 3, note: 'x', now: PAID, ignoreTrial: true })
    const negocioFirst = shopStore({})
    await applyPackageGrants({ sku: 'tienda_anual', shopId: 'shop-1', paymentId: 'cs_1', now: PAID }, negocioFirst.deps)
    expect(ends(tiendaFirst.state.metadata)).toEqual(ends(negocioFirst.state.metadata))
  })
})

// ── Retired: refused for sale, still readable ─────────────────────────────────

test.describe('retired packages are refused for sale and still read (D11)', () => {
  test('the sale route answers 410 for a retired package, before the rate is read or any payment path runs', () => {
    const route = readFileSync('app/api/promoter/close/package/[sku]/route.ts', 'utf8')
    const refusal = route.indexOf('if (isRetiredPackageSku(sku)) return NextResponse.json({ ok: false, error: RETIRED_PACKAGE_MESSAGE }, { status: 410 })')
    expect(refusal).toBeGreaterThan(-1)
    expect(refusal).toBeLessThan(route.indexOf('getConfiguredCommissionRate(sku)'))
    expect(refusal).toBeLessThan(route.indexOf("if (body.paymentMethod === 'transfer')"))
    expect(refusal).toBeLessThan(route.indexOf('startPackageCardCheckout('))
  })

  test('a new receipt for a retired package is refused too; one already issued still verifies', () => {
    const route = readFileSync('app/api/promoter/close/receipt/route.ts', 'utf8')
    const refusal = route.indexOf('if (isRetiredPackageSku(body.sku))')
    expect(refusal).toBeGreaterThan(-1)
    expect(refusal).toBeLessThan(route.indexOf('signReceiptToken('))
    const old = { shopId: 's', sku: 'setup_gratis' as const, promoterId: 'p', amountCents: 25_000, issuedAt: '2026-11-06T00:00:00.000Z' }
    expect(verifyReceiptToken(signReceiptToken(old, 'k'), 'k')?.sku).toBe('setup_gratis')
  })

  test('old receipts read their status: the free setup is ready, the 3-month package reads its Negocio end', () => {
    const base = { attributionPaid: true, transferStatus: null, negocioEndsAt: '2027-02-01T00:00:00.000Z', now: PAID }
    expect(receiptStatus({ ...base, sku: 'setup_gratis' })).toEqual({ kind: 'ready' })
    expect(receiptStatus({ ...base, sku: 'negocio_arranque' })).toEqual({ kind: 'active', endsAt: '2027-02-01T00:00:00.000Z' })
  })

  test('the Cobra step offers only the packages on sale; the card webhook and the transfer approval still honour a retired one', () => {
    const ui = readFileSync('app/(shell)/promotor/cerrar/CobraStep.tsx', 'utf8')
    expect(ui).toContain('const PACKAGE_OPTIONS: readonly SellablePackageSku[] = SELLABLE_PACKAGE_SKUS')
    const card = readFileSync('lib/promoter-package-server.ts', 'utf8')
    expect(card).toContain('if (!isPackageSku(sku)')
    expect(card).not.toContain('isSellablePackageSku')
    const approve = readFileSync('lib/promoter-grant-server.ts', 'utf8')
    expect(approve).toContain('if (isPackageSku(sku)) {')
    expect(approve).not.toContain('isSellablePackageSku')
  })
})

test.describe('a tienda_anual receipt reads the Tienda end', () => {
  test('active until the Tienda grant ends, and says it is Tienda', () => {
    const base = { sku: 'tienda_anual' as const, attributionPaid: true, transferStatus: null, negocioEndsAt: '2027-02-10T12:00:00.000Z', now: PAID }
    expect(receiptStatus({ ...base, tiendaEndsAt: '2028-02-10T12:00:00.000Z' })).toEqual({ kind: 'active', endsAt: '2028-02-10T12:00:00.000Z', plan: 'tienda' })
    expect(receiptStatus({ ...base, tiendaEndsAt: '2026-11-01T00:00:00.000Z' })).toEqual({ kind: 'ended', endsAt: '2026-11-01T00:00:00.000Z', plan: 'tienda' })
  })
})

// ── Migration M1, static ──────────────────────────────────────────────────────

test.describe('migration M1 (20261111000000) — static check of the SQL (D13)', () => {
  const sql = readFileSync('supabase/migrations/20261111000000_plan_tienda_packages.sql', 'utf8')
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

  test('additive only: no delete, update, truncate, dropped table, column or index', () => {
    expect(code).not.toMatch(/\b(delete\s+from|update\s+public|truncate|drop\s+table|drop\s+column|drop\s+index|alter\s+column)\b/i)
    // The only drop is the transfers CHECK, re-added in the next statement.
    expect(code.match(/drop constraint/gi)?.length).toBe(1)
    const drop = code.indexOf('drop constraint marketplace_promoter_transfers_sku_check')
    const add = code.indexOf('add constraint marketplace_promoter_transfers_sku_check')
    expect(drop).toBeGreaterThan(-1)
    expect(add).toBeGreaterThan(drop)
  })

  test('the widened transfers CHECK keeps every value the previous one allowed and adds the two packages', () => {
    const previous = readFileSync('supabase/migrations/20261105000000_plans_negocio.sql', 'utf8')
    const prevCheck = previous.slice(previous.indexOf('add constraint marketplace_promoter_transfers_sku_check'), previous.indexOf(']));', previous.indexOf('add constraint marketplace_promoter_transfers_sku_check')))
    const oldValues = [...prevCheck.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1])
    expect(oldValues.length).toBeGreaterThan(0)
    const check = code.slice(code.indexOf('add constraint marketplace_promoter_transfers_sku_check'))
    for (const v of oldValues) expect(check, v).toContain(`'${v}'::text`)
    for (const v of ['tienda_anual', 'negocio_semestral']) expect(check).toContain(`'${v}'::text`)
    // And every sku the app sends to that table is allowed (the table's whole vocabulary, from the code).
    for (const v of TRANSFER_SKUS) expect(check, v).toContain(`'${v}'::text`)
  })

  test('the four rate rows, with Daniel’s integers, never overwriting an admin edit', () => {
    for (const row of ["('tienda_anual', 60, now())", "('negocio_semestral', 55, now())", "('tienda_renewal', 10, now())", "('negocio_upgrade', 20, now())"]) {
      expect(code).toContain(row)
    }
    expect(code).toMatch(/on conflict \(sku\) do nothing;/)
    expect(code).not.toMatch(/do update/i)
    expect(code).not.toContain("'negocio_anual', ")
  })
})
