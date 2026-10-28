import ShopThemeShell from '@/app/(shell)/_shop-sections/ShopThemeShell'
import { Banner } from '@/components/feedback/Banner'
import { shopInitials, SHOP_INDEX_GRID_CLASS } from '@/lib/shop-presentation/chrome'
import { CANVAS_COPY, FALLBACK_NOTE } from '@/lib/prompt-to-shop/copy'
import type { BlockKey } from '@/lib/prompt-to-shop/blocks'
import type { CanvasView, ExampleCardView } from '@/lib/prompt-to-shop/view'
import ExampleIllustration from './ExampleIllustration'

/**
 * The prompt-to-shop canvas (epic S2.3/S2.4/S2.5, D14) — ONE component for the taking-shape screen, the owner's
 * preview and the view-only link.
 *
 * It renders inside the real `ShopThemeShell`, with the real shop-chrome classes, so a preset that restyles the live
 * shop restyles this. A block that has not landed yet shows a placeholder in its place (never a spinner and never
 * invented text): the taking-shape screen IS this component with fewer blocks filled in.
 *
 * It has NO buy, cart or offer affordance in any mode: an example is not for sale. Editing controls arrive only
 * through `toolbar`, which the owner page passes and the view-only page never does (D15).
 */

export type CanvasMode = 'shaping' | 'owner' | 'viewer'

const SKELETON = 'block rounded animate-pulse motion-reduce:animate-none'
const skeletonStyle = { background: 'var(--shop-border, var(--border))' } as const

function Bar({ width, height = 14 }: { width: string; height?: number }) {
  return <span className={SKELETON} style={{ ...skeletonStyle, width, height }} aria-hidden="true" />
}

function ExampleCard({ card, accent, accentText }: { card: ExampleCardView; accent: string; accentText: string }) {
  return (
    <article
      data-testid="p2s-example-card"
      className="relative overflow-hidden"
      style={{
        background: 'var(--shop-surface, var(--bg-elevated))',
        border: '1px solid var(--shop-border, var(--border))',
        borderRadius: 'var(--shop-radius, 0.75rem)',
      }}
    >
      <span
        className="absolute left-2 top-2 z-10 px-2 py-0.5 text-[10px] font-extrabold tracking-wider"
        style={{ background: accent, color: accentText, borderRadius: 'var(--shop-radius, 999px)' }}
      >
        {card.tag}
      </span>
      <ExampleIllustration name={card.illustration} />
      <div className="p-2.5">
        <p className="text-xs font-medium line-clamp-2 leading-snug">{card.title}</p>
        {card.description ? (
          <p className="mt-1 text-[11px] line-clamp-2" style={{ color: 'var(--shop-fg-muted, var(--fg-muted))' }}>{card.description}</p>
        ) : null}
        <p className="mt-1.5 text-sm font-bold" style={{ color: accent }}>
          {card.priceLabel}
          <span className="ml-1.5 text-[10px] font-medium" style={{ color: 'var(--shop-fg-muted, var(--fg-muted))' }}>{CANVAS_COPY.priceCaption}</span>
        </p>
      </div>
    </article>
  )
}

function SkeletonCard() {
  return (
    <div
      aria-hidden="true"
      style={{ border: '1px solid var(--shop-border, var(--border))', borderRadius: 'var(--shop-radius, 0.75rem)', overflow: 'hidden' }}
    >
      <span className={`${SKELETON} h-36`} style={{ ...skeletonStyle, borderRadius: 0 }} />
      <div className="p-2.5 grid gap-2">
        <Bar width="80%" />
        <Bar width="40%" />
      </div>
    </div>
  )
}

export default function ShopCanvas({
  view,
  mode,
  toolbar,
}: {
  view: CanvasView
  mode: CanvasMode
  /** Owner-only editing controls. The view-only page never passes one (D15). */
  toolbar?: React.ReactNode
}) {
  const waiting = (Object.keys(view.pending) as BlockKey[]).some((k) => view.pending[k])
  // «Otra versión» is the owner's next step, so a read-only visitor is not told to take it.
  const fallbackNotes = mode === 'viewer' ? [] : (Object.keys(view.fallback) as BlockKey[]).filter((k) => view.fallback[k])

  return (
    <ShopThemeShell theme={view.theme} accent={view.accent}>
      <div data-testid="p2s-canvas" data-canvas-mode={mode} aria-busy={mode === 'shaping' && waiting ? true : undefined} className="pb-12">
        {/* A viewer is never handed controls, even if a caller passes some (D15). */}
        {mode === 'viewer' ? null : toolbar}
        {mode === 'viewer' ? (
          <div className="max-w-6xl mx-auto px-4 pt-3">
            <Banner variant="neutral">{CANVAS_COPY.viewerNote}</Banner>
          </div>
        ) : null}

        {view.pending.words || !view.announcement?.trim() ? null : (
          <p
            className="text-center text-xs font-semibold px-4 py-2"
            style={{ background: view.accent, color: view.accentTextColor }}
          >
            {view.announcement}
          </p>
        )}

        <header className="shop-header">
          <div className="shop-header-inner">
            <span className="shop-identity" aria-label={view.name ?? CANVAS_COPY.loading}>
              {view.name ? (
                <span className="shop-avatar shop-avatar-fallback" style={{ background: view.accent, color: view.accentTextColor }}>
                  {shopInitials(view.name)}
                </span>
              ) : (
                <span className={`shop-avatar ${SKELETON}`} style={skeletonStyle} aria-hidden="true" />
              )}
              {view.name ? <span className="shop-name">{view.name}</span> : <Bar width="140px" height={16} />}
            </span>
          </div>
        </header>

        <section className="shop-hero" style={{ gridTemplateColumns: '1fr' }}>
          <div className="shop-hero-copy">
            {view.pending.identity ? (
              <Bar width="120px" height={11} />
            ) : (
              <p className="shop-eyebrow" style={{ color: view.accent }}>{view.tagline}</p>
            )}
            {view.pending.words ? (
              <div className="grid gap-3 mt-3" aria-hidden="true">
                <Bar width="70%" height={34} />
                <Bar width="95%" />
                <Bar width="85%" />
              </div>
            ) : (
              <>
                <h1 className="shop-hero-title">{view.headline}</h1>
                <p className="shop-hero-lead">{view.about}</p>
              </>
            )}
          </div>
        </section>

        {fallbackNotes.length ? (
          <div className="max-w-6xl mx-auto px-4 grid gap-2 mb-4">
            {fallbackNotes.map((key) => (
              <Banner key={key} variant="info">{FALLBACK_NOTE[key]}</Banner>
            ))}
          </div>
        ) : null}

        <section className="max-w-6xl mx-auto px-4" aria-label={CANVAS_COPY.productsTitle}>
          <h2 className="text-xl font-bold mb-1">{CANVAS_COPY.productsTitle}</h2>
          <p className="text-xs mb-4" style={{ color: 'var(--shop-fg-muted, var(--fg-muted))' }}>{CANVAS_COPY.exampleNote}</p>
          <div className={SHOP_INDEX_GRID_CLASS}>
            {view.cards
              ? view.cards.map((card) => <ExampleCard key={card.key} card={card} accent={view.accent} accentText={view.accentTextColor} />)
              : [0, 1, 2, 3].map((i) => <SkeletonCard key={i} />)}
          </div>
        </section>
      </div>
    </ShopThemeShell>
  )
}
