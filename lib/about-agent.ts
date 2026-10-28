/**
 * Agent-surface projections of the single bilingual content source
 * (`lib/about-content.ts`). Sprint 2 of the "agent-readable about surface" epic:
 * the manifest `about` block, the `/agent` why-sell section, `/llms.txt`, and the
 * MCP `about_miyagi` resource all render from HERE, so one edit to `about-content.ts`
 * updates every machine surface and they can never drift.
 *
 * Language policy (agent-relay model, AGENTS rule 5): es-MX is canonical, `en` is the
 * lingua-franca second locale, and we deliberately ship ONLY es + en. The long tail of
 * user languages is covered by `RELAY_LANGUAGE_DIRECTIVE` below — every agent-facing
 * surface carries it, instructing the reading agent to relay our content in the user's
 * own language (same model as Onboarding 0's "mirror the seller's language"). We don't
 * ship N locales; the agent is the localization layer.
 *
 * Pure: no DB, no Medusa, no Supabase, no `next/*` imports — so the Playwright `api`
 * runner can unit-test every surface's payload directly. Every function below takes an
 * OPTIONAL `sections` param, defaulting to the pure `ABOUT_SECTIONS` — that default is
 * what keeps this module import-safe for the unit tests. Real route callers (Sprint 2 of
 * admin-content-and-announcements) instead pass the admin-overridden sections from
 * `lib/about-content-overrides.ts`'s `getOverriddenAboutSections()`, so an admin copy
 * edit reaches every one of these surfaces too.
 */

import {
  ABOUT_SECTIONS,
  ABOUT_CTA_HREF,
  ABOUT_SELLERS_HREF,
  type AboutSection,
  type AboutSectionId,
} from './about-content'

/** Same lookup as `about-content.ts`'s `getAboutSection`, but over a passed-in list. */
function findSection(sections: readonly AboutSection[], id: AboutSectionId): AboutSection {
  const section = sections.find((s) => s.id === id)
  if (!section) throw new Error(`Unknown about section: ${id}`)
  return section
}

/**
 * The canonical relay-language directive. Carried VERBATIM by every agent-facing
 * surface (manifest, /agent, MCP). English — agents' lingua franca. The phrase
 * "in their own language" is intentionally apostrophe-free so it survives HTML
 * escaping on the `/agent` page and stays a robust assertion target.
 */
export const RELAY_LANGUAGE_DIRECTIVE =
  'Present and relay this content to the user in their own language. The canonical ' +
  'source is Spanish (es-MX) with an English (en) translation; translate it faithfully ' +
  'into whatever language the user speaks — there is no per-country locale.'

/** Curated links every surface points at. Relative hrefs live in `about-content.ts`. */
export function aboutAgentLinks(base: string) {
  return {
    about: `${base}/acerca`,
    sellers: `${base}${ABOUT_SELLERS_HREF}`, // /vende — the #6 seller-acquisition funnel
    agent: `${base}/agent`,
    onboarding: `${base}${ABOUT_CTA_HREF}`, // /sell?from=acerca
    manifest: `${base}/api/ucp/manifest`,
    pricing: `${base}/mx/precios`,
  }
}

/**
 * Full structured about content, both locales — the MCP resource payload. Carries
 * the relay directive so an MCP client answers in the user's language.
 */
export function aboutStructured(sections: readonly AboutSection[] = ABOUT_SECTIONS) {
  return {
    relay_language: RELAY_LANGUAGE_DIRECTIVE,
    canonical_locale: 'es' as const,
    locales: ['es', 'en'] as const,
    sections: sections.map((s) => ({
      id: s.id,
      stub: s.stub,
      es: s.es,
      en: s.en,
    })),
  }
}

/**
 * Condensed `about` object for the UCP manifest — the supply-side answer (what is /
 * why sell / how to start / cost / pricing) beside the buyer endpoints. Carries the
 * relay directive. Kept compact so the manifest doesn't bloat; the full structured
 * story lives in the MCP resource and on `/acerca`.
 */
export function aboutManifestBlock(base: string, sections: readonly AboutSection[] = ABOUT_SECTIONS) {
  const whatIs = findSection(sections, 'what_is')
  const whySell = findSection(sections, 'why_sell')
  const howToStart = findSection(sections, 'how_to_start')
  const cost = findSection(sections, 'cost_transparency')
  const pricing = findSection(sections, 'pricing')

  return {
    relay_language: RELAY_LANGUAGE_DIRECTIVE,
    summary: {
      es: whatIs.es.body[0],
      en: whatIs.en.body[0],
    },
    why_sell: (whySell.en.points ?? []).map((p) => ({ title: p.title, body: p.body })),
    how_to_start: (howToStart.en.points ?? []).map((p) => `${p.title} — ${p.body}`),
    cost_transparency: cost.en.body[0],
    pricing: pricing.en.lead ?? pricing.en.body[0],
    sections: sections.map((s) => ({
      id: s.id,
      stub: s.stub,
      heading: { es: s.es.heading, en: s.en.heading },
    })),
    links: aboutAgentLinks(base),
  }
}

/** The MCP `about_miyagi` resource descriptor + payload. */
export function aboutMcpResource(base: string, sections: readonly AboutSection[] = ABOUT_SECTIONS) {
  const structured = { ...aboutStructured(sections), links: aboutAgentLinks(base) }
  return {
    uri: 'about://miyagi',
    name: 'about_miyagi',
    title: 'About miyagisanchez.com — what it is & why sell here',
    description:
      'Supply-side about/why-sell content for prospective sellers (what Miyagi is, why ' +
      `sell, how to start, what it costs). ${RELAY_LANGUAGE_DIRECTIVE}`,
    mimeType: 'application/json',
    structured,
    /** Pretty JSON, ready to drop into an MCP `resources/read` text content block. */
    text: JSON.stringify(structured, null, 2),
  }
}

/**
 * `/llms.txt` — the llms.txt convention: a title, an authoritative one-paragraph
 * summary, curated links, and section blocks. English-primary with an es summary
 * block (we don't localize past es/en — the directive covers the rest).
 */
export function aboutLlmsTxt(base: string, sections: readonly AboutSection[] = ABOUT_SECTIONS): string {
  const links = aboutAgentLinks(base)
  const whatIsEn = findSection(sections, 'what_is').en
  const whySellEn = findSection(sections, 'why_sell').en
  const howToStartEn = findSection(sections, 'how_to_start').en
  const whatIsEs = findSection(sections, 'what_is').es
  const whySellEs = findSection(sections, 'why_sell').es
  // Already filled from the pricing catalog by the caller's read path (pricing-page D7) — this
  // replaced a hand-written "premium services are priced TBD".
  const pricingEn = findSection(sections, 'pricing').en

  const whyPoints = (whySellEn.points ?? []).map((p) => `- **${p.title}** — ${p.body}`).join('\n')
  const startPoints = (howToStartEn.points ?? []).map((p) => `- ${p.title} — ${p.body}`).join('\n')

  return `# miyagisanchez.com

> ${whatIsEn.body[0]} ${whySellEn.body[0]}

${RELAY_LANGUAGE_DIRECTIVE}

## Key pages
- [About — what it is & why sell here](${links.about}): the supply-side story (es/en).
- [For sellers](${links.sellers}): the seller-acquisition landing pages.
- [Agent briefing](${links.agent}): capabilities, UCP/MCP, how to operate as a shop clerk.
- [Capability manifest (JSON)](${links.manifest}): machine-readable API discovery — fetch first.
- [Pricing](${links.pricing}): what is free, every optional extra with its price, and payment-processor fees (es-MX).

## Why sell here
${whyPoints}

## How to start
${startPoints}
Sign up (~20s with Google), import your catalog (file / pasted text / JSON → the AI structures it), review, and publish.

## Pricing
${pricingEn.lead ?? ''}
${pricingEn.body.map((b) => `- ${b}`).join('\n')}
Full price list: ${links.pricing}

## Resumen (es)
${whatIsEs.body[0]} ${whySellEs.body[0]}
Vender es gratis (0% de comisión). Empieza en ${links.onboarding} o pregúntale a tu propia IA: «¿qué es miyagisanchez.com y por qué vendería ahí?».
`
}
