/** Pure: the prohibited-goods screen for the supply/connector import loop (`lib/supply-import.ts`). */

import type { ScreenVerdict } from './prompt-to-shop/screen'

type ScreenableItem = { id: string; listing_title: string | null; listing_description: string | null }

export const PROHIBITED_IMPORT_MESSAGE = 'Producto no permitido: los pagos en línea no aceptan este tipo de producto.'
const SCREEN_CHUNK = 15

function itemText(item: Pick<ScreenableItem, 'listing_title' | 'listing_description'>): string {
  return `${item.listing_title ?? ''}${item.listing_description ? ` — ${String(item.listing_description).slice(0, 300)}` : ''}`
}

/**
 * Which items are prohibited goods (one-front-door-both-markets follow-up, 2026-11-13): the connector imports —
 * Shopify, Mercado Libre, a promoter's Shopify pull, the admin supply console — all create products through this
 * loop, so the screen sits here, before any create. Chunks of 15 keep a 2,000-item pull to ~140 calls; only a REFUSED
 * chunk is re-screened item by item to find the offender. `unavailable` lets the item through, as every import path
 * does when the screen cannot look (D4).
 */
export async function prohibitedItemIds(
  items: ScreenableItem[],
  screen: (text: string) => Promise<ScreenVerdict>,
): Promise<Set<string>> {
  const out = new Set<string>()
  const refused = async (text: string) => {
    const v = await screen(text).catch((): ScreenVerdict => ({ verdict: 'unavailable', reason: 'threw' }))
    return v.verdict === 'refuse' && v.kind === 'prohibited'
  }
  for (let i = 0; i < items.length; i += SCREEN_CHUNK) {
    const chunk = items.slice(i, i + SCREEN_CHUNK)
    if (!(await refused(`Productos para importar a una tienda en línea:\n${chunk.map(itemText).join('\n')}`))) continue
    for (const item of chunk) if (await refused(itemText(item))) out.add(item.id)
  }
  return out
}
