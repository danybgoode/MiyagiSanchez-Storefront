import type { Dictionary } from '@/lib/dictionary'
import {
  resolveSellerPersonaRoute,
  resolveSellerAcquisitionVariant,
  sellerPersonaCtaHref,
  sellerPersonaRouterHref,
  usSellerCtaHref,
  sellerTrustPrompt,
  type SellerAcquisitionVariant,
  type SellerPersonaId,
} from '@/lib/seller-acquisition'
import { buildAgentPrompt } from '@/lib/agent-prompt'
import type { PromoterSettings } from '@/lib/promoter'
import type { PromoterSku } from '@/lib/promoter-skus'
import {
  buildPromoterEarningsTable,
  buildPromoterEarningsExample,
  promoterHeroCommissionStat,
  PROMOTER_SKU_BASE_PRICE_MXN,
  type PromoterSkuEarnings,
} from '@/lib/promoter-earnings'
import { buildSkuPriceTable, computeBundleRow, type PromoterSkuPrices } from '@/lib/promoter-pricing'
import { SUBDOMAIN_PRICE_YEARLY_MXN } from '@/lib/subdomain-pricing'
import { fillFixedPricingTokens } from '@/lib/pricing-catalog'
import type { SellerAcquisitionPageConfig, LandingCallout } from './SellerAcquisitionSections'

type QueryParams = Record<string, string | string[] | undefined | null>
type SellerAcquisitionCopy = Dictionary['sellerAcquisition']
type AnchorCopy = SellerAcquisitionCopy['anchor']
type CreatorCopy = SellerAcquisitionCopy['creadores']
type LocalBusinessCopy = SellerAcquisitionCopy['negocios']
type ServicesCopy = SellerAcquisitionCopy['servicios']
type AutosCopy = SellerAcquisitionCopy['autos']
type MigracionShopifyCopy = SellerAcquisitionCopy['migracionShopify']
type MigracionTiendanubeCopy = SellerAcquisitionCopy['migracionTiendanube']
type MigracionWoocommerceCopy = SellerAcquisitionCopy['migracionWoocommerce']
type MigracionBigcartelCopy = SellerAcquisitionCopy['migracionBigcartel']
type MigracionPlatformCopy =
  | MigracionShopifyCopy
  | MigracionTiendanubeCopy
  | MigracionWoocommerceCopy
  | MigracionBigcartelCopy
type VariantCapablePage = {
  heroTitle: string
  primaryCta: string
  closingCta: string
  variants?: Partial<Record<SellerAcquisitionVariant, Partial<{
    heroTitle: string
    primaryCta: string
    closingCta: string
  }>>>
}

export function buildAnchorPageConfig(
  copy: SellerAcquisitionCopy,
  query: QueryParams,
): SellerAcquisitionPageConfig {
  const page = copy.anchor

  return {
    ...baseConfig(copy, page, 'vende', query),
    pageId: 'vende',
    // Anchor hero leads with the shared launch trust line (+ "copia el prompt", paired with the visible
    // PromptBlock); personas keep their own per-page trust line. Anchor leads its right panel with the
    // value list (0% · IA · Premium); personas keep their stats.
    trustLine: copy.shared.heroTrustLine,
    heroValues: page.heroValues,
    secondaryCta: {
      label: page.secondaryCta,
      // "¿Qué puedo vender?" jumps to the on-page persona router (which answers exactly that).
      href: '#vende-router-title',
    },
    // Benchmark (with its worked example) + AI-channel + premium-features grid are anchor-only
    // sections; persona builders leave them undefined.
    benchmark: page.benchmark,
    aiChannel: copy.aiChannel,
    // Anchor replaces its social-proof stats block with the premium-features grid.
    premiumFeatures: page.premiumFeatures,
    // pricing-page D10 — a link to /mx/precios in the sections, never the hero (prompt-to-shop owns it).
    pricingCallout: {
      title: copy.shared.pricingCallout.title,
      body: copy.shared.pricingCallout.body,
      cta: { label: copy.shared.pricingCallout.ctaLabel, href: '/mx/precios', testId: 'vende-pricing-callout' },
    },
    personaRouter: {
      title: page.routerTitle,
      lead: page.routerLead,
      cards: page.routerCards.map((card) => {
        const personaId = card.personaId as SellerPersonaId
        const route = resolveSellerPersonaRoute(personaId)
        return {
          eyebrow: card.eyebrow,
          title: card.title,
          body: card.body,
          icon: card.icon,
          href: sellerPersonaRouterHref(personaId, query),
          statusLabel: card.statusLabel || (route.status === 'upcoming' ? card.statusLabel : undefined),
          testId: `vende-router-${personaId}`,
        }
      }),
    },
  }
}

export function buildCreatorPageConfig(
  copy: SellerAcquisitionCopy,
  query: QueryParams,
): SellerAcquisitionPageConfig {
  const page = copy.creadores

  return {
    ...baseConfig(copy, page, 'creadores', query),
    pageId: 'creadores',
    secondaryCta: {
      label: page.secondaryCta,
      href: sellerPersonaRouterHref('vende', query),
    },
  }
}

// Platform-migrations epic (03) · Sprint 3 (US-3.2) — negocios/servicios are the personas
// most likely to already run a shop elsewhere, so they get the compact migration nudge;
// the other archetype pages (creadores, mundial, autos) leave it undefined.
function migracionCallout(copy: SellerAcquisitionCopy, testId: string): LandingCallout {
  const callout = copy.shared.migrationCallout
  return {
    title: callout.title,
    body: callout.body,
    cta: { label: callout.ctaLabel, href: '/mx/vende/migracion', testId },
  }
}

export function buildLocalBusinessPageConfig(
  copy: SellerAcquisitionCopy,
  query: QueryParams,
): SellerAcquisitionPageConfig {
  const page = copy.negocios

  return {
    ...baseConfig(copy, page, 'negocios', query),
    pageId: 'negocios',
    secondaryCta: {
      label: page.secondaryCta,
      href: sellerPersonaRouterHref('vende', query),
    },
    migrationCallout: migracionCallout(copy, 'negocios-migration-callout'),
  }
}

export function buildServicesPageConfig(
  copy: SellerAcquisitionCopy,
  query: QueryParams,
): SellerAcquisitionPageConfig {
  const page = copy.servicios

  return {
    ...baseConfig(copy, page, 'servicios', query),
    pageId: 'servicios',
    migrationCallout: migracionCallout(copy, 'servicios-migration-callout'),
    secondaryCta: {
      label: page.secondaryCta,
      href: sellerPersonaRouterHref('vende', query),
    },
  }
}

export function buildAutosPageConfig(
  copy: SellerAcquisitionCopy,
  query: QueryParams,
): SellerAcquisitionPageConfig {
  const page = copy.autos

  return {
    ...baseConfig(copy, page, 'autos', query),
    pageId: 'autos',
    // Unlike the archetype personas (negocios/servicios), the secondary CTA here points at a
    // real, already-live proof — the autos facet browse (cars-vertical-tratocar-parity S1/S2)
    // — instead of routing back into the generic persona picker.
    secondaryCta: {
      label: page.secondaryCta,
      href: '/l?category=autos',
    },
  }
}

/**
 * Platform-migrations epic (03) · Sprint 3 (US-3.1). Standalone content pages — like
 * `/mx/vende/promotor`, they don't sell a seller "archetype" so they deliberately do NOT
 * register as `SellerPersonaId`s. Hrefs are plain strings into the real, already-shipped
 * flows (the Shopify connector, the CSV/paste importer) rather than `sellerPersonaCtaHref`.
 */
type MigracionPlatformSlug = 'shopify' | 'tiendanube' | 'woocommerce' | 'bigcartel'

const MIGRACION_PLATFORM_PATHS: Record<MigracionPlatformSlug, string> = {
  shopify: '/mx/vende/migracion/shopify',
  tiendanube: '/mx/vende/migracion/tiendanube',
  woocommerce: '/mx/vende/migracion/woocommerce',
  bigcartel: '/mx/vende/migracion/bigcartel',
}

function isMigracionPlatformSlug(slug: string): slug is MigracionPlatformSlug {
  return Object.prototype.hasOwnProperty.call(MIGRACION_PLATFORM_PATHS, slug)
}

export function buildMigracionHubPageConfig(
  copy: SellerAcquisitionCopy,
  opts: { migrationPriceMxn?: number | null } = {},
): SellerAcquisitionPageConfig {
  const page = copy.migracion
  const migrationPriceMxn = opts.migrationPriceMxn ?? null

  return {
    pageId: 'migracion',
    variant: 'a',
    eyebrow: page.eyebrow,
    title: page.heroTitle,
    lead: page.heroLead,
    trustLine: page.trustLine,
    trustPrompt: copy.shared.trustPrompt.replaceAll('{url}', 'https://miyagisanchez.com/mx/vende/migracion'),
    copyLabel: copy.shared.copyPrompt,
    copiedLabel: copy.shared.copiedPrompt,
    primaryCta: { label: page.primaryCta, href: '/shop/manage/import', testId: 'migracion-primary-cta' },
    secondaryCta: { label: page.secondaryCta, href: '/mx/vende/promotor' },
    // Degrades to the plain hero stats until an admin has configured the migration SKU
    // price (Story 2.1) — never a fabricated/hardcoded number.
    heroStats: migrationPriceMxn != null
      ? [...page.heroStats, { value: `$${migrationPriceMxn}`, label: 'consultor si prefieres que alguien lo haga' }]
      : page.heroStats,
    proofTitle: page.proofTitle,
    proofLead: page.proofLead,
    proofPoints: page.proofPoints,
    personaRouter: {
      title: page.routerTitle,
      lead: page.routerLead,
      cards: page.routerCards.map((card) => ({
        eyebrow: card.eyebrow,
        title: card.title,
        body: card.body,
        icon: card.icon,
        // `card.slug` ultimately comes from admin-editable copy overrides
        // (getOverriddenDictionary), not just the static JSON — a bad/typo'd
        // slug must degrade to the always-valid hub link, never a silent
        // `href={undefined}` (caught in cross-review of this PR).
        href: isMigracionPlatformSlug(card.slug) ? MIGRACION_PLATFORM_PATHS[card.slug] : '/mx/vende/migracion',
        testId: `migracion-router-${card.slug}`,
      })),
    },
    stepsTitle: page.stepsTitle,
    steps: page.steps,
    agentTitle: copy.shared.selfCheck.title,
    agentBody: copy.shared.selfCheck.body,
    socialTitle: page.socialTitle,
    socialBody: page.socialBody,
    socialStats: page.socialStats,
    faqTitle: copy.shared.faqTitle,
    faqs: copy.shared.faqs,
    closingTitle: page.closingTitle,
    closingBody: page.closingBody,
    closingCta: { label: page.closingCta, href: '/shop/manage/import', testId: 'migracion-closing-cta' },
  }
}

function buildMigracionPlatformPageConfig(
  copy: SellerAcquisitionCopy,
  page: MigracionPlatformCopy,
  pageId: 'migracion-shopify' | 'migracion-tiendanube' | 'migracion-woocommerce' | 'migracion-bigcartel',
  pagePath: string,
  primaryHref: string,
): SellerAcquisitionPageConfig {
  return {
    pageId,
    variant: 'a',
    eyebrow: page.eyebrow,
    title: page.heroTitle,
    lead: page.heroLead,
    trustLine: page.trustLine,
    trustPrompt: copy.shared.trustPrompt.replaceAll('{url}', `https://miyagisanchez.com${pagePath}`),
    copyLabel: copy.shared.copyPrompt,
    copiedLabel: copy.shared.copiedPrompt,
    primaryCta: { label: page.primaryCta, href: primaryHref, testId: `${pageId}-primary-cta` },
    secondaryCta: { label: page.secondaryCta, href: '/mx/vende/migracion' },
    heroStats: page.heroStats,
    proofTitle: page.proofTitle,
    proofLead: page.proofLead,
    proofPoints: page.proofPoints,
    stepsTitle: page.stepsTitle,
    steps: page.steps,
    agentTitle: copy.shared.selfCheck.title,
    agentBody: copy.shared.selfCheck.body,
    socialTitle: page.socialTitle,
    socialBody: page.socialBody,
    socialStats: page.socialStats,
    faqTitle: copy.shared.faqTitle,
    faqs: copy.shared.faqs,
    closingTitle: page.closingTitle,
    closingBody: page.closingBody,
    closingCta: { label: page.closingCta, href: primaryHref, testId: `${pageId}-closing-cta` },
  }
}

export function buildMigracionShopifyPageConfig(copy: SellerAcquisitionCopy): SellerAcquisitionPageConfig {
  return buildMigracionPlatformPageConfig(copy, copy.migracionShopify, 'migracion-shopify', '/mx/vende/migracion/shopify', '/shop/manage/shopify/import')
}

export function buildMigracionTiendanubePageConfig(copy: SellerAcquisitionCopy): SellerAcquisitionPageConfig {
  return buildMigracionPlatformPageConfig(copy, copy.migracionTiendanube, 'migracion-tiendanube', '/mx/vende/migracion/tiendanube', '/shop/manage/import')
}

export function buildMigracionWoocommercePageConfig(copy: SellerAcquisitionCopy): SellerAcquisitionPageConfig {
  return buildMigracionPlatformPageConfig(copy, copy.migracionWoocommerce, 'migracion-woocommerce', '/mx/vende/migracion/woocommerce', '/shop/manage/import')
}

export function buildMigracionBigcartelPageConfig(copy: SellerAcquisitionCopy): SellerAcquisitionPageConfig {
  return buildMigracionPlatformPageConfig(copy, copy.migracionBigcartel, 'migracion-bigcartel', '/mx/vende/migracion/bigcartel', '/shop/manage/import')
}

/**
 * Promoter resources mini-site (epic 08 · S4 · US-12). A STANDALONE content page —
 * it sells SKUs + a glossary, not a seller archetype — so it deliberately does NOT
 * register as a 6th SellerPersonaId. It reuses the SellerAcquisitionPage component
 * but builds its config directly (plain hrefs to the close workspace + sell-sheet),
 * bypassing the persona-keyed baseConfig. es-MX only (rule #5), like the rest of /mx/vende.
 */
// The glossary in locales/*.json is ordered [Dominio propio, Subdominio, Anuncio impreso, Conexión
// Mercado Libre] — this mirrors that order so each proof point can be paired with its SKU's computed
// earnings. Keep the two in sync if the glossary is ever reordered.
const GLOSSARY_SKU_ORDER: PromoterSku[] = ['custom_domain', 'subdomain', 'print_ad', 'ml_sync']

/**
 * Append the computed regular/promoter price + commission to a glossary body — degrades to the
 * body unchanged when nothing is configured yet (never a "$0"/placeholder). `subdomain` is skipped
 * by the caller: its glossary copy already states the promoter angle in words (the future
 * free-first-year grant, US-3.2), and appending the *current* checkout-discount math there would
 * contradict that framing.
 */
function withEarningsLine(body: string, earnings: PromoterSkuEarnings): string {
  if (earnings.variablePrice) {
    return earnings.commissionPct != null ? `${body} Tu comisión: ${earnings.commissionPct}%.` : body
  }
  if (earnings.commissionMxn == null) return body
  return `${body} Con tu código: $${earnings.promoterPriceMxn} MXN para el comerciante · tu comisión: $${earnings.commissionMxn} MXN.`
}

export function buildPromoterPageConfig(
  copy: SellerAcquisitionCopy,
  opts: {
    customDomainPriceMxn: number
    enabled: boolean
    isBoundPromoter?: boolean
    commissionRates?: Record<PromoterSku, number>
    promoterSettings?: PromoterSettings
    /** Sprint 3 (US-3.1) — per-SKU promoter price overrides + the bundle offer. */
    skuPrices?: PromoterSkuPrices
  },
): SellerAcquisitionPageConfig {
  const page = copy.promotor
  const priceMxn = opts.customDomainPriceMxn
  const isBoundPromoter = opts.isBoundPromoter ?? false
  const promoterSettings: PromoterSettings = opts.promoterSettings ?? { enabled: false, discount_type: 'fixed', discount_amount_cents: 0 , bundle_skus: [], bundle_price_mxn: null }
  const commissionRates: Record<PromoterSku, number> = opts.commissionRates ?? {
    custom_domain: 0,
    print_ad: 0,
    subdomain: 0,
    ml_sync: 0,
    migration: 0,
  }
  const skuPrices: PromoterSkuPrices = opts.skuPrices ?? {}
  const earningsTable = buildPromoterEarningsTable(commissionRates, promoterSettings, skuPrices)
  const heroCommissionStat = promoterHeroCommissionStat(commissionRates)
  const monthlyExample = buildPromoterEarningsExample(commissionRates, promoterSettings, [5])
  // Sprint 3 (US-3.1) — "todo esto cuesta $X — con tu promotor $Y" bundle stat, same
  // deriver the admin preview + close workspace read. Absent (null) until an admin
  // configures a bundle — never a fabricated number.
  const bundleRow = computeBundleRow(
    buildSkuPriceTable(PROMOTER_SKU_BASE_PRICE_MXN, skuPrices, promoterSettings),
    { skus: promoterSettings.bundle_skus, bundlePriceMxn: promoterSettings.bundle_price_mxn },
  )
  // The close workspace (`/promotor/cerrar`) 404s when the program is off — hide both CTAs
  // that point there rather than link to a dead page (epic 08 · promoter-funnel-fixes S1.2).
  const closeWorkspaceCta = (label: string, testId: string) =>
    opts.enabled ? { label, href: '/promotor/cerrar', testId } : null
  const APPLY_TEASER_ID = 'promotor-aplica'
  // A visitor who hasn't bound a code yet has nowhere to click "Abrir mi panel" (S1.3) — the
  // self-serve application form doesn't exist until Sprint 2, so the interim CTA anchors to an
  // on-page teaser instead of a dead link. An already-bound promoter keeps the real close-workspace CTA.
  const primaryOrApplyCta = (testId: string) =>
    isBoundPromoter ? closeWorkspaceCta(page.closingCta, testId) : { label: page.applyCta, href: `#${APPLY_TEASER_ID}`, testId }
  return {
    pageId: 'promotor',
    variant: 'a',
    eyebrow: page.eyebrow,
    title: page.heroTitle,
    lead: page.heroLead,
    trustLine: page.trustLine,
    // Single source (epic 08 · promoter-funnel-v2 S1 · US-1.1): the same builder the
    // navbar "Agente IA" sheet uses for this page (resolveAgentContext maps
    // /mx/vende/promotor → kind:'promoter'), so hero and sheet can never drift.
    trustPrompt: buildAgentPrompt({ kind: 'promoter' }),
    copyLabel: copy.shared.copyPrompt,
    copiedLabel: copy.shared.copiedPrompt,
    primaryCta: primaryOrApplyCta('promotor-primary-cta'),
    secondaryCta: { label: page.secondaryCta, href: '/mx/vende/promotor/sell-sheet' },
    // Pricing figures — the custom-domain + subdomain prices are fixed numbers; the commission
    // stat is computed from the live admin config (US-1.4) and hidden (not "%"/"0%") until a rate
    // is configured.
    heroStats: [
      { value: `$${priceMxn}`, label: page.priceDomainLabel },
      { value: `$${SUBDOMAIN_PRICE_YEARLY_MXN}`, label: page.priceSubdomainLabel },
      // Sprint 3 (US-3.1) — "todo esto cuesta $X — con tu promotor $Y" once a bundle is configured.
      ...(bundleRow ? [{ value: `$${bundleRow.bundlePriceMxn}`, label: `paquete completo (antes $${bundleRow.regularTotalMxn})` }] : []),
      ...(heroCommissionStat ? [{ value: heroCommissionStat, label: page.commissionLabel }] : []),
    ],
    proofTitle: page.proofTitle,
    proofLead: page.proofLead,
    // The glossary maps onto proof points (icon/title/body), with the computed regular/promoter
    // price + commission appended per SKU (US-1.4) — degrades to the plain glossary body until a
    // rate is configured.
    proofPoints: page.glossary.map((raw, i) => {
      // The glossary's prices are `{token}`s (pricing-page D8) — filled from the price modules here.
      const point = { ...raw, body: fillFixedPricingTokens(raw.body, 'es') }
      const sku = GLOSSARY_SKU_ORDER[i]
      if (sku === 'subdomain') return point
      const earnings = earningsTable.find((r) => r.sku === sku)
      return earnings ? { ...point, body: withEarningsLine(point.body, earnings) } : point
    }),
    stepsTitle: page.stepsTitle,
    steps: page.steps,
    agentTitle: copy.shared.selfCheck.title,
    agentBody: copy.shared.selfCheck.body,
    socialTitle: page.pitchTitle,
    socialBody: page.pitchBody,
    // The 3rd pitch stat becomes a "close N shops/month" earnings example once the representative
    // SKU has a configured rate; degrades to the original placeholder stats until then.
    socialStats: monthlyExample
      ? [
          page.pitchStats[0],
          page.pitchStats[1],
          { value: `$${monthlyExample[0].estimatedMonthlyMxn}`, label: `cerrando ${monthlyExample[0].closesPerMonth} tiendas/mes` },
        ]
      : page.pitchStats,
    faqTitle: copy.shared.faqTitle,
    faqs: copy.shared.faqs,
    closingTitle: page.closingTitle,
    closingBody: page.closingBody,
    closingCta: primaryOrApplyCta('promotor-closing-cta'),
    applyTeaser: isBoundPromoter
      ? undefined
      : { id: APPLY_TEASER_ID, title: page.apply.title, body: page.apply.body },
  }
}

/**
 * The US recruiting landing rendered on a signed-out `/sell`.
 *
 * It reuses the same `SellerAcquisitionPage` section system the `/mx/vende` family
 * uses, so the two markets stay structurally identical and a layout fix lands on
 * both at once. What differs is entirely COPY and DESTINATION: its own
 * `sellerAcquisition.us` dictionary block (US money and delivery truth, not a
 * translation of the Mexican page) and `usSellerCtaHref`, which carries
 * `market=us` through account creation.
 *
 * Deliberately omits `personaRouter`, `benchmark`, `premiumFeatures` and
 * `aiChannel`: those are anchor-only sections whose content is Mexico-specific
 * (peso benchmarks, the MX persona family), and an empty or translated version of
 * them would be a claim we cannot back in the US yet.
 */
export function buildUsMarketPageConfig(
  copy: SellerAcquisitionCopy,
  query: QueryParams,
): SellerAcquisitionPageConfig {
  const page = copy.us
  const variant = resolveSellerAcquisitionVariant(query)
  const ctaHref = usSellerCtaHref(query)

  return {
    pageId: 'us',
    variant,
    eyebrow: page.eyebrow,
    title: page.heroTitle,
    lead: page.heroLead,
    trustLine: page.trustLine,
    trustPrompt: copy.shared.trustPrompt,
    copyLabel: copy.shared.copyPrompt,
    copiedLabel: copy.shared.copiedPrompt,
    primaryCta: { label: page.primaryCta, href: ctaHref, testId: 'us-primary-cta' },
    secondaryCta: { label: page.secondaryCta, href: '#us-steps-title' },
    heroStats: page.heroStats,
    heroValues: page.heroValues,
    proofTitle: page.proofTitle,
    proofLead: page.proofLead,
    proofPoints: page.proofPoints,
    stepsTitle: page.stepsTitle,
    steps: page.steps,
    agentTitle: copy.shared.selfCheck.title,
    agentBody: copy.shared.selfCheck.body,
    socialTitle: page.socialTitle,
    socialBody: page.socialBody,
    socialStats: page.socialStats,
    // The US block carries its OWN FAQs: the shared set answers with MercadoPago,
    // SPEI and cash, none of which exist on a US checkout.
    faqTitle: page.faqTitle,
    faqs: page.faqs,
    closingTitle: page.closingTitle,
    closingBody: page.closingBody,
    closingCta: { label: page.closingCta, href: ctaHref, testId: 'us-closing-cta' },
  }
}

function baseConfig(
  copy: SellerAcquisitionCopy,
  page: AnchorCopy | CreatorCopy | LocalBusinessCopy | ServicesCopy | AutosCopy,
  personaId: SellerPersonaId,
  query: QueryParams,
): SellerAcquisitionPageConfig {
  const variant = resolveSellerAcquisitionVariant(query)
  const variantPage = applySellerAcquisitionPageVariant(page, variant)

  return {
    pageId: personaId,
    variant,
    eyebrow: variantPage.eyebrow,
    title: variantPage.heroTitle,
    lead: variantPage.heroLead,
    trustLine: variantPage.trustLine,
    trustPrompt: sellerTrustPrompt(personaId, copy.shared.trustPrompt),
    copyLabel: copy.shared.copyPrompt,
    copiedLabel: copy.shared.copiedPrompt,
    primaryCta: {
      label: variantPage.primaryCta,
      href: sellerPersonaCtaHref(personaId, query),
      testId: `${personaId}-primary-cta`,
    },
    heroStats: variantPage.heroStats,
    proofTitle: variantPage.proofTitle,
    proofLead: variantPage.proofLead,
    proofPoints: variantPage.proofPoints,
    stepsTitle: variantPage.stepsTitle,
    steps: variantPage.steps,
    // Single source for the self-verify aside (replaces every page's old agentTitle/agentBody).
    agentTitle: copy.shared.selfCheck.title,
    agentBody: copy.shared.selfCheck.body,
    socialTitle: variantPage.socialTitle,
    socialBody: variantPage.socialBody,
    socialStats: variantPage.socialStats,
    faqTitle: copy.shared.faqTitle,
    faqs: copy.shared.faqs,
    closingTitle: variantPage.closingTitle,
    closingBody: variantPage.closingBody,
    closingCta: {
      label: variantPage.closingCta,
      href: sellerPersonaCtaHref(personaId, query),
      testId: `${personaId}-closing-cta`,
    },
  }
}

export function applySellerAcquisitionPageVariant<T extends VariantCapablePage>(
  page: T,
  variant: SellerAcquisitionVariant,
): T {
  if (variant === 'a') {
    return page
  }

  const override = page.variants?.[variant]
  if (!override) {
    return page
  }

  return { ...page, ...override }
}
