'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/feedback/Banner'
import { patchShop, publishShop } from '@/lib/prompt-to-shop/client'
import type { ChooserState } from '@/lib/prompt-to-shop/cobros'
import { ARMAR_COPY, CHECKLIST_COPY, CHECKLIST_LABELS, PHOTO_COPY, PUBLISH_COPY } from '@/lib/prompt-to-shop/copy'
import { trackFunnel } from '@/lib/prompt-to-shop/funnel'
import type { PublishState } from '@/lib/prompt-to-shop/photo'
import type { CanvasView, OwnProductCardView } from '@/lib/prompt-to-shop/view'
import type { SetupStep, SetupStepId } from '@/lib/setup-guide'
import type { GuideProgress } from '@/lib/setup-guide-source'
import CobrosChooser from './CobrosChooser'
import OwnerSheet from './OwnerSheet'
import PhotoSheet from './PhotoSheet'
import PublishedMoment from './PublishedMoment'
import ShopCanvas from './ShopCanvas'

/**
 * The owner's kept shop on `/sell/armar` (epic prompt-to-shop S3.2 → S4): the shop as the canvas draws it, with a
 * short checklist over it.
 *
 * The checklist IS `getSetupSteps` (D17), fed the same row and product count as Resumen through
 * `lib/setup-guide-source.ts`, so the % here is Resumen's %. Only the labels differ (Fotos, Cobros, Entregas).
 * Every item opens a sheet on the canvas — never a separate form page: Fotos is the photo → product flow, Perfil is
 * edited inline, Cobros and Entregas open the chooser (S5.1, also at `/sell/armar/cobros`), Comparte copies the
 * shop's link. «Publicar» is the canvas's action, not a % step: disabled with its reason until the shop has a product
 * of its own; tapping it publishes that shop's unpublished products (S5.2, `POST /api/p2s/publish`) and shows the
 * shop as the marketplace shows it, with the shares.
 *
 * Funnel (S5.3): kept, real product added, payments connected and published are counted here, once per draft, from
 * the STATE the page shows — not from a tap — so a refresh, a second tab or a step done elsewhere counts the same.
 */

type SheetState = { kind: 'step'; id: SetupStepId } | { kind: 'photo'; replace: { index: number; title: string } | null } | null

export default function KeptShop({
  view,
  shopSlug,
  steps,
  progress,
  ownCards,
  publish,
  photosLeft,
  profile,
  market,
  chooser,
  correosAvailable,
}: {
  view: CanvasView
  shopSlug: string | null
  steps: SetupStep[]
  progress: GuideProgress
  /** The shop's real Medusa products; null when they could not be read. */
  ownCards: OwnProductCardView[] | null
  publish: PublishState
  photosLeft: number | null
  profile: { name: string; description: string }
  /** The shop's operating market, for checkout's preview query. */
  market: string
  /** The cobros / entregas switches as the shop row holds them. */
  chooser: ChooserState
  correosAvailable: boolean
}) {
  const router = useRouter()
  const [sheet, setSheet] = useState<SheetState>(null)
  const close = useCallback(() => setSheet(null), [])
  const publicPath = shopSlug ? `/mx/s/${shopSlug}` : null
  const [publishing, setPublishing] = useState<{ kind: 'idle' | 'busy' } | { kind: 'error'; message: string }>({ kind: 'idle' })
  const [justPublished, setJustPublished] = useState(false)

  const draftId = view.shop.id
  const publishedCards = (ownCards ?? []).filter((c) => c.published)
  const unpublished = (ownCards ?? []).filter((c) => !c.published).length
  const pagosDone = steps.some((s) => s.id === 'pagos' && s.done)
  // The moment shows after a publish, and on any later visit once everything the merchant made is public.
  const showMoment = !!(shopSlug && publicPath && publishedCards.length > 0 && (justPublished || unpublished === 0))

  useEffect(() => { trackFunnel('p2s_kept', draftId) }, [draftId])
  useEffect(() => { if ((ownCards?.length ?? 0) > 0) trackFunnel('p2s_real_product_added', draftId) }, [draftId, ownCards])
  useEffect(() => { if (pagosDone) trackFunnel('p2s_payments_connected', draftId) }, [draftId, pagosDone])
  useEffect(() => { if (publishedCards.length > 0) trackFunnel('p2s_published', draftId, { live: publishedCards.length }) }, [draftId, publishedCards.length])

  async function runPublish() {
    if (publishing.kind === 'busy') return
    setPublishing({ kind: 'busy' })
    const result = await publishShop()
    if (!result.ok) {
      setPublishing({ kind: 'error', message: result.message })
      return
    }
    setPublishing({ kind: 'idle' })
    setJustPublished(true)
    router.refresh()
  }

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

        <section className="grid gap-2" aria-label={CHECKLIST_COPY.title} data-testid="p2s-checklist">
          {steps.length ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="t-small" style={{ fontWeight: 600 }}>{CHECKLIST_COPY.title}</span>
                <span className="t-small" style={{ color: 'var(--fg-muted)' }} data-testid="p2s-checklist-progress">
                  {CHECKLIST_COPY.progress(progress.done, progress.total, progress.percent)}
                </span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }} aria-hidden="true">
                <div className="h-full rounded-full" style={{ width: `${progress.percent}%`, background: view.accent }} />
              </div>
              <ul className="flex flex-wrap gap-2" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                {steps.map((step) => (
                  <li key={step.id}>
                    <button
                      type="button"
                      className={`btn btn-sm ${step.done ? 'btn-ghost' : 'btn-secondary'}`}
                      aria-label={`${CHECKLIST_LABELS[step.id]}: ${step.done ? CHECKLIST_COPY.done : CHECKLIST_COPY.todo}`}
                      onClick={() => setSheet(step.id === 'catalogo' ? { kind: 'photo', replace: null } : { kind: 'step', id: step.id })}
                      data-testid={`p2s-step-${step.id}`}
                    >
                      <i className={step.done ? 'iconoir-check-circle' : 'iconoir-circle'} aria-hidden="true" /> {CHECKLIST_LABELS[step.id]}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <Banner variant="neutral">{CHECKLIST_COPY.noGuide}</Banner>
          )}
        </section>

        <div className="grid gap-1" style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--s-3)' }}>
          {showMoment && shopSlug && publicPath ? (
            <PublishedMoment shopName={view.name ?? profile.name} shopSlug={shopSlug} publicPath={publicPath} cards={publishedCards} onShared={() => router.refresh()} />
          ) : null}
          {publish.enabled && unpublished > 0 ? (
            <>
              <div>
                <Button type="button" variant="primary" onClick={runPublish} disabled={publishing.kind === 'busy'} data-testid="p2s-publish">
                  {publishing.kind === 'busy' ? PUBLISH_COPY.publishing : PHOTO_COPY.publish}
                </Button>
              </div>
              {publishing.kind === 'error' ? (
                <Banner variant="warning">{publishing.message}</Banner>
              ) : null}
            </>
          ) : publish.enabled ? null : (
            <>
              <div>
                <Button type="button" variant="primary" disabled aria-describedby="p2s-publish-reason" data-testid="p2s-publish">{PHOTO_COPY.publish}</Button>
              </div>
              <p id="p2s-publish-reason" className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }} data-testid="p2s-publish-reason">{publish.reason}</p>
            </>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Link href="/shop/manage" prefetch={false} className="btn btn-secondary">{ARMAR_COPY.manage}</Link>
          {publicPath ? (
            <Link href={publicPath} prefetch={false} className="btn btn-ghost">{ARMAR_COPY.viewShop}</Link>
          ) : null}
        </div>
      </div>
    </div>
  )

  const stepById = (id: SetupStepId) => steps.find((s) => s.id === id)

  return (
    <>
      <ShopCanvas
        view={view}
        mode="owner"
        toolbar={toolbar}
        ownCards={ownCards ?? undefined}
        exampleAction={(card) => (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ width: '100%' }}
            onClick={() => setSheet({ kind: 'photo', replace: { index: card.index, title: card.title } })}
            data-testid="p2s-example-replace"
          >
            <i className="iconoir-camera" aria-hidden="true" /> {PHOTO_COPY.replace}
          </button>
        )}
      />

      {sheet?.kind === 'photo' ? (
        <PhotoSheet replace={sheet.replace} photosLeft={photosLeft} onClose={close} onAdded={() => router.refresh()} />
      ) : null}
      {sheet?.kind === 'step' && sheet.id === 'perfil' ? <PerfilSheet profile={profile} onClose={close} onSaved={() => router.refresh()} /> : null}
      {sheet?.kind === 'step' && (sheet.id === 'pagos' || sheet.id === 'envios') ? (
        <OwnerSheet
          title={sheet.id === 'pagos' ? CHECKLIST_COPY.cobrosTitle : CHECKLIST_COPY.entregasTitle}
          lead={sheet.id === 'pagos' ? CHECKLIST_COPY.cobrosLead : CHECKLIST_COPY.entregasLead}
          onClose={close}
          testId={`p2s-sheet-${sheet.id}`}
        >
          {shopSlug ? (
            <CobrosChooser
              shopSlug={shopSlug}
              market={market}
              initial={chooser}
              correosAvailable={correosAvailable}
              draftId={draftId}
              onSaved={() => router.refresh()}
            />
          ) : (
            <div>
              <Link href={stepById(sheet.id)?.ctaHref ?? '/shop/manage/settings'} prefetch={false} className="btn btn-primary">{CHECKLIST_COPY.goSettings}</Link>
            </div>
          )}
        </OwnerSheet>
      ) : null}
      {sheet?.kind === 'step' && sheet.id === 'comparte' ? (
        <ShareSheet publicPath={publicPath} onClose={close} onShared={() => router.refresh()} />
      ) : null}
    </>
  )
}

function PerfilSheet({ profile, onClose, onSaved }: { profile: { name: string; description: string }; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(profile.name)
  const [description, setDescription] = useState(profile.description)
  const [state, setState] = useState<{ kind: 'idle' | 'saving' | 'saved' | 'error'; message?: string }>({ kind: 'idle' })

  async function save() {
    if (!name.trim() || state.kind === 'saving') return
    setState({ kind: 'saving' })
    const result = await patchShop({ name: name.trim(), description: description.trim() })
    setState(result.ok ? { kind: 'saved' } : { kind: 'error', message: result.message })
    if (result.ok) onSaved()
  }

  return (
    <OwnerSheet title={CHECKLIST_COPY.perfilTitle} lead={CHECKLIST_COPY.perfilLead} onClose={onClose} testId="p2s-sheet-perfil">
      <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <label className="grid gap-1 t-small">
          <span style={{ fontWeight: 600 }}>{CHECKLIST_COPY.nameLabel}</span>
          <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="grid gap-1 t-small">
          <span style={{ fontWeight: 600 }}>{CHECKLIST_COPY.descriptionLabel}</span>
          <textarea className="input" rows={4} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div>
          <Button type="submit" variant="primary" disabled={state.kind === 'saving' || !name.trim()}>
            {state.kind === 'saving' ? CHECKLIST_COPY.saving : CHECKLIST_COPY.save}
          </Button>
        </div>
        <p className="t-small" style={{ margin: 0, minHeight: 20 }} role="status" aria-live="polite">{state.kind === 'saved' ? CHECKLIST_COPY.saved : null}</p>
        {state.kind === 'error' ? <Banner variant="warning">{state.message}</Banner> : null}
      </form>
    </OwnerSheet>
  )
}

function ShareSheet({ publicPath, onClose, onShared }: { publicPath: string | null; onClose: () => void; onShared: () => void }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'manual'>('idle')
  const [url, setUrl] = useState<string | null>(null)

  async function copy() {
    if (!publicPath) return
    // The origin the merchant is on (production, or a preview while testing), read at tap time, not at render.
    const link = `${window.location.origin}${publicPath}`
    setUrl(link)
    try {
      await navigator.clipboard.writeText(link)
      setCopied('copied')
    } catch {
      setCopied('manual')
    }
    // The comparte step's signal, through the same seam Resumen's guide card writes it.
    const saved = await patchShop({ settings: { guide: { share_done: true } } })
    if (saved.ok) onShared()
  }

  return (
    <OwnerSheet title={CHECKLIST_COPY.comparteTitle} lead={CHECKLIST_COPY.comparteLead} onClose={onClose} testId="p2s-sheet-comparte">
      {publicPath ? (
        <div className="grid gap-2">
          <div>
            <Button type="button" variant="primary" onClick={copy}>
              <i className="iconoir-share-android" aria-hidden="true" /> {CHECKLIST_COPY.copyLink}
            </Button>
          </div>
          <p className="t-small" style={{ margin: 0 }} role="status" aria-live="polite">{copied === 'copied' ? CHECKLIST_COPY.copied : null}</p>
          {copied === 'manual' && url ? (
            <label className="t-small grid gap-1">
              {CHECKLIST_COPY.copyManual}
              <input className="input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
            </label>
          ) : null}
        </div>
      ) : (
        <Banner variant="neutral">{CHECKLIST_COPY.noGuide}</Banner>
      )}
    </OwnerSheet>
  )
}
