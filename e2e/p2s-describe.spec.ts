import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_DESCRIPTION_CHARS } from '../lib/prompt-to-shop/blocks'
import { characterCounter, DESCRIBE_COPY } from '../lib/prompt-to-shop/copy'

// Prompt-to-shop S2.2 — the describe box on /mx/vende and the /sell first run. Pure/source checks: there is no
// browser here, so the 375 px "above the fold" claim is held as an ORDER invariant (the box sits before every
// other hero block) and the real-phone check is owed in the smoke walkthrough.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const es = JSON.parse(read('locales/es.json')) as { sellerAcquisition: { anchor: { heroTitle: string; metadata: { title: string; description: string } } } }
const HERO = 'Describe tu negocio. En segundos tienes tienda, compradores en el marketplace y una IA que la atiende — sin comisión.'

test('the box asks «Cuéntanos qué vendes», offers three examples (one of them tamales), and counts to the limit', () => {
  expect(DESCRIBE_COPY.label).toBe('Cuéntanos qué vendes')
  expect(DESCRIBE_COPY.submit).toBe('Armar mi tienda')
  expect(DESCRIBE_COPY.examples).toHaveLength(3)
  expect(DESCRIBE_COPY.examples.some((e) => /tamales/i.test(e.text))).toBe(true)
  for (const e of DESCRIBE_COPY.examples) expect(e.text.length, e.label).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS)
  expect(characterCounter(12)).toBe(`12/${MAX_DESCRIPTION_CHARS}`)
})

test('the secondary links point at routes that exist (file import, manual wizard)', () => {
  const box = read('app/(shell)/mx/vende/_components/DescribeBox.tsx')
  // /sell/puertas is the three-doors CHOOSER and S3.3 redirects it away; the file/agent import is /sell/setup.
  expect(box).toContain("fileHref = '/sell/setup'")
  expect(existsSync(join(ROOT, 'app/(shell)/sell/setup/page.tsx'))).toBe(true)
  expect(existsSync(join(ROOT, 'app/(shell)/sell/page.tsx'))).toBe(true)
  expect(DESCRIBE_COPY.fileLink).toBe('¿Ya tienes tu catálogo en un archivo?')
  expect(DESCRIBE_COPY.manualLink).toBe('Armar a mano')
  expect(box).toContain('DESCRIBE_COPY.fileLink')
  expect(box).toContain('DESCRIBE_COPY.manualLink')
})

test('the submit stays disabled until there is text AND a verification token AND a site key', () => {
  const box = read('app/(shell)/mx/vende/_components/DescribeBox.tsx')
  expect(box).toMatch(/const ready = trimmed\.length > 0 && text\.length <= MAX_DESCRIPTION_CHARS && !!token && !!siteKey/)
  expect(box).toContain('disabled={!ready}')
  // The Turnstile site key is a prop from a server page (D8), never NEXT_PUBLIC.
  expect(box).not.toContain('NEXT_PUBLIC')
})

test('the new hero line replaces the anchor title and the page metadata', () => {
  const { heroTitle, metadata } = es.sellerAcquisition.anchor
  expect(heroTitle).toBe(HERO)
  expect(metadata.description).toBe(HERO)
  // <title> may be a shortened form, but it must stay a title.
  expect(metadata.title.length).toBeLessThanOrEqual(60)
  expect(metadata.title).toMatch(/^Describe tu negocio/)
})

test('the box is the hero\'s first block after the title, so it is above the fold on a phone', () => {
  const sections = read('app/(shell)/mx/vende/_components/SellerAcquisitionSections.tsx')
  const hero = sections.slice(sections.indexOf('function LandingHero'), sections.indexOf('function TrustLine'))
  const at = (needle: string) => hero.indexOf(needle)
  const box = at('<div className={styles.describe}>')
  expect(box).toBeGreaterThan(at('{config.title}'))
  for (const later of ['config.lead', '<TrustLine', '<PromptBlock', '<HeroValueList']) {
    expect(box, later).toBeLessThan(at(later))
  }
})

test('/mx/vende mounts the box with a runtime site key; the pitch still carries the no-JS commission claim', () => {
  const page = read('app/(shell)/mx/vende/page.tsx')
  expect(page).toContain('<DescribeBox siteKey={process.env.TURNSTILE_SITE_KEY || null}')
  // agent-readability asserts the no-JS HTML contains «0% de comisión»; the new hero title no longer says it, so
  // another block of the page must keep saying it.
  const anchor = JSON.stringify(es.sellerAcquisition.anchor)
  expect(anchor).toContain('0% de comisión')
})

test('/sell shows the same box to a signed-in merchant with no shop, and keeps its redirects', () => {
  const sell = read('app/(shell)/sell/page.tsx')
  expect(sell).toMatch(/\{!existingShop && signupMarket !== 'us' && \(\s*<div className="mb-6">\s*<DescribeBox/)
  expect(sell).toContain('id="armar-a-mano"')
  expect(sell).toContain('manualHref="#armar-a-mano"')
  // Untouched by this story (S3.3 removes the second one): the signed-out hop and the three-doors branch.
  expect(sell).toContain('redirect(sellerLandingRedirectPath(signupMarket, params))')
  expect(sell).toContain("redirect('/sell/bienvenida')")
  expect(sell).toContain("isEnabled('onboarding.three_doors_enabled')")
})

test('/sell keeps the box off a US signup: generation is an es-MX shop (AGENTS rule 5)', () => {
  const sell = read('app/(shell)/sell/page.tsx')
  expect(sell).toMatch(/!existingShop && signupMarket !== 'us' && \(\s*<div className="mb-6">\s*<DescribeBox/)
})
