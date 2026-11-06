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
  test('our share paid: Negocio packages read Activo (with the end date), the free setup reads Listo', () => {
    expect(receiptStatus({ sku: 'negocio_anual', attributionPaid: true, transferStatus: 'approved', negocioEndsAt: '2027-11-06T00:00:00.000Z' }))
      .toEqual({ kind: 'active', endsAt: '2027-11-06T00:00:00.000Z' })
    expect(receiptStatus({ sku: 'negocio_arranque', attributionPaid: true, transferStatus: null, negocioEndsAt: null })).toEqual({ kind: 'active', endsAt: null })
    expect(receiptStatus({ sku: 'setup_gratis', attributionPaid: true, transferStatus: null, negocioEndsAt: null })).toEqual({ kind: 'ready' })
  })

  test('not paid yet: Pendiente, whatever the transfer says, unless it was rejected', () => {
    for (const transferStatus of [null, 'pending', 'reported', 'approved']) {
      expect(receiptStatus({ sku: 'negocio_anual', attributionPaid: false, transferStatus, negocioEndsAt: null })).toEqual({ kind: 'pending' })
    }
    expect(receiptStatus({ sku: 'negocio_anual', attributionPaid: false, transferStatus: 'rejected', negocioEndsAt: null })).toEqual({ kind: 'problem' })
  })

  test('a failed read is «unavailable», never «Pendiente» (three states, never two)', () => {
    const server = readFileSync('lib/promoter-receipt-server.ts', 'utf8')
    expect(server).toContain("if (attribution.error || transfer.error) return { ...base, status: { kind: 'unavailable' } }")
    const page = readFileSync('app/(shell)/recibo/[token]/page.tsx', 'utf8')
    expect(page).toContain(': t.statusUnavailable')
    expect(es.promotorPanel.recibo.statusUnavailable).toBeTruthy()
  })
})

test('one amount format everywhere: $2,000 MXN, also in the transfer-approved and card emails', () => {
  expect(formatReceiptAmount(200000)).toBe('$2,000 MXN')
  expect(formatReceiptAmount(25000)).toBe('$250 MXN')
  expect(readFileSync('app/api/admin/promoter/transfers/[id]/approve/route.ts', 'utf8')).toContain('amountMxn: formatReceiptAmount(transfer.gross_amount_cents)')
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
  expect(route).toContain('const amountCents = PACKAGES[sku].priceMxn * 100')
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
  expect(JSON.stringify(es.promotorPanel.recibo)).not.toMatch(/cerrar|cierre/i)
})
