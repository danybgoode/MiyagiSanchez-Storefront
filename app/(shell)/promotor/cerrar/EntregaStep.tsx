'use client'

import { useState } from 'react'
import { shopUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'
import type { Dictionary } from '@/lib/dictionary'
import PreviewStep from './PreviewStep'

/**
 * «4 · Entrégala» (promoter-panel S4.2, D12). The promoter shows the owner their shop and sends the claim link: one tap
 * and the shop is in the owner's name, the promoter's attribution kept. With private previews on, the shop is not
 * public yet, so «Ver su tienda» is the preview link (and the owner's approval) in `PreviewStep`; otherwise it is the
 * public page. Thin screen over /api/promoter/claim/link (+ /api/promoter/preview via PreviewStep).
 */
type Copy = Dictionary['promotorPanel']
type Shop = { shopId: string; slug: string; name: string }

export default function EntregaStep({ copy, shop, previewEnabled, relationshipId }: {
  copy: Copy
  shop: Shop
  previewEnabled: boolean
  relationshipId: string | null
}) {
  const t = copy.entrega
  const [link, setLink] = useState<{ whatsapp: string; claim: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  async function generate() {
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/promoter/claim/link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId: shop.shopId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) { setError(data.error ?? copy.errors.network); return }
      setLink({ whatsapp: data.whatsappLink, claim: data.claimUrl })
    } catch { setError(copy.errors.network) }
    finally { setBusy(false) }
  }

  async function copyLink() {
    if (!link) return
    try { await navigator.clipboard.writeText(link.claim); setCopied(true) } catch { /* the WhatsApp button still works */ }
  }

  return (
    <section id="panel-entrega" className="card-panel grid gap-4" style={{ padding: 'var(--s-5)' }} data-testid="panel-entrega">
      <div>
        <h2 className="t-h4" style={{ margin: 0, letterSpacing: 0 }}>4 · {copy.steps.entrega}</h2>
        <p className="t-small" style={{ margin: 'var(--s-1) 0 0', color: 'var(--fg-muted)' }}>{t.lead}</p>
      </div>

      {/* With previews on, the owner reviews and approves first; the claim link comes after (the old order). */}
      {previewEnabled ? <PreviewStep shop={shop} relationshipId={relationshipId} panelCopy={copy} /> : null}

      {previewEnabled ? null : (
        <a className="btn btn-secondary" style={{ justifySelf: 'start' }} href={shopUrlFor(SITE_ORIGIN, shop.slug)} target="_blank" rel="noreferrer">{t.see}</a>
      )}

      {link ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-2">
            <a className="btn btn-primary" href={link.whatsapp} target="_blank" rel="noreferrer" data-testid="panel-send-claim">{t.sendLink}</a>
            <button type="button" className="btn btn-secondary" onClick={copyLink}>{copied ? t.copied : t.copyLink}</button>
          </div>
          <p className="t-small" role="status" style={{ margin: 0, color: 'var(--fg-muted)' }}>{t.done}</p>
        </div>
      ) : (
        <button type="button" className="btn btn-primary" style={{ justifySelf: 'start' }} onClick={generate} disabled={busy} data-testid="panel-claim-link">
          {busy ? t.generating : t.sendLink}
        </button>
      )}
      {error ? <p className="text-sm" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p> : null}
    </section>
  )
}
