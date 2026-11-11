import type { RealShopProof } from '@/lib/business-types'

/**
 * The «real shops» proof slot on a business-type page (own-shop-positioning S3.1).
 *
 * It renders NOTHING while there is nothing to show: no heading, no placeholder, no «próximamente». A real shop is
 * attached in `BUSINESS_PROOF` (`lib/business-types.ts`) only with its written consent, and until then an empty
 * promise on a sales page is worse than silence. Kept in its own file with no stylesheet import so the Playwright `api`
 * runner can render it to a string and see that «nothing» really is nothing.
 */
export function BusinessProofSlot({
  title,
  shops,
  pageId,
}: {
  title: string
  shops: readonly RealShopProof[]
  pageId: string
}) {
  if (shops.length === 0) return null

  return (
    <section
      aria-labelledby={`${pageId}-real-proof-title`}
      data-testid="business-proof"
      style={{ marginBottom: 'var(--s-10)' }}
    >
      <h2 id={`${pageId}-real-proof-title`} className="t-h2" style={{ letterSpacing: 0, marginBottom: 'var(--s-4)' }}>
        {title}
      </h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 'var(--s-3)' }}>
        {shops.map((shop) => (
          <article key={shop.href} className="card-panel" style={{ padding: 'var(--s-5)' }}>
            <h3 className="t-h4" style={{ letterSpacing: 0, marginBottom: 'var(--s-2)' }}>
              <a href={shop.href}>{shop.shopName}</a>
            </h3>
            {shop.quote ? (
              <p className="t-small" style={{ color: 'var(--fg-muted)', margin: 0 }}>
                {shop.quote}
              </p>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  )
}
