import Link from 'next/link'
import {
  ABOUT_CTA_HREF,
  ABOUT_SELLERS_HREF,
  aboutCopy,
  type AboutLocale,
  type AboutPageCopy,
  type AboutSection,
} from '@/lib/about-content'
import { CONTACT_EMAIL, contactMailto } from '@/lib/contact'

/**
 * Human-facing `/acerca` page, rendered from the admin-overridden content
 * (`lib/about-content-overrides.ts`, fetched by the parent `page.tsx` and passed in as
 * `page`/`sections` props) so an admin edit in `/admin/contenido` shows up here.
 * Reuses the #4 design tokens + the #6 (`/vende`) section idiom — semantic HTML, token-only
 * styling (no raw hex), agent-fetchable text.
 */
export function AboutPage({
  locale,
  page,
  sections,
}: {
  locale: AboutLocale
  page: AboutPageCopy
  sections: AboutSection[]
}) {
  const langToggleHref = locale === 'es' ? '/acerca?lang=en' : '/acerca'

  return (
    <main
      className="app-shell"
      data-locale={locale}
      style={{ paddingTop: 'var(--s-8)', paddingBottom: 'var(--s-10)' }}
    >
      <header style={{ maxWidth: 'var(--measure-prose)', marginBottom: 'var(--s-9)' }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--s-3)',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 'var(--s-4)',
          }}
        >
          <span className="badge badge-agent">{page.eyebrow}</span>
          <Link
            href={langToggleHref}
            className="btn btn-secondary"
            data-testid="acerca-lang-toggle"
            prefetch={false}
          >
            {page.langToggleLabel}
          </Link>
        </div>
        <h1
          className="t-h1"
          style={{
            fontSize: 'clamp(var(--t-2xl), 7vw, var(--t-4xl))',
            letterSpacing: 0,
            marginBottom: 'var(--s-4)',
            overflowWrap: 'break-word',
          }}
        >
          {page.title}
        </h1>
        <p className="t-lead" style={{ marginBottom: 'var(--s-5)' }}>
          {page.lead}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-3)', alignItems: 'center' }}>
          <Link
            href={ABOUT_CTA_HREF}
            className="btn btn-primary btn-lg"
            data-testid="acerca-primary-cta"
            prefetch={false}
          >
            {page.primaryCtaLabel}
            <i className="iconoir-arrow-right" aria-hidden="true" />
          </Link>
          <Link href={ABOUT_SELLERS_HREF} className="btn btn-secondary btn-lg" prefetch={false}>
            {page.secondaryCtaLabel}
          </Link>
        </div>
      </header>

      <div style={{ display: 'grid', gap: 'var(--s-9)' }}>
        {sections.map((section) => (
          <AboutSectionBlock
            key={section.id}
            section={section}
            locale={locale}
            stubBadge={page.stubBadge}
            pricingLinkLabel={page.pricingLinkLabel}
          />
        ))}
      </div>

      <ClosingCta page={page} />
    </main>
  )
}

function AboutSectionBlock({
  section,
  locale,
  stubBadge,
  pricingLinkLabel,
}: {
  section: AboutSection
  locale: AboutLocale
  stubBadge: string
  pricingLinkLabel: string
}) {
  const copy = aboutCopy(section, locale)
  const titleId = `acerca-${section.id}-title`

  return (
    <section aria-labelledby={titleId}>
      <div style={{ maxWidth: 'var(--measure-prose)', marginBottom: copy.points?.length ? 'var(--s-5)' : 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--s-3)', marginBottom: 'var(--s-2)' }}>
          <h2 id={titleId} className="t-h2" style={{ letterSpacing: 0, margin: 0 }}>
            {copy.heading}
          </h2>
          {section.stub ? (
            <span className="badge badge-warning" data-testid={`acerca-stub-${section.id}`}>
              {stubBadge}
            </span>
          ) : null}
        </div>
        {copy.lead ? <p className="t-lead" style={{ marginBottom: 'var(--s-3)' }}>{copy.lead}</p> : null}
        {copy.body.map((paragraph, index) => (
          <p key={index} className="t-small" style={{ color: 'var(--fg-muted)', marginBottom: 'var(--s-2)' }}>
            {paragraph}
          </p>
        ))}
        {section.id === 'pricing' ? (
          // pricing-page D7 — every price, with its source, lives on /mx/precios.
          <Link href="/mx/precios" className="btn btn-secondary" data-testid="acerca-pricing-link" prefetch={false}>
            {pricingLinkLabel}
            <i className="iconoir-arrow-right" aria-hidden="true" />
          </Link>
        ) : null}
      </div>

      {copy.points?.length ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 230px), 1fr))',
            gap: 'var(--s-3)',
          }}
        >
          {copy.points.map((point) => (
            <article key={point.title} className="card-panel" style={{ padding: 'var(--s-5)' }}>
              {point.icon ? (
                <i
                  className={point.icon}
                  aria-hidden="true"
                  style={{ color: 'var(--accent)', fontSize: 28, display: 'block', marginBottom: 'var(--s-4)' }}
                />
              ) : null}
              <h3 className="t-h4" style={{ letterSpacing: 0, marginBottom: 'var(--s-2)' }}>
                {point.title}
              </h3>
              <p className="t-small" style={{ color: 'var(--fg-muted)', margin: 0 }}>
                {point.body}
              </p>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function ClosingCta({ page }: { page: AboutPageCopy }) {
  return (
    <section
      aria-label={page.primaryCtaLabel}
      style={{
        marginTop: 'var(--s-9)',
        borderTop: '1px solid var(--border)',
        paddingTop: 'var(--s-7)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--s-4)',
        alignItems: 'center',
      }}
    >
      <Link href={ABOUT_CTA_HREF} className="btn btn-primary btn-lg" prefetch={false}>
        {page.primaryCtaLabel}
        <i className="iconoir-arrow-right" aria-hidden="true" />
      </Link>
      <Link href={ABOUT_SELLERS_HREF} className="btn btn-secondary btn-lg" prefetch={false}>
        {page.secondaryCtaLabel}
      </Link>
      {/* The ADDRESS is not a dictionary key: it is a FACT about the platform and
          it lives in `lib/contact.ts` beside the email transport's Reply-To so
          the two can never disagree.
          The WORDS around it now come from the about-page model, which is what
          `?lang=en` switches. They used to be fixed es-MX with a comment saying
          this line was "deliberately not part of" that model — but the page HAS
          an English toggle, so the result was a Spanish sentence on the English
          page. Found by widening the buyer-copy scan to the owned-host root
          routes (Living Shop, epic 07): the file had been outside the scanned
          roots, so nothing had ever checked it. */}
      <p className="t-small" style={{ color: 'var(--fg-muted)', margin: 0, width: '100%' }}>
        {page.contactPrompt}{' '}
        <a href={contactMailto('Acerca de Miyagi Sánchez')} style={{ color: 'var(--accent)' }}>
          {CONTACT_EMAIL}
        </a>
        .
      </p>
    </section>
  )
}
