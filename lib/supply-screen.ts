/** Pure: the prohibited-goods screen for the supply/connector import loop (`lib/supply-import.ts`). */

import type { ScreenVerdict } from './prompt-to-shop/screen'

type ScreenableItem = { id: string; listing_title: string | null; listing_description: string | null }

export const PROHIBITED_IMPORT_MESSAGE = 'Producto no permitido: los pagos en línea no aceptan este tipo de producto.'
const SCREEN_CHUNK = 15

function itemText(item: Pick<ScreenableItem, 'listing_title' | 'listing_description'>): string {
  // Bounded per item so a full chunk always fits the screen's state (15 × (150 + 3 + 300) + header < 7,000): a padded
  // title must not push a later item past the window the screen reads (Codex security, PR #502).
  return `${String(item.listing_title ?? '').slice(0, 150)}${item.listing_description ? ` — ${String(item.listing_description).slice(0, 300)}` : ''}`
}

/**
 * Which items are prohibited goods (one-front-door-both-markets follow-up, 2026-11-13): the connector imports —
 * Shopify, Mercado Libre, a promoter's Shopify pull, the admin supply console — all create products through this
 * loop, so the screen sits here, before any create. Chunks of 15 keep a 2,000-item pull to ~140 calls; only a REFUSED
 * chunk is re-screened item by item to find the offender. `unavailable` lets the item through, as every import path
 * does when the screen cannot look (D4).
 */
export const SUPPLY_SCREEN_CHUNK_TEXT = (items: ScreenableItem[]) => `Productos para importar a una tienda en línea:\n${items.map(itemText).join('\n')}`

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
    if (!(await refused(SUPPLY_SCREEN_CHUNK_TEXT(chunk)))) continue
    for (const item of chunk) if (await refused(itemText(item))) out.add(item.id)
  }
  return out
}
