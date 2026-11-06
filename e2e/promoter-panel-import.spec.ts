/**
 * Promoter imports (promoter-panel D2–D4): Shopify into the shop the promoter opened, and export files from Tiendanube
 * and WooCommerce, capped at 150 (the rest is the paid migration, or the merchant's own free import after the claim).
 *
 * The header fixtures are the platforms' real columns, read 2026-11-05:
 * - WooCommerce: the documented CSV schema (github.com/woocommerce/woocommerce/wiki/Product-CSV-Import-Schema).
 * - Tiendanube: productos.csv (ayuda.tiendanube.com, «¿Cómo completar el Excel de carga masiva de productos?»).
 * Big Cartel publishes no product export, so its merchants type their products (stepTwoPath).
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { detectCsvDelimiter, normalizeHeaderKey, parseCatalogRecords, parseCsvRows, validateRows } from '../lib/catalog-import'
import { PROMOTER_IMPORT_CAP, importCapPlan, stepTwoPath, SELLS_TODAY } from '../lib/promoter-panel'
import { prepareImportRecords, stripHtml } from '../lib/promoter-file-import'

const WOO_HEADER =
  'ID,Type,SKU,Name,Published,Is featured?,Visibility in catalog,Short description,Description,Date sale price starts,' +
  'Date sale price ends,Tax status,Tax class,In stock?,Stock,Low stock amount,Backorders allowed?,Sold individually?,' +
  'Weight (kg),Length (cm),Width (cm),Height (cm),Allow customer reviews?,Purchase note,Sale price,Regular price,' +
  'Categories,Tags,Shipping class,Images'
/** A WooCommerce row built by column name, so the fixture can't drift from the header by a miscounted comma. */
function wooRow(values: Record<string, string>): string {
  return WOO_HEADER.split(',').map((h) => {
    const v = values[h] ?? ''
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  }).join(',')
}

test('the 150 rule: up to 150 are part of opening the shop, the rest is reported', () => {
  expect(PROMOTER_IMPORT_CAP).toBe(150)
  expect(importCapPlan(0)).toEqual({ take: 0, overCap: 0 })
  expect(importCapPlan(42)).toEqual({ take: 42, overCap: 0 })
  expect(importCapPlan(150)).toEqual({ take: 150, overCap: 0 })
  expect(importCapPlan(320)).toEqual({ take: 150, overCap: 170 })
  expect(importCapPlan(Number.NaN)).toEqual({ take: 0, overCap: 0 })
})

test('step 2 follows where the merchant sells: Shopify, an export file, Mercado Libre later, or cards', () => {
  expect(stepTwoPath('shopify')).toBe('shopify')
  expect(stepTwoPath('tiendanube')).toBe('file')
  expect(stepTwoPath('woocommerce')).toBe('file')
  // Big Cartel has no product export.
  expect(stepTwoPath('bigcartel')).toBe('cards')
  expect(stepTwoPath('mercadolibre')).toBe('mercadolibre')
  for (const v of ['none', 'social', 'other', undefined, 'anything']) expect(stepTwoPath(v)).toBe('cards')
  expect(SELLS_TODAY).toContain('bigcartel')
})

test('headers are normalised: accents, spaces and punctuation; units stay distinct', () => {
  expect(normalizeHeaderKey('Regular price')).toBe('regular_price')
  expect(normalizeHeaderKey('Categorías')).toBe('categorias')
  expect(normalizeHeaderKey('In stock?')).toBe('in_stock')
  expect(normalizeHeaderKey('Peso (kg)')).toBe('peso_kg')
  expect(normalizeHeaderKey('  Descripción  ')).toBe('descripcion')
})

test('a quoted cell keeps its line breaks and delimiters, and the delimiter is detected', () => {
  expect(detectCsvDelimiter('Nombre;Precio;Stock')).toBe(';')
  expect(detectCsvDelimiter('Name,Regular price,Stock')).toBe(',')
  const rows = parseCsvRows('Name,Description\n"Taza","Línea 1\nLínea 2, con coma"\n"Plato ""grande""",x\n', ',')
  expect(rows).toEqual([['Name', 'Description'], ['Taza', 'Línea 1\nLínea 2, con coma'], ['Plato "grande"', 'x']])
})

test('a WooCommerce export: one product per parent, variations dropped, HTML stripped, category from the shop', () => {
  const csv = [
    WOO_HEADER,
    wooRow({ ID: '101', Type: 'variable', SKU: 'TAZ-1', Name: 'Taza de barro', Description: '<p>Hecha a mano.</p>\n<p>Apta para café.</p>', Stock: '12', 'Regular price': '180', Categories: 'Cocina > Tazas', Images: 'https://example.com/a.jpg, https://example.com/b.jpg' }),
    wooRow({ ID: '102', Type: 'variation', SKU: 'TAZ-1-R', Name: 'Taza de barro - Roja', Stock: '4', 'Regular price': '180' }),
  ].join('\n')
  const read = parseCatalogRecords(csv, 'productos.csv')
  expect(read.fileErrors).toEqual([])
  const staged = validateRows(prepareImportRecords(read.records, 'hogar'))
  expect(staged).toHaveLength(1)
  const [only] = staged
  expect(only.valid).toBe(true)
  expect(only.row.title).toBe('Taza de barro')
  expect(only.row.price).toBe(180)
  expect(only.row.quantity).toBe(12)
  expect(only.row.category).toBe('hogar')
  expect(only.row.description).toBe('Hecha a mano.\n\nApta para café.')
  expect(only.row.images).toEqual(['https://example.com/a.jpg', 'https://example.com/b.jpg'])
})

test('a Tiendanube export (semicolons, accented headers): name, price, stock and description map; variants collapse', () => {
  const csv = [
    'Identificador de URL;Nombre;Categorías;Nombre de propiedad 1;Valor de propiedad 1;Precio;Precio promocional;Stock;SKU;Descripción',
    'tamales-rajas;Tamales de rajas;Comida;Tamaño;Docena;180;;20;TAM-1;<b>Docena</b> de tamales',
    'tamales-rajas;Tamales de rajas;Comida;Tamaño;Media;95;;10;TAM-2;',
  ].join('\n')
  const read = parseCatalogRecords(csv, 'productos.csv')
  const staged = validateRows(prepareImportRecords(read.records, 'otros'))
  expect(staged).toHaveLength(1)
  expect(staged[0].valid).toBe(true)
  expect(staged[0].row).toMatchObject({ title: 'Tamales de rajas', price: 180, quantity: 20, description: 'Docena de tamales', category: 'otros' })
})

test('a WooCommerce export from a Spanish site uses the translated columns', () => {
  const csv = 'Nombre,Precio normal,Inventario,Categorías,Imágenes\nVela de soya,250,5,Hogar,https://example.com/v.jpg'
  const staged = validateRows(prepareImportRecords(parseCatalogRecords(csv, 'productos.csv').records, 'hogar'))
  expect(staged[0].row).toMatchObject({ title: 'Vela de soya', price: 250, quantity: 5, images: ['https://example.com/v.jpg'] })
})

test('with no default category, a platform category is never guessed: the row is rejected', () => {
  const staged = validateRows(prepareImportRecords([{ title: 'Taza de barro', category: 'Cocina > Tazas', price: '180' }], null))
  expect(staged[0].valid).toBe(false)
})

test('stripHtml keeps paragraphs as line breaks and decodes entities', () => {
  expect(stripHtml('<p>Uno &amp; dos</p><p>Tres&nbsp;cuatro</p>')).toBe('Uno & dos\nTres cuatro')
})

test('the import routes run the shared preamble (flags, promoter, rate limit, ownership guard) before any work', () => {
  const pre = readFileSync('lib/promoter-import-server.ts', 'utf8')
  for (const step of ["isEnabled('promoter.enabled')", "checkRateLimit('supply_import'", 'promoterShopEditAccess(', 'shopEditRefusal(']) expect(pre).toContain(step)
  for (const [route, work] of [
    ['app/api/promoter/import/shopify/preview/route.ts', 'stageShopifyBatch('],
    ['app/api/promoter/import/shopify/route.ts', 'importApprovedItems('],
    ['app/api/promoter/import/file/route.ts', 'createPromoterProduct('],
  ] as const) {
    const src = readFileSync(route, 'utf8')
    expect(src.indexOf('promoterImportPreamble(')).toBeGreaterThan(-1)
    expect(src.indexOf('promoterImportPreamble(')).toBeLessThan(src.indexOf(work))
    expect(src).toContain('importCapPlan(')
  }
  // A Shopify batch staged for another shop is refused.
  expect(readFileSync('app/api/promoter/import/shopify/route.ts', 'utf8')).toContain("settings.connected_shop_id !== shop.id")
})

test('imported images are fetched through the DNS-pinned fetch, redirects re-checked hop by hop', () => {
  const src = readFileSync('lib/image-ingest.ts', 'utf8')
  expect(src).toContain("pinnedFetch(target, { signal: controller.signal, redirect: 'manual' })")
  expect(src).not.toMatch(/fetch\(url, \{[^}]*redirect: 'follow'/)
  expect(src).toContain('if (!isSafePublicUrl(target.href)) return null')
})
