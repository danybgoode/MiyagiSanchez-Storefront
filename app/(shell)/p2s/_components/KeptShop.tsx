import Link from 'next/link'
import { ARMAR_COPY } from '@/lib/prompt-to-shop/copy'
import type { CanvasView } from '@/lib/prompt-to-shop/view'
import ShopCanvas from './ShopCanvas'

/**
 * The owner's first look at a kept shop on `/sell/armar` (epic S3.2). Deliberately simple: the shop as the canvas
 * draws it (examples still tagged EJEMPLO — they never went to Medusa), a success line, and the way to the panel.
 * S4 adds the checklist and the photo flow here.
 */
export default function KeptShop({ view, shopSlug }: { view: CanvasView; shopSlug: string | null }) {
  const publicPath = shopSlug ? `/mx/s/${shopSlug}` : null
  const toolbar = (
    <div className="max-w-6xl mx-auto px-4 pt-3" data-testid="p2s-kept">
      <div className="card-panel grid gap-3" style={{ padding: 'var(--s-4)' }}>
        <h1 className="t-h3" style={{ margin: 0, letterSpacing: 0 }}>{ARMAR_COPY.keptTitle(view.name)}</h1>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{ARMAR_COPY.keptLead}</p>
        {publicPath ? (
          <p className="t-small" style={{ margin: 0 }}>
            <span style={{ fontWeight: 600 }}>{ARMAR_COPY.address}:</span> miyagisanchez.com{publicPath}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Link href="/shop/manage" prefetch={false} className="btn btn-primary">{ARMAR_COPY.manage}</Link>
          {publicPath ? (
            <Link href={publicPath} prefetch={false} className="btn btn-secondary">{ARMAR_COPY.viewShop}</Link>
          ) : null}
        </div>
      </div>
    </div>
  )
  return <ShopCanvas view={view} mode="owner" toolbar={toolbar} />
}
