/**
 * lib/about-content-overrides.ts
 *
 * The override-aware read path for the "about / why-sell" content (epic 08 ·
 * admin-content-and-announcements, Sprint 2). `lib/about-content.ts` stays a plain,
 * next/*-free data module (its literal `ABOUT_PAGE`/`ABOUT_SECTIONS` are the
 * regression-tested defaults, unchanged); every real render path — the human
 * `/acerca` page, `/agent`, `/api/ucp/manifest`, `/llms.txt`, the MCP `about_miyagi`
 * resource — reads through the two functions here instead, which layer any
 * `platform_copy_overrides` rows (via the Sprint-1 merge seam, `lib/copy-overrides.ts`)
 * onto the `acerca` dictionary namespace. Not imported by `e2e/about-content.spec.ts`
 * (which regression-tests the pure defaults) — this module is `server-only`-adjacent
 * (transitively pulls in Supabase via `getOverriddenDictionary`), consistent with why
 * `lib/about-content.ts` itself never imports it.
 */
import { getOverriddenDictionary } from './copy-overrides'
import { getPricingCatalog } from './pricing-catalog-server'
import {
  ABOUT_SECTION_IDS,
  fillAboutSectionsPricing,
  type AboutLocale,
  type AboutPageCopy,
  type AboutSection,
  type AboutSectionId,
} from './about-content'

/**
 * Mirrors `about-content.ts`'s grounding note. Empty since the /acerca mobile+content refresh
 * grounded the founder section (previously the only stub) — kept as a live `Set`, not deleted,
 * so a future placeholder section has an obvious place to register.
 */
const STUB_SECTION_IDS = new Set<AboutSectionId>([])

/** Overridden `ABOUT_PAGE[locale]` — reflects any admin copy edit to the `acerca.page` namespace. */
export async function getOverriddenAboutPage(locale: AboutLocale): Promise<AboutPageCopy> {
  const dict = await getOverriddenDictionary(locale)
  return dict.acerca.page
}

/**
 * Overridden `ABOUT_SECTIONS` — both locales zipped per section, reflecting any admin
 * copy edit to the `acerca.sections.*` namespace. Reads es + en separately (the merge
 * seam applies overrides for one locale at a time) and zips them back into the same
 * `AboutSection[]` shape every consumer already expects.
 */
export async function getOverriddenAboutSections(): Promise<AboutSection[]> {
  const [esDict, enDict] = await Promise.all([
    getOverriddenDictionary('es'),
    getOverriddenDictionary('en'),
  ])
  const sections = ABOUT_SECTION_IDS.map((id) => ({
    id,
    stub: STUB_SECTION_IDS.has(id),
    es: esDict.acerca.sections[id],
    en: enDict.acerca.sections[id],
  }))
  // The pricing section holds `{token}`s, never typed prices (pricing-page D7): fill them from the
  // live catalog — including any admin override, which can use the same tokens.
  return fillAboutSectionsPricing(sections, await getPricingCatalog())
}
