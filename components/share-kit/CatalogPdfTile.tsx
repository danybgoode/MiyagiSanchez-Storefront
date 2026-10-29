'use client'

import { useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { buildWhatsAppShareLink } from '@/lib/share-link'
import { pushAnalyticsEvent } from '@/lib/analytics-events'
import { SHARE_KIT_COPY as COPY } from '@/lib/share-kit/copy'
import { CATALOG_PDF_ERROR } from '@/lib/share-kit/catalog-pdf-copy'

/**
 * The «Catálogo PDF» tile (share-kit S2.3, D17), in Comparte and the prompt-to-shop publish moment.
 *
 * «Descargar» fetches the merchant's own PDF (`/api/sell/catalogo/pdf`, session-scoped) and saves it, saying
 * «Preparando tu PDF…» while a render runs and the one error line if it fails. «Compartir por WhatsApp» sends the
 * PUBLIC link, so whoever receives it downloads the current catalog. `share_catalog_pdf` fires once per tap.
 */
export default function CatalogPdfTile({
  shopName,
  pdfUrl,
  onShared,
}: {
  shopName: string
  /** The public, shareable PDF link (`buildCatalogModel().links.pdf`). */
  pdfUrl: string
  onShared?: (channel: string) => void
}) {
  const [state, setState] = useState<'idle' | 'preparing' | 'error'>('idle')

  function tap(channel: string) {
    pushAnalyticsEvent('share_catalog_pdf', { channel })
    onShared?.(channel)
  }

  async function download() {
    tap('download')
    setState('preparing')
    try {
      const res = await fetch('/api/sell/catalogo/pdf')
      if (!res.ok) throw new Error(String(res.status))
      const blob = await res.blob()
      const filename = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'catalogo.pdf'
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = filename
      a.click()
      setTimeout(() => URL.revokeObjectURL(href), 10_000)
      setState('idle')
    } catch {
      setState('error')
    }
  }

  return (
    <Card variant="panel" className="p-5" data-testid="share-catalog-pdf-tile">
      <h3 className="font-semibold flex items-center gap-2">
        <i className="iconoir-page" aria-hidden="true" /> {COPY.pdfTitle}
      </h3>
      <p className="text-sm text-[var(--color-muted)] mt-1">{COPY.pdfLead}</p>
      <div className="flex flex-wrap gap-2 mt-4">
        <Button type="button" variant="secondary" onClick={download} loading={state === 'preparing'} data-testid="share-catalog-pdf-download">
          <i className="iconoir-download" aria-hidden="true" /> {state === 'preparing' ? COPY.pdfPreparing : COPY.pdfDownload}
        </Button>
        <a
          href={buildWhatsAppShareLink(COPY.pdfShareText(shopName), pdfUrl)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => tap('whatsapp')}
          className="btn"
          style={{ background: 'var(--provider-whatsapp)', color: 'var(--fg-inverse)' }}
          data-testid="share-catalog-pdf-whatsapp"
        >
          <i className="iconoir-chat-bubble" aria-hidden="true" /> {COPY.whatsapp}
        </a>
      </div>
      <p className="text-sm mt-3" role="status" aria-live="polite" style={{ color: 'var(--color-danger, inherit)' }}>
        {state === 'error' ? CATALOG_PDF_ERROR : null}
      </p>
    </Card>
  )
}
