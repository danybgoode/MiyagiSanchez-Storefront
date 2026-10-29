'use client'

import { useEffect } from 'react'
import { pushAnalyticsEvent } from '@/lib/analytics-events'
import { catalogOrderEvent } from '@/lib/share-kit/catalog'

/**
 * The catalog page's one client island (share-kit D19): a single delegated listener that fires `catalog_order_whatsapp`
 * or `catalog_order_buy` once per order tap. The buttons stay plain server-rendered links, so the page still works
 * with no JS and the island adds a few hundred bytes, not a component per product. `pushAnalyticsEvent` skips
 * white-label hosts, so taps on a shop's own domain are not counted (named and accepted in the lock).
 */
export default function CatalogOrderTracker({ shopSlug }: { shopSlug: string }) {
  useEffect(() => {
    function onClick(event: MouseEvent) {
      const button = (event.target as Element | null)?.closest?.('[data-testid="catalogo-order"]')
      const name = catalogOrderEvent(button?.getAttribute('data-order'))
      if (name) pushAnalyticsEvent(name, { shop_slug: shopSlug, product_id: button?.getAttribute('data-product') ?? null })
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [shopSlug])
  return null
}
