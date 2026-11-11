import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { buildAnchorPageConfig, buildCreatorPageConfig } from '../app/(shell)/mx/vende/_components/page-config'

/**
 * root-shop-builder-home Sprint 2 (D11) — the page the bare domain opens on leads with the shop a
 * merchant gets, and keeps the marketplace as a bonus.
 *
 * Pure: the config is what the page renders, and the render ORDER is read from the one function
 * that decides it. The rendered facts (no overflow, the buyer link above the fold) are the browser
 * spec's job.
 */

const ROOT = path.resolve(import.meta.dirname, '..')
const sections = readFileSync(
  path.join(ROOT, 'app/(shell)/mx/vende/_components/SellerAcquisitionSections.tsx'),
  'utf8',
)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const copy = JSON.parse(readFileSync(path.join(ROOT, 'locales/es.json'), 'utf8')).sellerAcquisition as any

test.describe('the root leads with the shop, not the marketplace', () => {
  const anchor = buildAnchorPageConfig(copy, {})

  test('"Lo que te llevas" names the shop, payments, the share kit and the setup guide', () => {
    expect(anchor.sectionOrder).toBe('anchor')
    expect(anchor.proofTitle).toBe('Lo que te llevas')
    const points = anchor.proofPoints.map((p) => `${p.title} ${p.body}`).join('\n')
    expect(points).toMatch(/dominio/)
    expect(points).toMatch(/0% de comisión/)
    expect(points).toMatch(/catálogo/i)
    expect(points).toMatch(/PDF/)
    expect(points).toMatch(/Instagram/)
    expect(points).toMatch(/guía/i)
  })

  test('every price on the page comes from the pricing catalog — no token left unfilled', () => {
    // pricing-page D8: prices are `{token}`s in copy, filled from the price modules. An unfilled
    // token would print "{subdomainYearly}" to a merchant.
    const proof = anchor.proofPoints.map((p) => p.body).join('\n')
    expect(proof).not.toMatch(/\{\w+\}/)
    // plans-gratis-negocio (D11): no retired subdomain/domain price is quoted on the proof points.
    expect(proof).not.toMatch(/MXN al año/)
    expect(anchor.pricingCallout?.body).not.toMatch(/\{\w+\}/)
    expect(anchor.pricingCallout?.body).toMatch(/0% de comisión/)
    // The callout names Negocio's monthly price, filled from lib/negocio-pricing.ts (plans-gratis-negocio D16).
    expect(anchor.pricingCallout?.body).toMatch(/\$[\d,]+ MXN al mes/)
    expect(anchor.pricingCallout?.cta.href).toBe('/mx/precios')
  })

  test('nothing on the page contradicts the published prices or overclaims the draft', () => {
    // The "included" grid used to list the domain as free while "Lo que te llevas" prices it; and
    // before signing up a draft can only be renamed, recoloured or regenerated (prompt-to-shop
    // access.ts), so the step must not promise free editing. Both caught by the fresh reviewer.
    const included = anchor.premiumFeatures?.items.map((i) => `${i.label} ${i.sub}`).join('\n') ?? ''
    expect(included).not.toMatch(/dominio/i)
    expect(anchor.premiumFeatures?.lead).not.toMatch(/marketplace/i)
    expect(anchor.steps[1].body).not.toMatch(/como quieras/)
  })

  test('the steps describe the flow the page actually runs: describe, watch it take shape, keep it', () => {
    expect(anchor.steps.map((s) => s.title)).toEqual([
      'Describe tu negocio',
      'Mira tu tienda tomar forma',
      'Quédatela y publica',
    ])
  })

  test('the hero promises a shop, not marketplace buyers', () => {
    // Buyer traffic is still small (the product owner's 10-29 ask): the headline must not lead
    // with "compradores en el marketplace". The marketplace is named only as a bonus.
    expect(anchor.title).toMatch(/tienda en línea/)
    expect(anchor.title).not.toMatch(/marketplace/i)
    expect(copy.anchor.metadata.description).not.toMatch(/compradores en el marketplace/)
  })

  test('the Vecindario is a benefit — one line, no buyer line in the hero (own-shop-positioning D3)', () => {
    // The «¿Vienes a comprar? Explora el marketplace» hero line is gone: the marketplace left the main navigation, so
    // a merchant landing on `/` is not told to go shopping. What remains is ONE benefit line near the end.
    expect(anchor.marketplaceBonus?.cta.href).toBe('/vecindario')
    expect(anchor.marketplaceBonus?.title).toBe('Tus productos también aparecen en el Vecindario de Miyagi Sánchez.')
    expect('buyerLink' in anchor).toBe(false)
    expect(JSON.stringify(copy.anchor)).not.toMatch(/Explora el marketplace|Vienes a comprar/)
  })

  test('section order: what you get → how → price → … → marketplace last', () => {
    const body = sections.slice(
      sections.indexOf('function AnchorSections'),
      sections.indexOf('function PersonaSections'),
    )
    expect(body.length, 'AnchorSections not found — the order guard would be inert').toBeGreaterThan(100)
    const at = (needle: string) => {
      const i = body.indexOf(needle)
      expect(i, `${needle} must be rendered by AnchorSections`).toBeGreaterThan(-1)
      return i
    }
    // The hero no longer carries a buyer line (own-shop-positioning D3).
    const hero = sections.slice(sections.indexOf('function LandingHero'), sections.indexOf('function TrustLine'))
    expect(hero, 'the hero must not render a buyer link').not.toContain('BuyerLink')
    const order = [
      at('<ProofSection'),
      at('<StepsSection'),
      at('callout={config.pricingCallout}'),
      at('<BenchmarkSection'),
      at('<PersonaRouterSection'),
      at('<AiChannelSection'),
      at('callout={config.marketplaceBonus}'),
    ]
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test('persona pages keep their own order and get no marketplace bonus', () => {
    const creators = buildCreatorPageConfig(copy, {})
    expect(creators.sectionOrder).toBeUndefined()
    expect(creators.marketplaceBonus).toBeUndefined()
  })
})
