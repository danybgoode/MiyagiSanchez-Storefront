'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/feedback/Banner'
import { runDraftRequest } from '@/lib/prompt-to-shop/client'
import { NARRATION, SHAPING_COPY } from '@/lib/prompt-to-shop/copy'
import { draftView, type DraftBlocks } from '@/lib/prompt-to-shop/view'
import ShopCanvas from './ShopCanvas'

/**
 * The taking-shape screen (epic S2.3): the shop skeleton filling in, block by block, with a narration line per step.
 *
 * Under the narration is the REAL canvas (`ShopCanvas`, the same component the owner's preview uses) showing a
 * placeholder for every block that has not landed — not a spinner. The narration is on screen in the same render as
 * the tap, because every line starts pending; ✓ replaces the dots as each block arrives.
 *
 * The request starts here, once. A ref guards the effect so React's dev double-mount cannot fire two requests, and
 * each request spends one of the merchant's versions. On `done` we navigate to the owner route, so a reload works.
 */

const EMPTY: DraftBlocks = { identity: null, words: null, catalog: null, block_status: {} }

export default function TakingShape({
  description,
  turnstileToken,
  draftId,
  tone,
  onBack,
  onDone,
}: {
  description?: string
  turnstileToken: string
  /** Set for a re-run on an owned draft («Otra versión»); absent for a first generation. */
  draftId?: string
  tone?: string
  onBack: () => void
  /** Overrides the default navigation to the owner canvas (used when «Otra versión» runs in place). */
  onDone?: (result: { draftId: string; versionsLeft: number }) => void
}) {
  const router = useRouter()
  const [blocks, setBlocks] = useState<DraftBlocks>(EMPTY)
  const [message, setMessage] = useState<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    void runDraftRequest(
      { turnstile_token: turnstileToken, ...(description ? { description } : {}), ...(draftId ? { draft_id: draftId } : {}), ...(tone ? { tone } : {}) },
      (event) =>
        setBlocks((prev) => ({
          ...prev,
          [event.key]: event.data,
          block_status: { ...prev.block_status, [event.key]: event.status },
        })),
    ).then((outcome) => {
      if (outcome.kind === 'done') {
        if (onDone) onDone({ draftId: outcome.draftId, versionsLeft: outcome.versionsLeft })
        else router.push(`/p2s/${outcome.draftId}`)
      } else {
        setMessage(outcome.message)
      }
    })
    // One request per mount, by design (see the ref above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const view = draftView(draftId ?? 'nuevo', blocks)

  return (
    <div className="fixed inset-0 z-[100] overflow-y-auto" style={{ background: 'var(--bg)' }} data-testid="p2s-taking-shape">
      <div className="max-w-2xl mx-auto px-4 pt-6 pb-4">
        <h2 className="t-h3" style={{ letterSpacing: 0, marginBottom: 'var(--s-3)' }}>{SHAPING_COPY.title}</h2>
        <ul role="status" aria-live="polite" className="grid gap-1.5" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {NARRATION.map((line) => {
            const landed = !view.pending[line.key]
            return (
              <li key={line.label} data-testid="p2s-narration" data-landed={landed} className="text-sm" style={{ color: landed ? 'var(--fg)' : 'var(--fg-muted)' }}>
                {landed ? `${line.label} ✓` : `${line.label}…`}
              </li>
            )
          })}
        </ul>
        {message ? (
          <div className="mt-4 grid gap-3">
            <Banner variant="warning">{message}</Banner>
            <div>
              <Button type="button" variant="secondary" onClick={onBack} data-testid="p2s-shaping-back">
                {SHAPING_COPY.back}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      <ShopCanvas view={view} mode="shaping" />
    </div>
  )
}
