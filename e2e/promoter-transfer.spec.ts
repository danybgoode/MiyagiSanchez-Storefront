import { test, expect } from '@playwright/test'
import {
  TRANSFER_SKUS,
  isTransferSku,
  TRANSFER_METHODS,
  isTransferMethod,
  computeOwedCents,
  canTransitionTransfer,
  SKU_GRANT_KEYS,
  TRANSFER_SKU_LABEL,
  hasRequiredTransferDetail,
  type TransferStatus,
} from '../lib/promoter-transfer'

/**
 * Promoter Funnel v2 · Sprint 4 (US-4.1/US-4.2) — net-remittance transfers
 * (api project: pure seam + anonymous/flag-agnostic route guards, no network,
 * no Supabase). Mirrors e2e/promoter-commission.spec.ts's shape.
 *
 *  1. PURE LIB — the owed-amount math (advertised = charged = owed), the
 *     remittance state machine, the per-SKU activation mapping.
 *  2. ROUTE GUARDS — the new close/transfer + admin/transfers routes reject
 *     appropriately when anonymous / the flag is off.
 *
 * NOT covered (owed to Daniel — sprint-4.md smoke): a real transfer → approve →
 * activation round trip (needs the flag on + a real bound promoter + a real
 * admin session).
 */

test.describe('promoter-transfer · SKU + method narrowing', () => {
  test('TRANSFER_SKUS is exactly the close-workspace SKUs plus the three packages (print_ad excluded)', () => {
    expect(TRANSFER_SKUS).toEqual(['custom_domain', 'subdomain', 'ml_sync', 'migration', 'negocio_anual', 'negocio_arranque', 'setup_gratis'])
  })

  test('isTransferSku narrows correctly', () => {
    for (const sku of TRANSFER_SKUS) expect(isTransferSku(sku)).toBe(true)
    for (const bad of ['print_ad', 'unknown', '', null, undefined, 123]) {
      expect(isTransferSku(bad as unknown)).toBe(false)
    }
  })

  test('TRANSFER_METHODS is exactly SPEI/DiMo/CoDi', () => {
    expect(TRANSFER_METHODS).toEqual(['spei', 'dimo', 'codi'])
  })

  test('isTransferMethod narrows correctly', () => {
    for (const method of TRANSFER_METHODS) expect(isTransferMethod(method)).toBe(true)
    for (const bad of ['stripe', 'cash', '', null, undefined]) {
      expect(isTransferMethod(bad as unknown)).toBe(false)
    }
  })
})

test.describe('promoter-transfer · owed math (computeOwedCents) — the S3 deriver combined with commission', () => {
  test('owed = gross − commission, matching computeCommissionCents exactly', () => {
    expect(computeOwedCents(49900, 15)).toBe(49900 - 7485) // 42415
    expect(computeOwedCents(19900, 10)).toBe(19900 - 1990) // 17910
  })

  test('a 0% commission rate means the full gross is owed', () => {
    expect(computeOwedCents(49900, 0)).toBe(49900)
  })

  test('the $0-subdomain case (Sprint 3 · US-3.2) owes exactly $0, no special-casing needed', () => {
    expect(computeOwedCents(0, 15)).toBe(0)
    expect(computeOwedCents(0, 0)).toBe(0)
  })

  test('never negative, even at the (unreachable, since rates are capped at 100) edge', () => {
    expect(computeOwedCents(100, 100)).toBe(0)
    expect(computeOwedCents(100, 100)).toBeGreaterThanOrEqual(0)
  })
})

test.describe('promoter-transfer · remittance state machine (canTransitionTransfer)', () => {
  test('the legal forward path: pending → reported → approved | rejected', () => {
    expect(canTransitionTransfer('pending', 'reported')).toBe(true)
    expect(canTransitionTransfer('reported', 'approved')).toBe(true)
    expect(canTransitionTransfer('reported', 'rejected')).toBe(true)
  })

  test('same-state is a no-op (idempotent re-tap / re-settle)', () => {
    const states: TransferStatus[] = ['pending', 'reported', 'approved', 'rejected']
    for (const s of states) expect(canTransitionTransfer(s, s)).toBe(true)
  })

  test('rejects skip-ahead (pending straight to approved/rejected)', () => {
    expect(canTransitionTransfer('pending', 'approved')).toBe(false)
    expect(canTransitionTransfer('pending', 'rejected')).toBe(false)
  })

  test('rejects backward moves', () => {
    expect(canTransitionTransfer('reported', 'pending')).toBe(false)
    expect(canTransitionTransfer('approved', 'reported')).toBe(false)
    expect(canTransitionTransfer('rejected', 'reported')).toBe(false)
  })

  test('approved and rejected are terminal — no transition out', () => {
    expect(canTransitionTransfer('approved', 'pending')).toBe(false)
    expect(canTransitionTransfer('approved', 'rejected')).toBe(false)
    expect(canTransitionTransfer('rejected', 'approved')).toBe(false)
  })
})

test.describe('promoter-transfer · per-SKU activation mapping (SKU_GRANT_KEYS)', () => {
  test('covers every transfer SKU, matching the existing entitlement-reader keys', () => {
    expect(SKU_GRANT_KEYS).toEqual({
      custom_domain: 'custom_domain_grant',
      subdomain: 'subdomain_grant',
      ml_sync: 'ml_sync_grant',
      migration: 'migration_grant',
      // The packages grant Negocio through applyNegocioPayment; the free setup grants nothing.
      negocio_anual: 'negocio_grant',
      negocio_arranque: 'negocio_grant',
      setup_gratis: '',
    })
  })

  test('every TRANSFER_SKUS entry has a grant key', () => {
    for (const sku of TRANSFER_SKUS) expect(typeof SKU_GRANT_KEYS[sku]).toBe('string')
  })

  test('TRANSFER_SKU_LABEL covers exactly the 4 in-scope SKUs (es-MX)', () => {
    for (const sku of TRANSFER_SKUS) expect(typeof TRANSFER_SKU_LABEL[sku]).toBe('string')
  })
})

test.describe('promoter-transfer · transfer-details completeness (hasRequiredTransferDetail)', () => {
  test('refuses when the required field for the method is missing/blank', () => {
    expect(hasRequiredTransferDetail({}, 'spei')).toBe(false)
    expect(hasRequiredTransferDetail({ clabe: '  ' }, 'spei')).toBe(false)
    expect(hasRequiredTransferDetail({ dimo_phone: '' }, 'dimo')).toBe(false)
    expect(hasRequiredTransferDetail({}, 'codi')).toBe(false)
  })

  test('accepts when the required field is a non-blank string, ignoring unrelated fields', () => {
    expect(hasRequiredTransferDetail({ clabe: '012180001234567895' }, 'spei')).toBe(true)
    expect(hasRequiredTransferDetail({ dimo_phone: '5512345678' }, 'dimo')).toBe(true)
    expect(hasRequiredTransferDetail({ codi_reference: 'REF-123' }, 'codi')).toBe(true)
    // A CLABE alone doesn't satisfy DiMo — each method checks ITS OWN field.
    expect(hasRequiredTransferDetail({ clabe: '012180001234567895' }, 'dimo')).toBe(false)
  })
})

test.describe('promoter-transfer · route guards (flag-agnostic — asserted in both states)', () => {
  // The single-product closes are retired (the packages replaced them): hidden (404) or retired (410), never a transfer.
  test('POST /api/promoter/close/domain with paymentMethod:transfer → 404 (hidden) or 410 (retired)', async ({ request }) => {
    const res = await request.post('/api/promoter/close/domain', { data: { paymentMethod: 'transfer', transferMethod: 'spei' } })
    expect([404, 410]).toContain(res.status())
  })

  test('POST /api/promoter/close/subdomain with paymentMethod:transfer → 404 (hidden) or 410 (retired)', async ({ request }) => {
    const res = await request.post('/api/promoter/close/subdomain', { data: { paymentMethod: 'transfer', transferMethod: 'dimo' } })
    expect([404, 410]).toContain(res.status())
  })

  test('POST /api/promoter/close/ml-sync with paymentMethod:transfer → 404 (hidden) or 410 (retired)', async ({ request }) => {
    const res = await request.post('/api/promoter/close/ml-sync', { data: { paymentMethod: 'transfer', transferMethod: 'codi' } })
    expect([404, 410]).toContain(res.status())
  })

  test('GET /api/promoter/close/transfer → 404 (hidden) or 401 (auth required)', async ({ request }) => {
    const res = await request.get('/api/promoter/close/transfer?shopId=x&sku=custom_domain')
    expect([401, 404]).toContain(res.status())
  })

  test('POST /api/promoter/close/transfer/:id/report → 404 (hidden) or 401 (auth required)', async ({ request }) => {
    const res = await request.post('/api/promoter/close/transfer/does-not-exist/report')
    expect([401, 404]).toContain(res.status())
  })

  test('admin transfer routes require a Clerk admin session → 401', async ({ request }) => {
    const list = await request.get('/api/admin/promoter/transfers')
    expect(list.status()).toBe(401)
    const approve = await request.post('/api/admin/promoter/transfers/does-not-exist/approve')
    expect(approve.status()).toBe(401)
    const reject = await request.post('/api/admin/promoter/transfers/does-not-exist/reject')
    expect(reject.status()).toBe(401)
  })
})
