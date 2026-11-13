import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { recruitingV3Enabled } from '@/lib/recruiting-v3'
import { coarseRecruitingSource } from '@/lib/recruiting-source'
import { getOverriddenDictionary } from '@/lib/copy-overrides'
import { SellerAcquisitionPage } from '@/app/(shell)/mx/vende/_components/SellerAcquisitionSections'
import { buildUsOperatorPageConfig } from './page-config'
import { OperatorApplication } from './OperatorApplication'

/**
 * Operator recruiting lives at `/us/operators`, NOT at `/us`.
 *
 * It used to be a flag gate on `/us` itself, sharing that URL with a legacy
 * "private pilot" page. The US marketplace epic opened `/us` as a real
 * marketplace home and that legacy page became false — the marketplace IS open.
 * Recruiting is a separate product with a separate audience, so it moved to its
 * own route rather than contending for the market root: flipping the recruiting
 * flag must never close the marketplace.
 *
 * The page renders through the shared `SellerAcquisitionPage` shell, the same one
 * `/vende/promotor` uses — this is the same field-operator program, told to a US
 * audience in English, so it should look and read like its Mexican sibling rather
 * than like the bespoke editorial layout it carried before.
 */
export const metadata: Metadata = {
  title: { absolute: 'Miyagi Operators — open stores, close in person, keep the commission' },
  description:
    'Open online stores for the businesses on your street, take payment in person, and keep your commission. No monthly fee and no sales commission for the merchant, ever.',
  robots: { index: false, follow: false },
}

// The production authority is runtime Golden Beans; never freeze the OFF default
// into a static build artifact or a later cohort flip would have no effect.
export const dynamic = 'force-dynamic'

export default async function UnitedStatesOperatorsPage({ searchParams }: { searchParams: Promise<{ source?: string | string[]; lang?: string | string[] }> }) {
  const query = await searchParams
  const source = coarseRecruitingSource(query.source)
  const locale: 'en' | 'es' = query.lang === 'es' ? 'es' : 'en'
  if (!(await recruitingV3Enabled())) notFound()
  // Read through the override layer, like `/vende/promotor` does: `partnersRecruiting` is
  // already offered as editable in `/admin/contenido`, and reading the raw dictionary here
  // meant those edits changed nothing on the page they name.
  const copy = (await getOverriddenDictionary(locale)).partnersRecruiting
  const languageHref = `/us/operators?lang=${locale === 'en' ? 'es' : 'en'}${source === 'direct' ? '' : `&source=${source}`}`

  const config = buildUsOperatorPageConfig(copy.landing)
  config.applyTeaser = { ...config.applyTeaser!, form: <OperatorApplication source={source} copy={copy.application} /> }

  return (
    <div data-testid="us-partners-recruiting">
      <div className="app-shell" style={{ paddingTop: 'var(--s-5)', display: 'flex', justifyContent: 'flex-end' }}>
        <Link href={languageHref} className="t-caption" style={{ textDecoration: 'underline' }} prefetch={false}>
          {copy.landing.switchLanguage}
        </Link>
      </div>
      <SellerAcquisitionPage config={config} />
    </div>
  )
}
