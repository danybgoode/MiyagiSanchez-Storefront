import type { Metadata } from 'next'
import Link from 'next/link'
import { GONE_COPY } from '@/lib/prompt-to-shop/copy'

/**
 * Every way a draft can be unreachable — no such id, not this phone's, expired, a dead share link — lands here, so
 * the page cannot tell a stranger which one it was. Friendly, never a 500, and it offers the way forward.
 */

export const metadata: Metadata = { robots: { index: false, follow: false } }

export default function P2sGone() {
  return (
    <main className="app-shell" style={{ paddingTop: 'var(--s-10)', paddingBottom: 'var(--s-10)' }}>
      <section className="card-panel" style={{ maxWidth: 520, margin: '0 auto', padding: 'var(--s-6)', display: 'grid', gap: 'var(--s-3)' }}>
        <h1 className="t-h3" style={{ letterSpacing: 0, margin: 0 }}>{GONE_COPY.title}</h1>
        <p className="t-lead" style={{ margin: 0, color: 'var(--fg-muted)' }}>{GONE_COPY.message}</p>
        <div>
          <Link href="/mx/vende" className="btn btn-primary btn-lg" prefetch={false}>
            {GONE_COPY.action}
          </Link>
        </div>
      </section>
    </main>
  )
}
