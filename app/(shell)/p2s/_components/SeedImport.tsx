'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/feedback/Banner'
import { SEED_COPY } from '@/lib/prompt-to-shop/copy'
import { seedImportRows, SEED_IMPORT_CHUNK, type SeedRow } from '@/lib/prompt-to-shop/view'

/**
 * «Subir mis N productos» on the kept shop (one-front-door-both-markets D9). The merchant's own rows — from a photo,
 * a file or their old store — ride on the draft until the shop is theirs; this posts them to the EXISTING
 * `/api/sell/import` (Medusa products, the same route the import page uses), as the now-signed-in merchant, in the
 * importer's own chunk size. Each row carries an external id derived from the draft, so a second tap UPDATES the
 * products it made instead of creating them twice.
 */
export default function SeedImport({ draftId, rows }: { draftId: string; rows: SeedRow[] }) {
  const router = useRouter()
  const [state, setState] = useState<{ kind: 'idle' | 'busy' } | { kind: 'done'; created: number; failed: number } | { kind: 'error'; message: string }>({ kind: 'idle' })
  const payload = seedImportRows(draftId, rows)

  async function upload() {
    setState({ kind: 'busy' })
    let created = 0
    let failed = 0
    try {
      for (let i = 0; i < payload.length; i += SEED_IMPORT_CHUNK) {
        const res = await fetch('/api/sell/import', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: payload.slice(i, i + SEED_IMPORT_CHUNK) }),
        })
        const data = (await res.json().catch(() => null)) as { results?: Array<{ status: string }>; error?: string } | null
        if (!res.ok) throw new Error(data?.error ?? SEED_COPY.failed)
        for (const r of data?.results ?? []) {
          if (r.status === 'failed') failed += 1
          else created += 1
        }
      }
      setState({ kind: 'done', created, failed })
      router.refresh()
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : SEED_COPY.failed })
    }
  }

  return (
    <section data-testid="p2s-seed-import" className="max-w-6xl mx-auto px-4 mt-6">
      <div className="card-panel" style={{ padding: 'var(--s-4)', display: 'grid', gap: 'var(--s-2)' }}>
        <p className="t-h4" style={{ margin: 0, letterSpacing: 0 }}>{SEED_COPY.title(rows.length)}</p>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{SEED_COPY.lead}</p>
        {state.kind === 'done' ? (
          <Banner variant={state.failed ? 'warning' : 'success'}>{SEED_COPY.done(state.created, state.failed)}</Banner>
        ) : null}
        {state.kind === 'error' ? <Banner variant="warning">{state.message}</Banner> : null}
        <div>
          <Button type="button" variant="primary" disabled={state.kind === 'busy'} onClick={() => void upload()} data-testid="p2s-seed-import-run">
            {state.kind === 'busy' ? SEED_COPY.busy : state.kind === 'done' ? SEED_COPY.again : SEED_COPY.run(rows.length)}
          </Button>
        </div>
      </div>
    </section>
  )
}
