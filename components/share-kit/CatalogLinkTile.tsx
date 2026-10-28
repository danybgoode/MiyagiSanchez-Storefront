'use client'

import { useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { buildWhatsAppShareLink } from '@/lib/share-link'
import { pushAnalyticsEvent } from '@/lib/analytics-events'
import { SHARE_KIT_COPY as COPY } from '@/lib/share-kit/copy'

/**
 * The «Catálogo» tile (share-kit S1.3, D11): the shop's catalog link to copy, send by WhatsApp or print as a QR.
 *
 * Shared by Comparte and the prompt-to-shop publish moment, so the two cannot drift. Every tap fires
 * `share_catalog_link` once (no dedupe key — it counts taps, not merchants) and calls `onShared`, which each host
 * points at its own `guide.share_done` write.
 */
export default function CatalogLinkTile({
  shopName,
  catalogUrl,
  onShared,
  onCopyResult,
}: {
  shopName: string
  /** The catalog page on the platform origin (`buildCatalogModel().links.catalog`). */
  catalogUrl: string
  onShared?: (channel: string) => void
  /** Lets the host show its own toast; without it the button label alone says it worked. */
  onCopyResult?: (ok: boolean) => void
}) {
  const [copied, setCopied] = useState(false)

  function tap(channel: string) {
    pushAnalyticsEvent('share_catalog_link', { channel })
    onShared?.(channel)
  }

  async function copy() {
    tap('copy_link')
    try {
      await navigator.clipboard.writeText(catalogUrl)
      setCopied(true)
      onCopyResult?.(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      onCopyResult?.(false)
    }
  }

  return (
    <Card variant="panel" className="p-5" data-testid="share-catalog-tile">
      <h3 className="font-semibold flex items-center gap-2">
        <i className="iconoir-page" aria-hidden="true" /> {COPY.catalogTitle}
      </h3>
      <p className="text-sm text-[var(--color-muted)] mt-1">{COPY.catalogLead}</p>
      <a
        href={catalogUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block mt-3 text-xs font-mono bg-[var(--color-surface-alt)] border border-[var(--color-border)] rounded-[var(--r-pill)] px-3 py-1 break-all"
      >
        {catalogUrl.replace(/^https?:\/\//, '')}
      </a>
      <div className="flex flex-wrap gap-2 mt-4">
        <a
          href={buildWhatsAppShareLink(COPY.shareText(shopName), catalogUrl)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => tap('whatsapp')}
          className="btn"
          style={{ background: 'var(--provider-whatsapp)', color: 'var(--fg-inverse)' }}
          data-testid="share-catalog-whatsapp"
        >
          <i className="iconoir-chat-bubble" aria-hidden="true" /> {COPY.whatsapp}
        </a>
        <Button type="button" onClick={copy} data-testid="share-catalog-copy">
          {copied ? <><i className="iconoir-check" aria-hidden="true" /> {COPY.copied}</> : <><i className="iconoir-copy" aria-hidden="true" /> {COPY.copy}</>}
        </Button>
        <a
          href="/api/sell/shop/qr?target=catalogo"
          download
          onClick={() => tap('qr')}
          className="btn btn-secondary"
          data-testid="share-catalog-qr"
        >
          <i className="iconoir-qr-code" aria-hidden="true" /> {COPY.qr}
        </a>
      </div>
    </Card>
  )
}
