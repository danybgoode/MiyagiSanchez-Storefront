import type { CSSProperties } from 'react'
import Link from 'next/link'
import type { SellerAcquisitionVariant } from '@/lib/seller-acquisition'
import { PromptBlock } from './PromptBlock'
import { SellerAcquisitionVariantTag } from './SellerAcquisitionVariantTag'
import styles from './SellerAcquisitionHero.module.css'

type HeroValue = { value: string; label: string; icon?: string }

type LandingCta = {
  label: string
  href: string
  testId?: string
  /**
   * Optional `data-track` attribute. `/us/operators` reuses this shell but still has to
   * emit its recruiting funnel events; rather than teaching a generic landing component
   * about recruiting, the CTA carries a marker and the page's own client component
   * delegates the click. Undefined everywhere else, so nothing is rendered.
   */
  dataTrack?: string
}

type LandingPoint = {
  icon: string
  title: string
  body: string
}

type LandingStep = {
  title: string
  body: string
}

type PersonaRouterCard = {
  eyebrow: string
  title: string
  body: string
  href: string
  icon: string
  statusLabel?: string
  testId?: string
}

/**
 * One comparison row. `cells` is positional and parallel to `LandingBenchmark.columns`
 * — cell 0 is always ours and gets the highlight treatment.
 *
 * It used to be three NAMED fields (`miyagi`/`mercadoLibre`/`shopify`), which hardcoded
 * the Mexican competitor set into a component the US operator page also renders. There
 * the reference points are Shopify and Amazon, so a `mercadoLibre` field would have had
 * to carry Amazon copy — a field name that lies. Positional cells keep one renderer for
 * every market; the column headers name the platforms.
 */
type BenchmarkRow = {
  label: string
  cells: string[]
}

type BenchmarkExampleRow = {
  platform: string
  commission: string
  monthly: string
  takeHome: string
}

type BenchmarkExample = {
  title: string
  lead: string
  columns: string[]
  rows: BenchmarkExampleRow[]
  punchline: string
  footnotes: string[]
}

type LandingBenchmark = {
  title: string
  lead: string
  rowHeader: string
  columns: string[]
  rows: BenchmarkRow[]
  verified: string
  verifiedLabel: string
  footnote: string
  // Worked take-home example under the table (S2): "vendes un producto de $1,000 MXN".
  example?: BenchmarkExample
}

type PremiumFeatureItem = {
  icon: string
  label: string
  sub: string
}

type PremiumFeatures = {
  title: string
  lead: string
  items: PremiumFeatureItem[]
}

// "Apply to be a promoter" section (epic 08 · promoter-funnel-v2), shown to a not-yet-bound
// visitor whose primary CTA anchors here. `form` (S2 · US-2.1) is an optional slot — when the
// page supplies it, the real application form renders instead of the title+body copy; passing
// only `title`/`body` keeps the section usable as a plain teaser for any future consumer.
type ApplyTeaser = {
  id: string
  title: string
  body: string
  form?: React.ReactNode
}

// Platform-migrations epic (03) · Sprint 3 (US-3.2) — a compact "coming from another
// platform?" nudge on the personas most likely to already run a shop elsewhere
// (negocios/servicios), pointing at the /mx/vende/migracion hub. Optional and additive —
// most persona pages leave it undefined.
export type LandingCallout = {
  title: string
  body: string
  cta: LandingCta
}

type LandingAiChannel = {
  eyebrow: string
  title: string
  body: string
  steps: LandingStep[]
  note: string
}

export type SellerAcquisitionPageConfig = {
  pageId: string
  variant: SellerAcquisitionVariant
  eyebrow: string
  title: string
  lead: string
  trustLine: string
  trustPrompt: string
  copyLabel: string
  copiedLabel: string
  // Nullable so a flag-gated CTA (e.g. the promoter close workspace) can hide itself
  // outright when the target route would 404, instead of linking to a dead page.
  primaryCta: LandingCta | null
  secondaryCta?: LandingCta
  heroStats: Array<{ value: string; label: string }>
  // Anchor leads its hero right panel with a value list (0% · IA · Premium); personas fall back to heroStats.
  heroValues?: HeroValue[]
  proofTitle: string
  proofLead: string
  proofPoints: LandingPoint[]
  personaRouter?: {
    title: string
    lead: string
    cards: PersonaRouterCard[]
  }
  stepsTitle: string
  steps: LandingStep[]
  agentTitle: string
  agentBody: string
  socialTitle: string
  socialBody: string
  socialStats: Array<{ value: string; label: string }>
  // Anchor replaces its social-proof stats block with this premium-features grid; personas leave it undefined.
  premiumFeatures?: PremiumFeatures
  faqTitle: string
  faqs: LandingStep[]
  closingTitle: string
  closingBody: string
  closingCta: LandingCta | null
  benchmark?: LandingBenchmark
  aiChannel?: LandingAiChannel
  applyTeaser?: ApplyTeaser
  migrationCallout?: LandingCallout
  /**
   * The prompt-to-shop describe box (epic prompt-to-shop S2.2). Rendered right under the hero title so it sits
   * above the fold on a 375 px phone; only the anchor page passes one.
   */
  describe?: React.ReactNode
}

export function SellerAcquisitionPage({ config }: { config: SellerAcquisitionPageConfig }) {
  return (
    <main
      className="app-shell"
      data-seller-persona={config.pageId}
      data-seller-variant={config.variant}
      style={{
        paddingTop: 'var(--s-8)',
        paddingBottom: 'var(--s-10)',
      }}
    >
      <SellerAcquisitionVariantTag persona={config.pageId} variant={config.variant} />
      <LandingHero config={config} />
      <ProofSection config={config} />
      {config.benchmark ? <BenchmarkSection benchmark={config.benchmark} pageId={config.pageId} /> : null}
      {config.personaRouter ? <PersonaRouterSection router={config.personaRouter} pageId={config.pageId} /> : null}
      <StepsSection config={config} />
      {config.aiChannel ? <AiChannelSection aiChannel={config.aiChannel} pageId={config.pageId} /> : null}
      {config.premiumFeatures ? (
        <PremiumFeaturesSection features={config.premiumFeatures} pageId={config.pageId} />
      ) : (
        <SocialProofSection config={config} />
      )}
      <FaqSection config={config} />
      {config.applyTeaser ? <ApplyTeaserSection teaser={config.applyTeaser} /> : null}
      {config.migrationCallout ? (
        <MigrationCalloutSection callout={config.migrationCallout} pageId={config.pageId} />
      ) : null}
      <ClosingCta config={config} />
    </main>
  )
}

function MigrationCalloutSection({ callout, pageId }: { callout: LandingCallout; pageId: string }) {
  return (
    <section aria-labelledby={`${pageId}-migration-callout-title`} style={{ marginBottom: 'var(--s-10)' }}>
      <article
        className="card-panel"
        style={{ padding: 'var(--s-6)', display: 'flex', flexWrap: 'wrap', gap: 'var(--s-5)', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <div style={{ maxWidth: 560 }}>
          <h2 id={`${pageId}-migration-callout-title`} className="t-h3" style={{ letterSpacing: 0, marginBottom: 'var(--s-2)' }}>
            {callout.title}
          </h2>
          <p className="t-lead" style={{ color: 'var(--fg-muted)' }}>{callout.body}</p>
        </div>
        <Link href={callout.cta.href} className="btn btn-secondary" data-testid={callout.cta.testId} prefetch={false}>
          {callout.cta.label}
          <i className="iconoir-arrow-right" aria-hidden="true" />
        </Link>
      </article>
    </section>
  )
}

function ApplyTeaserSection({ teaser }: { teaser: ApplyTeaser }) {
  return (
    <section id={teaser.id} aria-labelledby={`${teaser.id}-title`} style={{ marginBottom: 'var(--s-10)' }}>
      <article className="card-panel" style={{ padding: 'var(--s-6)' }}>
        <h2 id={`${teaser.id}-title`} className="t-h3" style={{ letterSpacing: 0, marginBottom: 'var(--s-2)' }}>
          {teaser.title}
        </h2>
        <p className="t-lead" style={{ color: 'var(--fg-muted)', marginBottom: teaser.form ? 'var(--s-5)' : 0 }}>{teaser.body}</p>
        {teaser.form}
      </article>
    </section>
  )
}

function LandingHero({ config }: { config: SellerAcquisitionPageConfig }) {
  // Anchor leads with the value list (0% · IA · Premium); persona pages keep their three stats.
  const values: HeroValue[] = config.heroValues ?? config.heroStats

  return (
    <section
      aria-labelledby={`${config.pageId}-hero-title`}
      className={config.describe ? `${styles.hero} ${styles.heroWithDescribe}` : styles.hero}
    >
      <h1
        id={`${config.pageId}-hero-title`}
        className={`t-h1 ${styles.title}`}
        style={{
          fontSize: 'clamp(var(--t-2xl), 7vw, var(--t-4xl))',
          letterSpacing: 0,
          marginBottom: 0,
          maxWidth: 680,
          overflowWrap: 'break-word',
        }}
      >
        {config.title}
      </h1>

      {config.describe ? <div className={styles.describe}>{config.describe}</div> : null}

      <p className={`t-lead ${styles.lead}`} style={{ maxWidth: 660, margin: 0 }}>
        {config.lead}
      </p>

      <TrustLine text={config.trustLine} className={styles.trust} />

      <div className={styles.prompt}>
        <PromptBlock
          prompt={config.trustPrompt}
          copyLabel={config.copyLabel}
          copiedLabel={config.copiedLabel}
          testId={`${config.pageId}-prompt-copy`}
        />
      </div>

      <HeroValueList values={values} className={styles.values} />

      <div
        className={styles.cta}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-3)', alignItems: 'center' }}
      >
        {config.primaryCta ? (
          <Link
            href={config.primaryCta.href}
            className="btn btn-primary btn-lg"
            data-testid={config.primaryCta.testId}
            data-track={config.primaryCta.dataTrack}
            prefetch={false}
          >
            {config.primaryCta.label}
            <i className="iconoir-arrow-right" aria-hidden="true" />
          </Link>
        ) : null}
        {config.secondaryCta ? (
          <Link
            href={config.secondaryCta.href}
            className="btn btn-secondary btn-lg"
            data-testid={config.secondaryCta.testId}
            data-track={config.secondaryCta.dataTrack}
            prefetch={false}
          >
            {config.secondaryCta.label}
          </Link>
        ) : null}
      </div>
    </section>
  )
}

function TrustLine({ text, className }: { text: string; className?: string }) {
  return (
    <p
      className={className}
      style={{
        margin: 0,
        color: 'var(--agent)',
        background: 'var(--agent-soft)',
        border: '1px solid var(--anil-100)',
        borderRadius: 'var(--r-md)',
        padding: 'var(--s-3) var(--s-4)',
        lineHeight: 1.55,
        fontSize: 14,
        maxWidth: 660,
      }}
    >
      <i className="iconoir-sparks" aria-hidden="true" style={{ marginRight: 'var(--s-2)' }} />
      {text}
    </p>
  )
}

function HeroValueList({ values, className }: { values: HeroValue[]; className?: string }) {
  return (
    <ul
      className={className}
      style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--s-3)' }}
    >
      {values.map((item) => (
        <li
          key={item.label}
          style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'flex-start' }}
        >
          {item.icon ? (
            <i
              className={item.icon}
              aria-hidden="true"
              style={{ color: 'var(--accent)', fontSize: 22, lineHeight: 1, marginTop: 2 }}
            />
          ) : null}
          <span style={{ minWidth: 0 }}>
            <strong style={{ display: 'block', color: 'var(--accent)', fontSize: 20, lineHeight: 1.1 }}>
              {item.value}
            </strong>
            <span
              className="t-small"
              style={{ display: 'block', color: 'var(--fg-muted)', overflowWrap: 'break-word' }}
            >
              {item.label}
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function ProofSection({ config }: { config: SellerAcquisitionPageConfig }) {
  return (
    <section aria-labelledby={`${config.pageId}-proof-title`} style={{ marginBottom: 'var(--s-10)' }}>
      <SectionIntro id={`${config.pageId}-proof-title`} title={config.proofTitle} lead={config.proofLead} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))',
          gap: 'var(--s-3)',
        }}
      >
        {config.proofPoints.map((point) => (
          <article key={point.title} className="card-panel" style={{ padding: 'var(--s-5)' }}>
            <i
              className={point.icon}
              aria-hidden="true"
              style={{ color: 'var(--accent)', fontSize: 28, display: 'block', marginBottom: 'var(--s-4)' }}
            />
            <h3 className="t-h4" style={{ letterSpacing: 0, marginBottom: 'var(--s-2)' }}>
              {point.title}
            </h3>
            <p className="t-small" style={{ color: 'var(--fg-muted)' }}>
              {point.body}
            </p>
          </article>
        ))}
      </div>
    </section>
  )
}

function PersonaRouterSection({
  router,
  pageId,
}: {
  router: NonNullable<SellerAcquisitionPageConfig['personaRouter']>
  pageId: string
}) {
  return (
    <section aria-labelledby={`${pageId}-router-title`} style={{ marginBottom: 'var(--s-10)' }}>
      <SectionIntro id={`${pageId}-router-title`} title={router.title} lead={router.lead} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
          gap: 'var(--s-3)',
        }}
      >
        {router.cards.map((card) => (
          <Link
            key={card.title}
            href={card.href}
            className="card-tile"
            data-testid={card.testId}
            prefetch={false}
            style={{ padding: 'var(--s-5)' }}
          >
            {card.statusLabel ? (
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--s-3)' }}>
                <span className="badge badge-warning">{card.statusLabel}</span>
              </div>
            ) : null}
            <i
              className={card.icon}
              aria-hidden="true"
              style={{ color: 'var(--accent)', fontSize: 30, display: 'block', marginTop: 'var(--s-2)' }}
            />
            <h3 className="t-h4" style={{ letterSpacing: 0, marginTop: 'var(--s-4)', marginBottom: 'var(--s-2)' }}>
              {card.title}
            </h3>
            <p className="t-small" style={{ color: 'var(--fg-muted)' }}>
              {card.body}
            </p>
          </Link>
        ))}
      </div>
    </section>
  )
}

function StepsSection({ config }: { config: SellerAcquisitionPageConfig }) {
  return (
    <section
      aria-labelledby={`${config.pageId}-steps-title`}
      style={{
        display: 'grid',
        gap: 'var(--s-7)',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',
        alignItems: 'start',
        marginBottom: 'var(--s-10)',
      }}
    >
      <div>
        <h2 id={`${config.pageId}-steps-title`} className="t-h2" style={{ letterSpacing: 0, marginBottom: 'var(--s-5)' }}>
          {config.stepsTitle}
        </h2>
        <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 'var(--s-4)' }}>
          {config.steps.map((step, index) => (
            <li
              key={step.title}
              style={{
                display: 'grid',
                gridTemplateColumns: '40px 1fr',
                gap: 'var(--s-3)',
                alignItems: 'start',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 40,
                  height: 40,
                  borderRadius: 'var(--r-pill)',
                  background: 'var(--accent)',
                  color: 'var(--fg-inverse)',
                  fontWeight: 700,
                  fontSize: 14,
                }}
              >
                {index + 1}
              </span>
              <span>
                <strong style={{ display: 'block', color: 'var(--fg)', marginBottom: 'var(--s-1)' }}>
                  {step.title}
                </strong>
                <span className="t-small" style={{ display: 'block', color: 'var(--fg-muted)' }}>
                  {step.body}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </div>

      <aside style={{ display: 'grid', gap: 'var(--s-4)', alignContent: 'start' }}>
        <div>
          <h2 className="t-h3" style={{ color: 'var(--agent)', letterSpacing: 0, marginBottom: 'var(--s-2)' }}>
            {config.agentTitle}
          </h2>
          <p className="t-small" style={{ color: 'var(--fg-muted)' }}>
            {config.agentBody}
          </p>
        </div>
        <PromptBlock
          prompt={config.trustPrompt}
          copyLabel={config.copyLabel}
          copiedLabel={config.copiedLabel}
          testId={`${config.pageId}-steps-prompt-copy`}
        />
      </aside>
    </section>
  )
}

function PremiumFeaturesSection({ features, pageId }: { features: PremiumFeatures; pageId: string }) {
  return (
    <section aria-labelledby={`${pageId}-premium-title`} style={{ marginBottom: 'var(--s-10)' }}>
      <SectionIntro id={`${pageId}-premium-title`} title={features.title} lead={features.lead} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
          gap: 'var(--s-3)',
        }}
      >
        {features.items.map((item) => (
          <article
            key={item.label}
            className="card-panel"
            style={{ padding: 'var(--s-5)', display: 'flex', gap: 'var(--s-3)', alignItems: 'flex-start' }}
          >
            <i
              className={item.icon}
              aria-hidden="true"
              style={{ color: 'var(--accent)', fontSize: 26, lineHeight: 1, flexShrink: 0 }}
            />
            <span style={{ minWidth: 0 }}>
              <strong style={{ display: 'block', color: 'var(--fg)', marginBottom: 'var(--s-1)' }}>
                {item.label}
              </strong>
              <span className="t-small" style={{ display: 'block', color: 'var(--fg-muted)' }}>
                {item.sub}
              </span>
            </span>
          </article>
        ))}
      </div>
    </section>
  )
}

function SocialProofSection({ config }: { config: SellerAcquisitionPageConfig }) {
  return (
    <section aria-labelledby={`${config.pageId}-social-title`} style={{ marginBottom: 'var(--s-10)' }}>
      <div
        className="card-panel"
        style={{
          display: 'grid',
          gap: 'var(--s-5)',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
          padding: 'var(--s-6)',
          background: 'var(--bg-sunk)',
        }}
      >
        <div>
          <h2 id={`${config.pageId}-social-title`} className="t-h2" style={{ letterSpacing: 0, marginBottom: 'var(--s-2)' }}>
            {config.socialTitle}
          </h2>
          <p className="t-lead">{config.socialBody}</p>
        </div>
        <div
          style={{
            display: 'grid',
            gap: 'var(--s-3)',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 130px), 1fr))',
          }}
        >
          {config.socialStats.map((stat) => (
            <div key={stat.label} style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--s-3)' }}>
              <strong style={{ display: 'block', color: 'var(--accent)', fontSize: 26, lineHeight: 1 }}>
                {stat.value}
              </strong>
              <span className="t-caption" style={{ display: 'block', marginTop: 'var(--s-2)' }}>
                {stat.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function FaqSection({ config }: { config: SellerAcquisitionPageConfig }) {
  return (
    <section aria-labelledby={`${config.pageId}-faq-title`} style={{ marginBottom: 'var(--s-10)' }}>
      <h2 id={`${config.pageId}-faq-title`} className="t-h2" style={{ letterSpacing: 0, marginBottom: 'var(--s-5)' }}>
        {config.faqTitle}
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 250px), 1fr))',
          gap: 'var(--s-3)',
        }}
      >
        {config.faqs.map((faq) => (
          <article key={faq.title} className="card-panel" style={{ padding: 'var(--s-5)' }}>
            <h3 className="t-h4" style={{ letterSpacing: 0, marginBottom: 'var(--s-2)' }}>
              {faq.title}
            </h3>
            <p className="t-small" style={{ color: 'var(--fg-muted)' }}>
              {faq.body}
            </p>
          </article>
        ))}
      </div>
    </section>
  )
}

function ClosingCta({ config }: { config: SellerAcquisitionPageConfig }) {
  return (
    <section
      aria-labelledby={`${config.pageId}-closing-title`}
      style={{
        borderTop: '1px solid var(--border)',
        paddingTop: 'var(--s-7)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--s-5)',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <div style={{ maxWidth: 680 }}>
        <h2 id={`${config.pageId}-closing-title`} className="t-h2" style={{ letterSpacing: 0, marginBottom: 'var(--s-2)' }}>
          {config.closingTitle}
        </h2>
        <p className="t-lead">{config.closingBody}</p>
      </div>
      {config.closingCta ? (
        <Link
          href={config.closingCta.href}
          className="btn btn-primary btn-lg"
          data-testid={config.closingCta.testId}
          data-track={config.closingCta.dataTrack}
          prefetch={false}
        >
          {config.closingCta.label}
          <i className="iconoir-arrow-right" aria-hidden="true" />
        </Link>
      ) : null}
    </section>
  )
}

function BenchmarkSection({
  benchmark,
  pageId,
}: {
  benchmark: NonNullable<SellerAcquisitionPageConfig['benchmark']>
  pageId: string
}) {
  const cellBase: CSSProperties = {
    padding: 'var(--s-3)',
    verticalAlign: 'top',
    borderBottom: '1px solid var(--border)',
    textAlign: 'left',
  }

  return (
    <section aria-labelledby={`${pageId}-benchmark-title`} style={{ marginBottom: 'var(--s-10)' }}>
      <SectionIntro id={`${pageId}-benchmark-title`} title={benchmark.title} lead={benchmark.lead} />
      <div
        className="card-panel"
        style={{ padding: 'var(--s-2)', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}
      >
        <table style={{ width: '100%', minWidth: 680, borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr>
              <th scope="col" style={{ ...cellBase, color: 'var(--fg-muted)', fontWeight: 600 }}>
                {benchmark.rowHeader}
              </th>
              {benchmark.columns.map((col, index) => (
                <th
                  key={col}
                  scope="col"
                  style={{
                    ...cellBase,
                    fontWeight: 700,
                    color: index === 0 ? 'var(--accent)' : 'var(--fg)',
                    background: index === 0 ? 'var(--bg-sunk)' : 'transparent',
                  }}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {benchmark.rows.map((row) => (
              <tr key={row.label}>
                <th scope="row" style={{ ...cellBase, color: 'var(--fg)', fontWeight: 600 }}>
                  {row.label}
                </th>
                {row.cells.map((cell, index) =>
                  index === 0 ? (
                    <td key={index} style={{ ...cellBase, color: 'var(--fg)', fontWeight: 600, background: 'var(--bg-sunk)' }}>
                      {cell}
                    </td>
                  ) : (
                    <td key={index} style={{ ...cellBase, color: 'var(--fg-muted)' }}>{cell}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--s-2)',
          alignItems: 'center',
          marginTop: 'var(--s-3)',
        }}
      >
        <span className="badge badge-verified" data-testid={`${pageId}-benchmark-verified`}>
          {benchmark.verifiedLabel}: {benchmark.verified}
        </span>
        <p className="t-caption" style={{ color: 'var(--fg-muted)', margin: 0, flex: '1 1 260px' }}>
          {benchmark.footnote}
        </p>
      </div>
      {benchmark.example ? (
        <BenchmarkExampleBlock example={benchmark.example} pageId={pageId} cellBase={cellBase} />
      ) : null}
    </section>
  )
}

function BenchmarkExampleBlock({
  example,
  pageId,
  cellBase,
}: {
  example: BenchmarkExample
  pageId: string
  cellBase: CSSProperties
}) {
  return (
    <div style={{ marginTop: 'var(--s-7)' }}>
      <h3 className="t-h4" style={{ letterSpacing: 0, marginBottom: 'var(--s-1)' }}>
        {example.title}
      </h3>
      <p className="t-small" style={{ color: 'var(--fg-muted)', marginBottom: 'var(--s-3)' }}>
        {example.lead}
      </p>
      <div
        className="card-panel"
        style={{ padding: 'var(--s-2)', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}
      >
        <table style={{ width: '100%', minWidth: 520, borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr>
              {example.columns.map((col, index) => (
                <th
                  key={col}
                  scope="col"
                  style={{
                    ...cellBase,
                    fontWeight: 700,
                    color: index === 0 ? 'var(--fg)' : 'var(--fg-muted)',
                  }}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {example.rows.map((row, index) => (
              <tr key={row.platform}>
                <th
                  scope="row"
                  style={{
                    ...cellBase,
                    fontWeight: 600,
                    color: index === 0 ? 'var(--accent)' : 'var(--fg)',
                    background: index === 0 ? 'var(--bg-sunk)' : 'transparent',
                  }}
                >
                  {row.platform}
                </th>
                <td style={{ ...cellBase, color: 'var(--fg-muted)' }}>{row.commission}</td>
                <td style={{ ...cellBase, color: 'var(--fg-muted)' }}>{row.monthly}</td>
                <td
                  style={{
                    ...cellBase,
                    fontWeight: 600,
                    color: index === 0 ? 'var(--accent)' : 'var(--fg)',
                    background: index === 0 ? 'var(--bg-sunk)' : 'transparent',
                  }}
                >
                  {row.takeHome}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p
        data-testid={`${pageId}-benchmark-example-punchline`}
        style={{
          margin: 'var(--s-3) 0 0',
          color: 'var(--agent)',
          background: 'var(--agent-soft)',
          borderLeft: '4px solid var(--agent)',
          borderRadius: 'var(--r-md)',
          padding: 'var(--s-3) var(--s-4)',
          fontSize: 14,
          lineHeight: 1.55,
        }}
      >
        {example.punchline}
      </p>
      <ol
        style={{
          margin: 'var(--s-3) 0 0',
          paddingLeft: 'var(--s-5)',
          display: 'grid',
          gap: 'var(--s-1)',
        }}
      >
        {example.footnotes.map((note, index) => (
          <li key={index} className="t-caption" style={{ color: 'var(--fg-muted)' }}>
            {note}
          </li>
        ))}
      </ol>
    </div>
  )
}

function AiChannelSection({
  aiChannel,
  pageId,
}: {
  aiChannel: NonNullable<SellerAcquisitionPageConfig['aiChannel']>
  pageId: string
}) {
  return (
    <section
      aria-labelledby={`${pageId}-ai-channel-title`}
      className="card-panel"
      style={{ padding: 'var(--s-6)', background: 'var(--bg-sunk)', marginBottom: 'var(--s-10)' }}
    >
      <span className="badge badge-agent" style={{ marginBottom: 'var(--s-4)' }}>
        <i className="iconoir-sparks" aria-hidden="true" style={{ marginRight: 'var(--s-2)' }} />
        {aiChannel.eyebrow}
      </span>
      <h2
        id={`${pageId}-ai-channel-title`}
        className="t-h2"
        style={{ letterSpacing: 0, marginBottom: 'var(--s-3)', maxWidth: 680 }}
      >
        {aiChannel.title}
      </h2>
      <p className="t-lead" style={{ maxWidth: 680, marginBottom: 'var(--s-6)' }}>
        {aiChannel.body}
      </p>
      <ol
        style={{
          margin: 0,
          marginBottom: 'var(--s-5)',
          padding: 0,
          listStyle: 'none',
          display: 'grid',
          gap: 'var(--s-3)',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
        }}
      >
        {aiChannel.steps.map((step, index) => (
          <li key={step.title} className="card-panel" style={{ padding: 'var(--s-5)' }}>
            <span
              aria-hidden="true"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 32,
                height: 32,
                borderRadius: 'var(--r-pill)',
                background: 'var(--accent)',
                color: 'var(--fg-inverse)',
                fontWeight: 700,
                fontSize: 13,
                marginBottom: 'var(--s-3)',
              }}
            >
              {index + 1}
            </span>
            <strong style={{ display: 'block', color: 'var(--fg)', marginBottom: 'var(--s-1)' }}>
              {step.title}
            </strong>
            <span className="t-small" style={{ display: 'block', color: 'var(--fg-muted)' }}>
              {step.body}
            </span>
          </li>
        ))}
      </ol>
      <p
        className="t-small"
        style={{
          margin: 0,
          color: 'var(--agent)',
          background: 'var(--agent-soft)',
          borderLeft: '4px solid var(--agent)',
          borderRadius: 'var(--r-md)',
          padding: 'var(--s-3) var(--s-4)',
        }}
      >
        {aiChannel.note}
      </p>
    </section>
  )
}

function SectionIntro({ id, title, lead }: { id: string; title: string; lead: string }) {
  return (
    <div style={{ maxWidth: 700, marginBottom: 'var(--s-5)' }}>
      <h2 id={id} className="t-h2" style={{ letterSpacing: 0, marginBottom: 'var(--s-2)' }}>
        {title}
      </h2>
      <p className="t-lead">{lead}</p>
    </div>
  )
}
