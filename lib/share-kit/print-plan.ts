/**
 * How the catalog PDF lays out (share-kit S2.2, D15) — pure, so the page split is spec-checked without a browser.
 *
 * A4 portrait, a cover, then sheets of six products (2 × 3), then a closing sheet with the shop's link and WhatsApp.
 * Fixed sheets rather than CSS fragmentation: Chromium's print engine splits a grid row across pages unpredictably,
 * and a product card cut in half is unusable in a forwarded PDF.
 */

export const PRODUCTS_PER_SHEET = 6

export function chunkIntoSheets<T>(items: T[], perSheet = PRODUCTS_PER_SHEET): T[][] {
  const sheets: T[][] = []
  for (let i = 0; i < items.length; i += perSheet) sheets.push(items.slice(i, i + perSheet))
  return sheets
}
