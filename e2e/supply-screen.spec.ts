import { expect, test } from '@playwright/test'
import { prohibitedItemIds } from '../lib/supply-screen'
import type { ScreenVerdict } from '../lib/prompt-to-shop/screen'

// Follow-up of one-front-door-both-markets: the connector imports (Shopify, Mercado Libre, promoter, admin supply)
// screen prohibited goods before any create — in chunks, re-screening only a refused chunk item by item.

const items = Array.from({ length: 40 }, (_, i) => ({ id: `it_${i}`, listing_title: `Vela aromática ${i}`, listing_description: i === 23 ? 'Réplica AAA de bolsa Louis Vuitton' : 'Cera de soya' }))
const screenFor = (calls: string[]) => async (text: string): Promise<ScreenVerdict> => {
  calls.push(text)
  return text.includes('Réplica') ? { verdict: 'refuse', kind: 'prohibited' } : { verdict: 'allow' }
}

test('only the prohibited item is flagged, and only its chunk is re-screened item by item', async () => {
  const calls: string[] = []
  const ids = await prohibitedItemIds(items, screenFor(calls))
  expect([...ids]).toEqual(['it_23'])
  expect(calls).toHaveLength(3 + 15) // three chunks, then the 15 items of the refused chunk
})

test('a screen that throws or cannot look lets items through (D4), never blocks a whole import', async () => {
  expect((await prohibitedItemIds(items, async () => { throw new Error('down') })).size).toBe(0)
  expect((await prohibitedItemIds(items, async () => ({ verdict: 'unavailable', reason: 'no_key' }))).size).toBe(0)
})

test('the import loop refuses a flagged item before any create', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync('lib/supply-import.ts', 'utf8')
  const loop = src.slice(src.indexOf('export async function importApprovedItems'))
  expect(loop.indexOf('prohibitedItemIds(')).toBeLessThan(loop.indexOf('internalFetch('))
  expect(loop).toContain('if (prohibited.has(item.id)) throw new Error(PROHIBITED_IMPORT_MESSAGE)')
})
