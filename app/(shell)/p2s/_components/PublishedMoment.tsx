'use client'

import { useState } from 'react'
import { SuccessCard } from '@/components/SuccessCard'
import { PUBLISH_COPY } from '@/lib/prompt-to-shop/copy'
import { patchShop } from '@/lib/prompt-to-shop/client'
import type { OwnProductCardView } from '@/lib/prompt-to-shop/view'
import { shopShortLink } from '@/lib/shortlink'

/**
 * The moment after «Publicar» (epic prompt-to-shop S5.2): the shop as the marketplace shows it, then the shares.
 *
 * The tiles use the marketplace browse grid's own tile (`card-tile`: photo, name, price, shop line). There is no
 * shared marketplace card COMPONENT to reuse — the browse and home grids draw their tiles inline — so this draws the
 * same tile with the same class rather than extracting a buyer page's markup inside a merchant story.
 *
 * Shares: `SuccessCard` (the shared "done" screen) brings WhatsApp through `lib/share-link.ts` and the native share
 * sheet; under it, the story image (`/api/sell/shop/story-image`), the QR code (`/api/sell/shop/qr`) and the short
 * link (`mschz.org/<slug>`). Every share marks the checklist's `comparte` step, the seam Comparte uses.
 */
export default function PublishedMoment({
  shopName,
  shopSlug,
  publicPath,
  cards,
  onShared,
}: {
  shopName: string
  shopSlug: string
  publicPath: string
  /** The shop's PUBLISHED products. */
  cards: OwnProductCardView[]
  onShared?: () => void
}) {
  const shortLink = shopShortLink(shopSlug)
  const [copied, setCopied] = useState<'idle' | 'copied' | 'manual'>('idle')

  function shared() {
    void patchShop({ settings: { guide: { share_done: true } } }).then((r) => {
      if (r.ok) onShared?.()
    })
  }

  async function copyShort() {
    try {
      await navigator.clipboard.writeText(shortLink)
      setCopied('copied')
    } catch {
      setCopied('manual')
    }
    shared()
  }

  return (
    <section className="grid gap-4" aria-labelledby="p2s-published-title" data-testid="p2s-published">
      <div className="grid gap-1">
        <h2 id="p2s-published-title" className="t-h3" style={{ margin: 0, letterSpacing: 0 }}>{PUBLISH_COPY.publishedTitle}</h2>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{PUBLISH_COPY.publishedLead}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3" data-testid="p2s-market-tiles">
        {cards.slice(0, 6).map((card) => (
          <a key={card.id} href={publicPath} className="card-tile no-underline block">
            {card.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- the merchant's own uploaded photo, as browse shows it
              <img src={card.imageUrl} alt={card.title} className="w-full h-40 object-cover" />
            ) : (
              <div className="w-full h-40 flex items-center justify-center" style={{ background: 'var(--bg-sunk)' }}>
                <i className="iconoir-shop" style={{ fontSize: 40, color: 'var(--fg-subtle)' }} aria-hidden="true" />
              </div>
            )}
            <div className="p-3">
              <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)', lineHeight: 1.35, marginBottom: 4 }}>{card.title}</p>
              <p className="t-price" style={{ fontSize: 'var(--t-base)' }}>{card.priceLabel ?? PUBLISH_COPY.noPrice}</p>
              <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 6 }}>{shopName}</p>
            </div>
          </a>
        ))}
      </div>

      <SuccessCard
        headline={PUBLISH_COPY.shareTitle}
        subcopy={shortLink.replace(/^https?:\/\//, '')}
        liveUrl={publicPath}
        liveLabel={PUBLISH_COPY.seeInMarket}
        nextActions={[]}
        shareUrl={shortLink}
        shareTitle={PUBLISH_COPY.shareText(shopName)}
      />

      <div className="flex flex-wrap gap-2 justify-center" data-testid="p2s-shares">
        <a href="/api/sell/shop/story-image" download="mi-tienda-historia.png" onClick={shared} className="btn btn-secondary" data-testid="p2s-share-story">
          <i className="iconoir-instagram" aria-hidden="true" /> {PUBLISH_COPY.story}
        </a>
        <a href="/api/sell/shop/qr" download={`${shopSlug}-qr.png`} onClick={shared} className="btn btn-secondary" data-testid="p2s-share-qr">
          <i className="iconoir-qr-code" aria-hidden="true" /> {PUBLISH_COPY.qr}
        </a>
        <button type="button" onClick={copyShort} className="btn btn-secondary" data-testid="p2s-share-short">
          <i className="iconoir-link" aria-hidden="true" /> {PUBLISH_COPY.shortLink}
        </button>
      </div>
      <p className="t-small" style={{ margin: 0, textAlign: 'center' }} role="status" aria-live="polite">{copied === 'copied' ? PUBLISH_COPY.copied : null}</p>
      {copied === 'manual' ? (
        <label className="t-small grid gap-1">
          {PUBLISH_COPY.copyManual}
          <input className="input" readOnly value={shortLink} onFocus={(e) => e.currentTarget.select()} />
        </label>
      ) : null}
    </section>
  )
}
