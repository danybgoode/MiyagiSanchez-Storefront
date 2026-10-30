import type { Dictionary } from '@/lib/dictionary'
import type { SellerAcquisitionPageConfig } from '@/app/(shell)/mx/vende/_components/SellerAcquisitionSections'
import { MX_SELLER_PAGES_BASE } from '@/lib/seller-acquisition'

export type OperatorLandingCopy = Dictionary['partnersRecruiting']['landing']

/** The `id` the hero + closing CTAs anchor to, and the section the application renders into. */
export const OPERATOR_APPLY_ID = 'operators-apply'

/** `data-seller-persona` / section-id prefix — also the prefix of every generated test id. */
export const OPERATOR_PAGE_ID = 'us-operators'

/**
 * Map the US operator copy onto the shared seller-acquisition config.
 *
 * `/us/operators` used to be a bespoke editorial layout that shared nothing with the
 * rest of the site: its own type scale, its own section rhythm, its own hero. Rendering
 * it through `SellerAcquisitionPage` is what makes it look like Miyagi Sánchez — and it
 * comes with the prompt block, the comparison table and the FAQ rail for free.
 *
 * Pure: copy in, config out, no I/O. The page owns the flag gate and the dictionary read.
 */
export function buildUsOperatorPageConfig(copy: OperatorLandingCopy): SellerAcquisitionPageConfig {
  return {
    pageId: OPERATOR_PAGE_ID,
    variant: 'a',
    eyebrow: copy.eyebrow,
    title: copy.heroTitle,
    lead: copy.heroLead,
    trustLine: copy.trustLine,
    // Unlike the /vende family this prompt is dictionary copy, not `buildAgentPrompt()`:
    // that builder is es-MX only and this page's default locale is English.
    trustPrompt: copy.trustPrompt,
    copyLabel: copy.copyPrompt,
    copiedLabel: copy.copiedPrompt,
    primaryCta: {
      label: copy.primaryCta,
      href: `#${OPERATOR_APPLY_ID}`,
      testId: 'operator-primary-cta',
      dataTrack: 'founding_operator',
    },
    // The cross-market link keeps its recruiting track — a visitor who came here but
    // actually works in Mexico is a Promotor lead, and the funnel should record that.
    secondaryCta: {
      label: copy.promotorCta,
      href: `${MX_SELLER_PAGES_BASE}/promotor`,
      testId: 'promotor-secondary-cta',
      dataTrack: 'promoter',
    },
    heroStats: copy.heroStats,
    proofTitle: copy.proofTitle,
    proofLead: copy.proofLead,
    proofPoints: copy.proofPoints,
    benchmark: copy.benchmark,
    stepsTitle: copy.stepsTitle,
    steps: copy.steps,
    agentTitle: copy.selfCheckTitle,
    agentBody: copy.selfCheckBody,
    socialTitle: copy.pitchTitle,
    socialBody: copy.pitchBody,
    socialStats: copy.pitchStats,
    faqTitle: copy.faqTitle,
    faqs: copy.faqs,
    closingTitle: copy.closingTitle,
    closingBody: copy.closingBody,
    closingCta: {
      label: copy.closingCta,
      href: `#${OPERATOR_APPLY_ID}`,
      testId: 'operator-closing-cta',
      dataTrack: 'founding_operator',
    },
    applyTeaser: { id: OPERATOR_APPLY_ID, title: copy.applyTitle, body: copy.applyBody },
  }
}
