/**
 * «El recibo del negocio» (promoter-panel S4.1, D10): the merchant's receipt the moment they pay the promoter — a signed
 * link, a status read live, the WhatsApp message from the locale, and the email sent in the same call.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import es from '../locales/es.json' with { type: 'json' }
import {
  formatReceiptAmount,
  receiptStatus,
  receiptWhatsappUrl,
  signReceiptToken,
  verifyReceiptToken,
} from '../lib/promoter-receipt'
import { readReceiptViewWith } from '../lib/promoter-receipt-read'

const SECRET = 'test-secret-for-receipts'
const PAYLOAD = { shopId: 'shop-1', sku: 'negocio_anual' as const, promoterId: 'prm-1', amountCents: 200000, issuedAt: '2026-11-06T18:00:00.000Z' }

test.describe('the receipt token', () => {
  test('a signed token verifies back to its payload', () => {
    expect(verifyReceiptToken(signReceiptToken(PAYLOAD, SECRET), SECRET)).toEqual({ v: 1, typ: 'receipt', ...PAYLOAD })
  })

  test('a tampered body, a tampered signature, another secret or an extra segment is refused', () => {
    const token = signReceiptToken(PAYLOAD, SECRET)
    const [body, sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ v: 1, typ: 'receipt', ...PAYLOAD, amountCents: 1 })).toString('base64url')
    expect(verifyReceiptToken(`${forged}.${sig}`, SECRET)).toBeNull()
    expect(verifyReceiptToken(`${body}.${sig.slice(0, -2)}AA`, SECRET)).toBeNull()
    expect(verifyReceiptToken(token, 'another-secret')).toBeNull()
    expect(verifyReceiptToken(`${token}.x`, SECRET)).toBeNull()
    expect(verifyReceiptToken('', SECRET)).toBeNull()
  })

  test('the key is derived for receipts: a body signed with the raw claim secret never verifies', () => {
    const body = Buffer.from(JSON.stringify({ v: 1, typ: 'receipt', ...PAYLOAD })).toString('base64url')
    const rawSig = createHmac('sha256', SECRET).update(body).digest('base64url')
    expect(verifyReceiptToken(`${body}.${rawSig}`, SECRET)).toBeNull()
  })
})

test.describe('the status the merchant reads', () => {
  const NOW = new Date('2026-11-06T18:00:00.000Z')
  const base = { sku: 'negocio_anual' as const, attributionPaid: true, transferStatus: null as string | null, negocioEndsAt: '2027-11-06T00:00:00.000Z', now: NOW }

  test('our share paid: a running Negocio grant reads Activo with its end date; the free setup reads Listo', () => {
    expect(receiptStatus(base)).toEqual({ kind: 'active', endsAt: '2027-11-06T00:00:00.000Z' })
    expect(receiptStatus({ ...base, transferStatus: 'approved' })).toEqual({ kind: 'active', endsAt: '2027-11-06T00:00:00.000Z' })
    expect(receiptStatus({ ...base, negocioEndsAt: null })).toEqual({ kind: 'active', endsAt: null })
    expect(receiptStatus({ ...base, sku: 'setup_gratis', negocioEndsAt: null })).toEqual({ kind: 'ready' })
  })

  test('a grant that ran out reads «terminó», never «Activo hasta» a past date (pr-reviewer, #483)', () => {
    expect(receiptStatus({ ...base, negocioEndsAt: '2026-11-01T00:00:00.000Z' })).toEqual({ kind: 'ended', endsAt: '2026-11-01T00:00:00.000Z' })
    expect(receiptStatus({ ...base, negocioEndsAt: NOW.toISOString() })).toMatchObject({ kind: 'ended' })
  })

  test('a repeat sale still being confirmed reads Pendiente, even with an earlier paid sale (pr-reviewer, #483)', () => {
    expect(receiptStatus({ ...base, transferStatus: 'pending' })).toEqual({ kind: 'pending' })
    expect(receiptStatus({ ...base, transferStatus: 'reported' })).toEqual({ kind: 'pending' })
  })

  test('not paid: Pendiente, or a problem when the transfer was rejected', () => {
    for (const transferStatus of [null, 'pending', 'reported', 'approved']) {
      expect(receiptStatus({ ...base, attributionPaid: false, transferStatus })).toEqual({ kind: 'pending' })
    }
    expect(receiptStatus({ ...base, attributionPaid: false, transferStatus: 'rejected' })).toEqual({ kind: 'problem' })
  })
})

/** A fake supabase-js builder: records every filter, answers each table with the result given. */
function fakeDb(answers: Record<string, { data: unknown; error: unknown }>) {
  const calls: Record<string, string[]> = {}
  const db = {
    from(table: string) {
      const log = (calls[table] = [] as string[])
      const q = {
        select: (c: string) => (log.push(`select ${c}`), q),
        eq: (c: string, v: string) => (log.push(`eq ${c}=${v}`), q),
        is: (c: string, v: null) => (log.push(`is ${c}=${v}`), q),
        order: (c: string, o: { ascending: boolean }) => (log.push(`order ${c} ${o.ascending ? 'asc' : 'desc'}`), q),
        limit: (n: number) => (log.push(`limit ${n}`), q),
        maybeSingle: () => Promise.resolve(answers[table] ?? { data: null, error: null }),
      }
      return q
    },
  }
  return { db, calls }
}

test.describe('the receipt reads (injected database)', () => {
  const NOW = new Date('2026-11-06T18:00:00.000Z')
  const live = {
    marketplace_shops: { data: { name: 'Tacos Beto', metadata: {} }, error: null },
    marketplace_promoters: { data: { name: 'Ana', code: 'PRM-1' }, error: null },
    marketplace_promoter_attributions: { data: { status: 'paid' }, error: null },
    marketplace_promoter_transfers: { data: null, error: null },
  }

  test('the attribution and the latest transfer are read for THIS promoter, shop and package', async () => {
    const { db, calls } = fakeDb(live)
    await readReceiptViewWith(db, { v: 1, typ: 'receipt', ...PAYLOAD }, NOW)
    expect(calls.marketplace_promoter_attributions).toEqual([
      'select status', 'eq promoter_id=prm-1', 'eq seller_id=shop-1', 'eq sku=negocio_anual', 'is payment_ref=null',
    ])
    expect(calls.marketplace_promoter_transfers).toEqual([
      'select status', 'eq promoter_id=prm-1', 'eq seller_id=shop-1', 'eq sku=negocio_anual', 'order created_at desc', 'limit 1',
    ])
    // The promoter is read by id with NO track filter: a moved promoter's receipts keep working.
    expect(calls.marketplace_promoters).toEqual(['select name, code', 'eq id=prm-1'])
  })

  test('a failed read renders «unavailable», never «Pendiente» and never a 404', async () => {
    for (const table of Object.keys(live)) {
      const { db } = fakeDb({ ...live, [table]: { data: null, error: { message: 'timeout' } } })
      const view = await readReceiptViewWith(db, { v: 1, typ: 'receipt', ...PAYLOAD }, NOW)
      expect(view, table).not.toBeNull()
      expect(view!.status, table).toEqual({ kind: 'unavailable' })
    }
    const page = readFileSync('app/(shell)/recibo/[token]/page.tsx', 'utf8')
    expect(page).toContain(': t.statusUnavailable')
  })

  test('a shop or promoter confirmed gone is null (the page 404s)', async () => {
    for (const table of ['marketplace_shops', 'marketplace_promoters']) {
      const { db } = fakeDb({ ...live, [table]: { data: null, error: null } })
      expect(await readReceiptViewWith(db, { v: 1, typ: 'receipt', ...PAYLOAD }, NOW), table).toBeNull()
    }
  })
})

test('one amount format everywhere: $2,000 MXN, centavos only when there are some', () => {
  expect(formatReceiptAmount(200000)).toBe('$2,000 MXN')
  expect(formatReceiptAmount(25000)).toBe('$250 MXN')
  expect(formatReceiptAmount(149950)).toBe('$1,499.50 MXN')
  expect(formatReceiptAmount(100005)).toBe('$1,000.05 MXN')
  const approve = readFileSync('app/api/admin/promoter/transfers/[id]/approve/route.ts', 'utf8')
  expect(approve).toContain('amountMxn: formatReceiptAmount(transfer.gross_amount_cents)')
  expect(approve).toContain('owedMxn: formatReceiptAmount(transfer.owed_cents)')
  expect(readFileSync('lib/promoter-package-server.ts', 'utf8')).toContain('amountMxn: formatReceiptAmount(gross)')
})

test('the WhatsApp message is the locale template, to the owner’s number; no number, no link', () => {
  const url = receiptWhatsappUrl({
    whatsappE164: '+525512345678',
    template: es.promotorPanel.cobra.whatsappMessage,
    values: { dueno: 'Beto', promotor: 'Ana', codigo: 'PRM-1', monto: '$2,000 MXN', opcion: 'Plan Negocio · 1 año', negocio: 'Tacos Beto', enlace: 'https://miyagisanchez.com/recibo/x.y' },
  })
  expect(url).not.toBeNull()
  expect(url!.startsWith('https://wa.me/525512345678?text=')).toBe(true)
  const text = decodeURIComponent(url!.split('text=')[1])
  expect(text).toContain('Hola Beto')
  expect(text).toContain('$2,000 MXN')
  expect(text).toContain('https://miyagisanchez.com/recibo/x.y')
  expect(text).not.toMatch(/\{[a-z]+\}/)
  expect(receiptWhatsappUrl({ whatsappE164: null, template: 'x', values: {} })).toBeNull()
})

test('the route: only a shop the promoter may close, the amount from the package, the email in the same call', () => {
  const route = readFileSync('app/api/promoter/close/receipt/route.ts', 'utf8')
  // The exact guard, refusing with 403: a check that is only present (or short-circuited) would not stop anything.
  expect(route).toMatch(/\n  if \(!\(await promoterMayCloseShop\(\{ promoter: \{ \.\.\.promoter, clerk_user_id: user\.id \}, shop \}\)\)\) \{\n    return NextResponse\.json\([^\n]*\{ status: 403 \}\)/)
  expect(route.indexOf('promoterMayCloseShop(')).toBeLessThan(route.indexOf('signReceiptToken('))
  expect(route).toContain('const amountCents = packagePriceMxn(sku) * 100')
  expect(route).not.toMatch(/body\.amount/)
  expect(route).toContain('await sendPromoterReceipt(')
  expect(route).toContain('idempotencyKey: `promoter-receipt/${shop.id}/${sku}`')
})

test('the page: noindex, a bad token or a missing shop is a 404, and help reaches Miyagi Sánchez', () => {
  const page = readFileSync('app/(shell)/recibo/[token]/page.tsx', 'utf8')
  expect(page).toContain('robots: { index: false, follow: false }')
  expect(page).toContain('if (!payload) notFound()')
  expect(page).toContain('if (!view) notFound()')
  expect(page).toContain('contactMailto(')
  // It says who issued it: the promoter's record of a cash payment, with a way to dispute it (Codex security lens, #483).
  expect(page).toContain('fillTemplate(t.issuedBy, values)')
  expect(es.promotorPanel.recibo.issuedBy).toContain('escríbenos')
  expect(JSON.stringify(es.promotorPanel.recibo)).not.toMatch(/cerrar|cierre/i)
})
