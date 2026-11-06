/**
 * «2 · Sus productos» (promoter-panel S3.1/S3.2, D7/D8/D9): manual-first product cards with the camera first, and the
 * import that matches where the merchant already sells.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import es from '../locales/es.json' with { type: 'json' }

const STEP = readFileSync('app/(shell)/promotor/cerrar/ProductosStep.tsx', 'utf8')

test('step 2 opens the import that matches where they sell, with typed cards always below', () => {
  expect(STEP).toContain("path === 'shopify' ? <ShopifyImport")
  expect(STEP).toContain("path === 'file' && sellsToday ? <FileImport")
  expect(STEP).toContain("path === 'mercadolibre' ? <p")
  // The cards render on every path.
  expect(STEP).toMatch(/\n\s+<ProductCard copy=\{copy\}/)
})

test('the camera is the first control: a visible button over a capture input; a gallery button beside it', () => {
  const card = STEP.slice(STEP.indexOf('function ProductCard('))
  const camera = card.indexOf('capture="environment"')
  expect(camera).toBeGreaterThan(-1)
  // The input sits inside a .btn label, so it is a real, visible button (Daniel: the old picker was nearly invisible).
  expect(card.lastIndexOf('<label className="btn btn-primary btn-lg"', camera)).toBeGreaterThan(-1)
  expect(card.indexOf('capture="environment"')).toBeLessThan(card.indexOf('{t.name}'))
})

test('no origin fields and no image-URL box: a typed product sends neither (D7/D8)', () => {
  expect(STEP).not.toContain('source_url')
  expect(STEP).not.toContain('source_platform')
  expect(STEP).not.toMatch(/URL de imagen|photoUrl/)
})

test('the imports call their routes: Shopify preview then confirm with the batch, a file with its platform', () => {
  const shopify = STEP.indexOf("fetch('/api/promoter/import/shopify/preview'")
  const confirm = STEP.indexOf("fetch('/api/promoter/import/shopify',")
  expect(shopify).toBeGreaterThan(-1)
  expect(confirm).toBeGreaterThan(shopify)
  expect(STEP).toContain('batchId: preview.batchId')
  expect(STEP).toContain("fetch('/api/promoter/import/file'")
  expect(STEP).toContain('fileText, fileName: file.name, platform')
})

test('the step copy names the 150 rule and the paid migration, and has no «cerrar»', () => {
  const p = es.promotorPanel.productos
  expect(p.overCap).toContain('150')
  expect(p.overCap).toContain('Migración con consultor')
  expect(JSON.stringify(p)).not.toMatch(/cerrar|cierre/i)
  // Every visible string in the step comes from the copy block.
  expect(STEP).not.toMatch(/>\s*[A-ZÁÉÍÓÚ¿][a-záéíóúñ]+ [a-záéíóúñ]+[^<{]*</)
})
