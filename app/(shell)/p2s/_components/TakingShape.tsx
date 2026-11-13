'use client'

import BodyPortal from '@/components/ui/BodyPortal'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/feedback/Banner'
import { runDraftRequest } from '@/lib/prompt-to-shop/client'
import { builderCopy } from '@/lib/prompt-to-shop/copy-en'
import { draftView, seedCards, type DraftBlocks, type SeedRow } from '@/lib/prompt-to-shop/view'
import ShopCanvas from './ShopCanvas'
import { P2sLocaleProvider } from './P2sLocale'

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
  shape,
  onBack,
  onDone,
  locale = 'es',
  marketHint = null,
  input = 'text',
  seedRows,
}: {
  description?: string
  turnstileToken: string
  /** Set for a re-run on an owned draft («Otra versión»); absent for a first generation. */
  draftId?: string
  tone?: string
  /** The business shape the merchant picked for a re-run (business-infrastructure D3); absent = the model decides. */
  shape?: string
  onBack: () => void
  /** Overrides the default navigation to the owner canvas (used when «Otra versión» runs in place). */
  onDone?: (result: { draftId: string; versionsLeft: number }) => void
  /** one-front-door-both-markets D11/D12/D19/D9 — sent with a FIRST generation only; a re-run keeps the draft's own. */
  locale?: 'es' | 'en'
  marketHint?: 'mx' | 'us' | null
  input?: 'text' | 'photo' | 'file' | 'url'
  seedRows?: unknown[]
}) {
  const router = useRouter()
  const { NARRATION, SHAPING: SHAPING_COPY } = builderCopy(locale)
  const [blocks, setBlocks] = useState<DraftBlocks>(EMPTY)
  const [message, setMessage] = useState<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    void runDraftRequest(
      {
        turnstile_token: turnstileToken, ...(description ? { description } : {}), ...(draftId ? { draft_id: draftId } : {}), ...(tone ? { tone } : {}), ...(shape ? { shape } : {}),
        // The language rides on every request (it picks the refusal copy); the hint, input and rows only on a first
        // generation — a re-run keeps the draft's own market (Codex, PR #498).
        locale,
        ...(draftId ? {} : { market_hint: marketHint, input, ...(seedRows?.length ? { seed_rows: seedRows } : {}) }),
      },
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

  const view = draftView(draftId ?? 'nuevo', blocks, locale)

  return (
    <P2sLocaleProvider locale={locale}>
    <BodyPortal>
    <div className="fixed inset-0 overflow-y-auto" style={{ zIndex: 'var(--z-overlay)', background: 'var(--bg)' }} data-testid="p2s-taking-shape">
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
      <ShopCanvas view={view} mode="shaping" ownCards={seedCards(seedRows as SeedRow[] | undefined, locale)} />
    </div>
    </BodyPortal>
    </P2sLocaleProvider>
  )
}
