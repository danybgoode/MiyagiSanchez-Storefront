import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import es from '@/locales/es.json'
import Link from 'next/link'
import { sellerLandingPath } from '@/lib/seller-acquisition'
import { getOverriddenDictionary } from '@/lib/copy-overrides'
import { isEnabled } from '@/lib/flags'
import { decideFundadorasGateState } from '@/lib/fundadoras-application'
import { readFundadorasCapacityUsed } from '@/lib/fundadoras-application-server'
import { sendGrowthEvent } from '@/lib/growth-engine'
import {
  FUNDADORAS_EXPERIMENT_ASSIGNMENT_ENTITY_TYPE,
  FUNDADORAS_EXPERIMENT_DEFINITION_VERSION,
  FUNDADORAS_EXPERIMENT_KEY,
  FUNDADORAS_VISITOR_COOKIE_NAME,
  isFundadorasVisitorSubjectId,
  resolveFundadorasExperimentVariant,
} from '@/lib/fundadoras-experiment'
import { FundadorasApplicationForm } from './_components/FundadorasApplicationForm'

const BASE_URL = 'https://miyagisanchez.com'
const PAGE_PATH = '/mx/vende/fundadoras'

const meta = es.sellerAcquisition.fundadoras.metadata

export const metadata: Metadata = {
  title: meta.title,
  description: meta.description,
  alternates: { canonical: `${BASE_URL}${PAGE_PATH}` },
  openGraph: {
    type: 'website',
    locale: 'es_MX',
    url: `${BASE_URL}${PAGE_PATH}`,
    siteName: 'Miyagi Sánchez',
    title: meta.title,
    description: meta.description,
  },
  twitter: { card: 'summary_large_image', title: meta.title, description: meta.description },
}

// Reads the live flag + canonical capacity to pick the closed/full/open state —
// never statically generated (a stale build could show an open form for a closed
// or full cohort).
export const dynamic = 'force-dynamic'

export default async function FundadorasPage() {
  const ui = (await getOverriddenDictionary('es')).sellerAcquisition.fundadoras

  const cookieStore = await cookies()
  const cookieSubject = cookieStore.get(FUNDADORAS_VISITOR_COOKIE_NAME)?.value ?? null
  const visitorSubjectId = cookieSubject && isFundadorasVisitorSubjectId(cookieSubject) ? cookieSubject : null

  const [flagEnabled, capacityUsed, telemetryEnabled] = await Promise.all([
    isEnabled('growth.founding_merchants_enabled'),
    readFundadorasCapacityUsed(),
    isEnabled('growth.telemetry_enabled'),
  ])
  // A capacity-read failure fails CLOSED (treated as full) — the page never
  // invites an application it can't verify there is still room for.
  const gate = decideFundadorasGateState(flagEnabled, capacityUsed ?? Number.MAX_SAFE_INTEGER)
  const variant = flagEnabled && visitorSubjectId
    ? resolveFundadorasExperimentVariant(visitorSubjectId)
    : null
  const experimentCopy = variant ? ui.experimentVariants[variant] : null

  // This is deliberately independent from rendering: a growth destination
  // failure must never block the page or alter its assigned copy.
  if (flagEnabled && telemetryEnabled && visitorSubjectId && variant) {
    sendGrowthEvent({
      userId: visitorSubjectId,
      event: 'experiment_exposed',
      featureId: FUNDADORAS_EXPERIMENT_KEY,
      tags: { variant, experiment_definition_version: FUNDADORAS_EXPERIMENT_DEFINITION_VERSION },
      context: {
        version: 1,
        subject: { type: FUNDADORAS_EXPERIMENT_ASSIGNMENT_ENTITY_TYPE, id: visitorSubjectId },
      },
    }).catch((error) => console.error('[fundadoras-page] growth exposure emit failed:', error))
  }

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: meta.title,
    description: meta.description,
    url: `${BASE_URL}${PAGE_PATH}`,
    inLanguage: 'es-MX',
    isPartOf: { '@type': 'WebSite', name: 'Miyagi Sánchez', url: BASE_URL },
  }

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
        {/* Hero — one promise, one constraint, one CTA. */}
        <header className="flex flex-col gap-4">
          <span className="badge badge-warning w-fit">{ui.eyebrow}</span>
          <h1 className="t-h1">{experimentCopy?.heroTitle ?? ui.heroTitle}</h1>
          <p className="t-lead" style={{ maxWidth: 640 }}>
            {experimentCopy?.heroLead ?? ui.heroLead}
          </p>
          {gate === 'open' && (
            <a href="#aplicar" className="btn btn-primary btn-lg w-fit">
              {experimentCopy?.primaryCta ?? ui.primaryCta}
              <i className="iconoir-arrow-right" aria-hidden />
            </a>
          )}
        </header>

        {/* Closed / full states replace the whole invitation (Story 1.3). */}
        {gate !== 'open' ? (
          <section className="card-panel mt-8 flex flex-col gap-3" aria-live="polite">
            <h2 className="t-h2">{gate === 'closed' ? ui.closed.title : ui.full.title}</h2>
            <p>{gate === 'closed' ? ui.closed.body : ui.full.body}</p>
            <Link href={sellerLandingPath('mx')} className="btn btn-secondary w-fit">
              {gate === 'closed' ? ui.closed.cta : ui.full.cta}
            </Link>
          </section>
        ) : (
          <>
            {/* Proof — what the cohort includes. */}
            <section className="mt-12 flex flex-col gap-4" aria-labelledby="fundadoras-proof">
              <h2 id="fundadoras-proof" className="t-h2">
                {ui.proofTitle}
              </h2>
              <p className="t-lead">{ui.proofLead}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                {ui.proofPoints.map((point) => (
                  <div key={point.title} className="card-panel flex flex-col gap-2">
                    <i className={`${point.icon} text-2xl`} aria-hidden />
                    <h3 className="font-semibold">{point.title}</h3>
                    <p className="text-sm">{point.body}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Steps — how it works. */}
            <section className="mt-12 flex flex-col gap-4" aria-labelledby="fundadoras-steps">
              <h2 id="fundadoras-steps" className="t-h2">
                {ui.stepsTitle}
              </h2>
              <ol className="flex flex-col gap-4">
                {ui.steps.map((step, i) => (
                  <li key={step.title} className="card-panel flex gap-4">
                    <span className="badge badge-verified h-fit">{i + 1}</span>
                    <div className="flex flex-col gap-1">
                      <h3 className="font-semibold">{step.title}</h3>
                      <p className="text-sm">{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            {/* Application — the client island (consent + opaque-id events). */}
            <section id="aplicar" className="mt-12 flex flex-col gap-4" aria-labelledby="fundadoras-apply">
              <h2 id="fundadoras-apply" className="t-h2">
                {ui.apply.title}
              </h2>
              <p>{ui.apply.body}</p>
              <FundadorasApplicationForm copy={ui.apply.form} visitorSubjectId={visitorSubjectId} />
            </section>
          </>
        )}
      </div>
    </>
  )
}
