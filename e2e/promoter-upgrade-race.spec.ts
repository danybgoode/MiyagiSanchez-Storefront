/**
 * The 20% upgrade share is validate → claim → apply (plan-tienda S4 review, Codex security on PR 486): a Negocio
 * package attribution that lands between the supersession check and the share's insert pays NO 20%.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { runUpgradeShare, type UpgradeShareDeps } from '../lib/promoter-upgrade-share'

const ANCHOR_PAID = new Date('2026-11-10T12:00:00.000Z')
const PAYMENT = new Date('2027-01-15T00:00:00.000Z')

/** The attributions table for one shop: the share row keyed by its payment_ref (one row: the unique index). */
function ledger(opts: { packageLandsAfterReads?: number } = {}) {
  let reads = 0
  let packageSold = false
  const rows = new Map<string, { id: string; status: string; gross: number }>()
  const accrued = new Set<string>()
  const deps: UpgradeShareDeps = {
    readAnchor: async () => ({ attributionId: 'attr-tienda', promoterId: 'prm-a', paidAt: ANCHOR_PAID }),
    negocioPackageAfter: async () => {
      reads += 1
      const seen = packageSold
      // The package attribution commits right AFTER the n-th supersession read returned.
      if (opts.packageLandsAfterReads === reads) packageSold = true
      return seen
    },
    claim: async ({ paymentRef, grossCents }) => {
      const existing = rows.get(paymentRef)
      if (existing) return { id: existing.id, status: existing.status }
      const row = { id: `row-${rows.size + 1}`, status: 'claimed', gross: grossCents }
      rows.set(paymentRef, row)
      return { id: row.id, status: row.status }
    },
    voidClaim: async (id) => { for (const r of rows.values()) if (r.id === id && r.status === 'claimed') r.status = 'void' },
    confirmClaim: async (id) => {
      for (const r of rows.values()) if (r.id === id) { if (r.status === 'claimed') r.status = 'paid'; return r.status }
      throw new Error('no row')
    },
    accrue: async (id) => {
      const r = [...rows.values()].find((x) => x.id === id)
      if (r?.status !== 'paid') return { kind: 'failed', error: 'not paid' }
      accrued.add(id)
      return { kind: 'accrued' }
    },
  }
  return { deps, rows, accrued }
}

test('no race: the first Negocio payment within 12 months is claimed, confirmed and accrued once', async () => {
  const l = ledger()
  expect(await runUpgradeShare({ paidAt: PAYMENT, grossCents: 59_900 }, l.deps)).toBe('recorded')
  expect([...l.rows.values()]).toEqual([{ id: 'row-1', status: 'paid', gross: 59_900 }])
  expect(l.accrued.size).toBe(1)
  // The redelivery (or a second Negocio payment) collides on the anchor's ref and only re-runs the accrual.
  expect(await runUpgradeShare({ paidAt: PAYMENT, grossCents: 1 }, l.deps)).toBe('replay')
  expect(l.rows.size).toBe(1)
  expect([...l.rows.values()][0].gross).toBe(59_900)
})

test('THE RACE: a package lands between the check and the insert — the re-check voids the claim and no 20% accrues', async () => {
  const l = ledger({ packageLandsAfterReads: 1 })
  expect(await runUpgradeShare({ paidAt: PAYMENT, grossCents: 59_900 }, l.deps)).toBe('superseded')
  expect([...l.rows.values()].map((r) => r.status)).toEqual(['void'])
  expect(l.accrued.size).toBe(0)
  // And it stays that way: a later payment under the same tienda_anual finds the void row.
  expect(await runUpgradeShare({ paidAt: PAYMENT, grossCents: 59_900 }, l.deps)).toBe('superseded')
  expect(l.accrued.size).toBe(0)
})

test('a package already sold before the check: nothing is even claimed', async () => {
  const l = ledger()
  const sold: UpgradeShareDeps = { ...l.deps, negocioPackageAfter: async () => true }
  expect(await runUpgradeShare({ paidAt: PAYMENT, grossCents: 59_900 }, sold)).toBe('superseded')
  expect(l.rows.size).toBe(0)
})

test('a delivery that stopped after the claim is finished by the next one — unless a package landed meanwhile', async () => {
  const done = ledger()
  done.rows.set('negocio_upgrade:attr-tienda', { id: 'row-1', status: 'claimed', gross: 59_900 })
  expect(await runUpgradeShare({ paidAt: PAYMENT, grossCents: 59_900 }, done.deps)).toBe('recorded')
  expect(done.accrued.size).toBe(1)

  const late = ledger()
  late.rows.set('negocio_upgrade:attr-tienda', { id: 'row-1', status: 'claimed', gross: 59_900 })
  const sold: UpgradeShareDeps = { ...late.deps, negocioPackageAfter: async () => true }
  // Validation already sees the package: no claim is touched, and the stale claim never accrues.
  expect(await runUpgradeShare({ paidAt: PAYMENT, grossCents: 59_900 }, sold)).toBe('superseded')
  expect(late.accrued.size).toBe(0)
})

test('a concurrent void wins over a confirm: the loser reads the final state and pays nothing', async () => {
  const l = ledger()
  const racing: UpgradeShareDeps = {
    ...l.deps,
    confirmClaim: async (id) => { await l.deps.voidClaim(id); return l.deps.confirmClaim(id) },
  }
  expect(await runUpgradeShare({ paidAt: PAYMENT, grossCents: 59_900 }, racing)).toBe('superseded')
  expect(l.accrued.size).toBe(0)
})

test('the server claims in a state that does not accrue, and voids and confirms only while claimed', () => {
  const src = readFileSync('lib/promoter-renewal-server.ts', 'utf8')
  const up = src.slice(src.indexOf('export async function recordUpgradeShare'), src.indexOf('export async function recordNegocioPaymentShares'))
  expect(up).toContain("status: 'claimed', payment_ref: ref")
  expect(up).toContain(".update({ status: 'void' }).eq('id', id).eq('status', 'claimed')")
  expect(up).toContain(".update({ status: 'paid' }).eq('id', id).eq('status', 'claimed')")
  // The accrual pays only paid rows, so a claimed row can never be paid by mistake.
  expect(readFileSync('lib/promoter-commission.ts', 'utf8')).toContain("if (attribution.status !== 'paid') return { ok: false, reason: 'not_paid' }")
})

test('a row already voided stays void, even if no later package is visible any more: answered, never retried, never paid', async () => {
  const l = ledger()
  l.rows.set('negocio_upgrade:attr-tienda', { id: 'row-1', status: 'void', gross: 59_900 })
  expect(await runUpgradeShare({ paidAt: PAYMENT, grossCents: 59_900 }, l.deps)).toBe('superseded')
  expect(l.accrued.size).toBe(0)
})
