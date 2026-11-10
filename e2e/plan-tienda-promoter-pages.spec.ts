/**
 * The promoter pages name the three packages (epic 08 · plan-tienda-three-free-months S4.4, README D11, D14):
 * «Cobra», the promoter page, the sell sheet, the receipt and /admin/promoter say «Cobras… Le pasas… Te quedas…» from
 * `packageSplit` and the live rates, say the three free months are on top, and never offer a retired package.
 * (The promoter page's own config is asserted in e2e/seller-acquisition-copy.spec.ts.)
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import es from '../locales/es.json' with { type: 'json' }
import en from '../locales/en.json' with { type: 'json' }
import { PACKAGE_FREE_MONTHS, SELLABLE_PACKAGE_SKUS } from '../lib/promoter-packages'
import { PROMOTER_SKUS } from '../lib/promoter-skus'

const read = (p: string) => readFileSync(p, 'utf8')

test('the money columns read as the promoter says it: Cobras · Le pasas · Te quedas', () => {
  for (const block of [es.promotorPanel.cobra, es.sellerAcquisition.promotor.guide]) {
    expect([block.colCharge, block.colPay, block.colKeep]).toEqual(['Cobras', 'Le pasas', 'Te quedas'])
  }
})

test('«Cobra» offers the packages on sale and says the free months are on top, from the constant', () => {
  const ui = read('app/(shell)/promotor/cerrar/CobraStep.tsx')
  expect(ui).toContain('fill(t.onTop, { resumen: PACKAGES[sku].summary, meses: String(PACKAGE_FREE_MONTHS) })')
  // The free-months line shows with or without a configured rate.
  const split = ui.slice(ui.indexOf('function SplitLine'))
  expect(split.match(/\{onTop\}/g)).toHaveLength(2)
  expect(es.promotorPanel.cobra.onTop).toContain('{meses} meses gratis van además del tiempo pagado')
  expect(PACKAGE_FREE_MONTHS).toBe(3)
})

test('the sell sheet: only the packages on sale, the free months on top, and every share from its live rate', () => {
  const sheet = read('app/(shell)/mx/vende/promotor/sell-sheet/page.tsx')
  expect(sheet).not.toMatch(/\bPACKAGE_SKUS\b/)
  expect(sheet.match(/SELLABLE_PACKAGE_SKUS\.map\(/g)).toHaveLength(2)
  for (const id of ['sell-sheet-on-top', 'sell-sheet-renewal', 'sell-sheet-tienda-renewal', 'sell-sheet-upgrade']) expect(sheet).toContain(`data-testid="${id}"`)
  expect(sheet).toContain('rates.tienda_renewal ?? 0')
  expect(sheet).toContain('rates.negocio_upgrade ?? 0')
  // One sentence to say out loud per package on sale — no more, no fewer — in both languages.
  for (const dict of [es, en]) expect(Object.keys(dict.sellerAcquisition.promotor.guide.say)).toEqual([...SELLABLE_PACKAGE_SKUS])
  for (const sku of SELLABLE_PACKAGE_SKUS) expect(es.sellerAcquisition.promotor.guide.say[sku]).toContain('3 meses de Plan Negocio gratis')
})

test('the receipt says Plan Tienda for a Tienda package, Plan Negocio otherwise', () => {
  const page = read('app/(shell)/recibo/[token]/page.tsx')
  expect(page).toContain("s.plan === 'tienda' ? t.activeTienda : t.active")
  expect(page).toContain("s.plan === 'tienda' ? t.endedTienda : t.ended")
  expect(es.promotorPanel.recibo.activeTienda).toContain('Plan Tienda')
  expect(es.promotorPanel.recibo.endedTienda).toContain('Plan Tienda')
})

test('/admin/promoter names every sku, marks the retired ones, and states each package on sale in one sentence', () => {
  const admin = read('app/(shell)/admin/promoter/PromoterAdminClient.tsx')
  expect(admin).toContain('`${PACKAGES.negocio_arranque.label} (ya no se vende)`')
  expect(admin).toContain('`${PACKAGES.setup_gratis.label} (ya no se vende)`')
  expect(admin).toContain('{isSellablePackageSku(sku) && rates[sku] ? (')
  expect(admin).toContain('{packageSentence(sku, rates[sku])}')
})

test("the promoter's commission page names every sku they can earn on", () => {
  const page = read('app/(shell)/promotor/[code]/page.tsx')
  const labels = page.slice(page.indexOf('const SKU_LABEL'), page.indexOf('}', page.indexOf('const SKU_LABEL')))
  for (const sku of PROMOTER_SKUS) expect(labels, sku).toContain(`${sku}:`)
})

test('the promoter copy no longer offers Plan Gratis, and names the shares after the sale', () => {
  const words = JSON.stringify(es.sellerAcquisition.promotor)
  expect(words).not.toContain('Plan Gratis')
  expect(es.sellerAcquisition.promotor.faqs[3].body).toContain('Plan Tienda · 1 año')
  expect(es.sellerAcquisition.promotor.faqs[4].body).toContain('pasa a Plan Negocio en su primer año')
  // The panel copy a promoter reads never says cerrar / cierre either (Daniel, 2026-11-05).
  for (const text of [es.promotorPanel.cobra.onTop, es.sellerAcquisition.promotor.guide.onTop, es.sellerAcquisition.promotor.guide.upgradeLine, es.sellerAcquisition.promotor.guide.tiendaRenewalLine]) {
    expect(text).not.toMatch(/cerrar|cierre|cierra/i)
  }
})
