import { expect, test } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import { sellerTrustPrompt } from '../lib/seller-acquisition'
import { fillFixedPricingTokens } from '../lib/pricing-catalog'
import { SUBDOMAIN_PRICE_YEARLY_MXN } from '../lib/subdomain-pricing'
import { buildPromoterPageConfig } from '../app/(shell)/mx/vende/_components/page-config'

// Locked es-MX copy from COPY-BRIEF.md (Sprint 1, approved 2026-06-25). These guards keep the
// distrust framing, internal jargon, and un-accented offenders from creeping back into the
// seller-acquisition landing copy.
const es = JSON.parse(readFileSync(new URL('../locales/es.json', import.meta.url), 'utf8')) as {
  sellerAcquisition: Record<string, unknown> & {
    shared: {
      trustPrompt: string
      selfCheck: { title: string; body: string }
      heroTrustLine: string
    }
    anchor: {
      heroValues: { value: string; label: string; icon: string }[]
      premiumFeatures: { title: string; lead: string; items: { icon: string; label: string; sub: string }[] }
      benchmark: { example: { rows: unknown[]; footnotes: string[]; punchline: string } }
    }
  }
}
const sa = es.sellerAcquisition
const blob = JSON.stringify(sa)

test.describe('seller acquisition · es-MX copy guards', () => {
  test('no distrust framing or internal jargon remains', () => {
    const banned = ['No pedimos fe', 'No nos creas', 'vaporware', 'atribuci', 'para medir qu']
    for (const phrase of banned) {
      expect(blob, `banned phrase "${phrase}" must be gone`).not.toContain(phrase)
    }
  })

  test('no un-accented offenders remain (legit plurals like comisiones are allowed)', () => {
    // Match the offender ONLY as a standalone word — a trailing letter (e.g. comisiones,
    // publicaciones) is the correctly un-accented Spanish plural and is allowed.
    const offenders = ['comision', 'publicacion', 'pagina', 'Mexico', 'Que tipo']
    for (const tok of offenders) {
      const re = new RegExp(`${tok}(?!\\p{L})`, 'iu')
      expect(blob, `un-accented offender "${tok}" must not appear as a standalone word`).not.toMatch(re)
    }
  })

  test('self-check block carries the self-verify invitation', () => {
    expect(sa.shared.selfCheck.title).toBe('Compruébalo tú mismo')
    // Launch polish (§D): the body now points at the copy-paste prompt block (Sprint 2),
    // not the old "No tienes que creernos…" paragraph.
    expect(sa.shared.selfCheck.body).toContain('Copia el prompt y pégalo en tu IA')
  })

  test('trust prompt is a directive, cost-comparing template', () => {
    expect(sa.shared.trustPrompt).toContain('{url}')
    expect(sa.shared.trustPrompt).toContain('Mercado Libre')
    expect(sa.shared.trustPrompt).toContain('Shopify')
  })

  test('sellerTrustPrompt substitutes the page URL and keeps the comparison instruction', () => {
    const anchor = sellerTrustPrompt('vende', sa.shared.trustPrompt)
    expect(anchor).toContain('https://miyagisanchez.com/mx/vende')
    expect(anchor).not.toContain('{url}')
    expect(anchor).toContain('Mercado Libre')
    expect(anchor).toContain('Shopify')

    const creators = sellerTrustPrompt('creadores', sa.shared.trustPrompt)
    expect(creators).toContain('https://miyagisanchez.com/mx/vende/creadores')

    const servicios = sellerTrustPrompt('servicios', sa.shared.trustPrompt)
    expect(servicios).toContain('https://miyagisanchez.com/mx/vende/servicios')
  })

  // ── launch polish (seller-landing-launch-polish, Sprint 1) ──────────────────────────────

  test('brand voice: no bare "Miyagi" (only "Miyagi Sánchez" or "miyagisanchez.com")', () => {
    expect(blob, 'bare "Miyagi" must be "Miyagi Sánchez" or "miyagisanchez.com"').not.toMatch(
      /Miyagi(?!\s*Sánchez)/,
    )
  })

  test('brand voice: our word is "marketplace", never "mercado" (brand names stay)', () => {
    // Strip the legit brand names, then any remaining "mercado" is ours. (The benchmark's
    // `"mercadoLibre"` JSON key no longer exists — rows carry a positional `cells` array.)
    const cleaned = blob
      .replace(/Mercado Libre/g, '')
      .replace(/MercadoPago/g, '')
    expect(cleaned, 'our-word "mercado" must be "marketplace"').not.toMatch(/mercado/i)
  })

  test('removed clutter/distrust lines are gone (§C/§E/§F/§G)', () => {
    const removed = [
      'no es promesa a futuro',
      'Hecho para negocios reales',
      'El Mundial no espera',
      'Entra antes de que la demanda',
    ]
    for (const phrase of removed) {
      expect(blob, `removed line "${phrase}" must be gone`).not.toContain(phrase)
    }
  })

  test('hero trust line is staged for the prompt block (§B)', () => {
    expect(sa.shared.heroTrustLine).toContain('copia el prompt')
    expect(sa.shared.heroTrustLine).toMatch(/Claude.*Gemini.*ChatGPT/)
  })

  test('anchor hero value list has 3 value/label/icon items (§B)', () => {
    expect(sa.anchor.heroValues).toHaveLength(3)
    for (const v of sa.anchor.heroValues) {
      expect(v.value.length).toBeGreaterThan(0)
      expect(v.label.length).toBeGreaterThan(0)
      expect(v.icon.startsWith('iconoir-')).toBe(true)
    }
  })

  test('anchor premium-features grid has 6 items (§F)', () => {
    expect(sa.anchor.premiumFeatures.title.length).toBeGreaterThan(0)
    expect(sa.anchor.premiumFeatures.items).toHaveLength(6)
    for (const it of sa.anchor.premiumFeatures.items) {
      expect(it.label.length).toBeGreaterThan(0)
      expect(it.sub.length).toBeGreaterThan(0)
      expect(it.icon.startsWith('iconoir-')).toBe(true)
    }
  })

  test('benchmark worked-example has 3 platform rows + 4 footnotes (§H)', () => {
    const ex = sa.anchor.benchmark.example
    expect(ex.rows).toHaveLength(3)
    expect(ex.footnotes).toHaveLength(4)
    expect(ex.punchline).toContain('Mercado Libre')
  })
})

test.describe('promoter landing · CTA + wording sweep (promoter-funnel-v2 S1 · US-1.3)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const promoterCopy = (sa as any).promotor
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fullCopy = sa as any

  test('no stale "subdomain is free for everyone" claim remains in the glossary', () => {
    const subdomainEntry = promoterCopy.glossary.find((g: { title: string }) => g.title === 'Subdominio')
    expect(subdomainEntry.body).not.toContain('gratis para todos')
    // The price is a `{token}` since pricing-page D8 — assert on what the page renders, filled
    // from the price module, so the check still proves a real price reaches the merchant.
    expect(fillFixedPricingTokens(subdomainEntry.body, 'es')).toContain(`$${SUBDOMAIN_PRICE_YEARLY_MXN} MXN`)
    expect(subdomainEntry.body).not.toMatch(/\$\d/)
    expect(subdomainEntry.body).toContain('GRATIS el primer año')
  })

  test('a not-yet-bound visitor gets the apply CTA, never the dead-ended workspace CTA', () => {
    const config = buildPromoterPageConfig(fullCopy, { customDomainPriceMxn: 499, enabled: true, isBoundPromoter: false })
    expect(config.primaryCta?.label).toBe('Aplica para ser promotor')
    expect(config.primaryCta?.label).not.toBe('Abrir mi panel para cerrar')
    // Never a dead link: the apply CTA anchors to the on-page teaser, not a route.
    expect(config.primaryCta?.href).toBe('#promotor-aplica')
    expect(config.applyTeaser?.id).toBe('promotor-aplica')
  })

  test('a bound promoter keeps the real close-workspace CTA', () => {
    const config = buildPromoterPageConfig(fullCopy, { customDomainPriceMxn: 499, enabled: true, isBoundPromoter: true })
    expect(config.primaryCta?.label).toBe('Abrir mi panel para cerrar')
    expect(config.primaryCta?.href).toBe('/promotor/cerrar')
    expect(config.applyTeaser).toBeUndefined()
  })
})

/**
 * "Monta la tienda" is retired. Setting up a shop is `abrir` / `dejar lista` /
 * `preparar` — never `montar`, which reads like assembling furniture.
 *
 * Scanned across the WHOLE population (the es dictionary plus every source file under
 * `app/` and `lib/`), not the handful of files a grep happened to surface: the first
 * sweep of this cleaned the dictionary and left the string live in `lib/agent-prompt.ts`,
 * where it rendered inside the promoter page's own AI prompt block.
 *
 * The ban is deliberately narrow. `monto`/`montos` are money amounts, `montaña` and
 * `Cadereyta de Montes` are real words, and a guard that reddens on correct copy is one
 * people learn to route around. Unicode letter boundaries, not `\b` — `\b` treats `ñ` as
 * a non-word character, so `\bmonta\b` matches inside `montaña`.
 */
const MONTAR_FORMS = [
  'monta', 'montas', 'montan', 'montamos', 'montá', 'montó', 'monté',
  'montar', 'montarla', 'montarlo', 'montarlas', 'montarlos', 'montarle', 'montarles',
  'montando', 'montándola', 'montándolo',
  'montado', 'montada', 'montados', 'montadas', 'montaron', 'montaba', 'montaban',
  'móntala', 'móntalo',
  // `monto`/`montos` are deliberately ABSENT. They are overwhelmingly the money noun
  // ("el monto de la venta", "tres montos sugeridos") and only marginally the first-person
  // verb, which does not occur in marketing copy. Including them meant this guard reddened
  // on `lib/settings-import.ts`'s correct payout wording — and a guard that rejects correct
  // output is one people learn to bypass. The accented `montó`/`monté` are unambiguous.
]
// `\b` is no good here: `ñ` is a non-word character to it, so `\bmonta\b` matches inside
// `montaña`. Unicode letter boundaries on both sides instead.
const SHOP_SETUP_MONTAR = new RegExp(`(?<!\\p{L})(${MONTAR_FORMS.join('|')})(?!\\p{L})`, 'iu')
const violates = (line: string) => SHOP_SETUP_MONTAR.test(line)

test.describe('brand voice · a shop is opened, never "montada"', () => {
  test('the es dictionary is clean', () => {
    const raw = readFileSync(new URL('../locales/es.json', import.meta.url), 'utf8')
    const hits = raw.split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => violates(line))
    expect(hits.map((h) => `es.json:${h.index + 1} ${h.line.trim()}`)).toEqual([])
  })

  test('and so is every source string under app/ and lib/', () => {
    const offenders: string[] = []
    const visit = (relative: string) => {
      for (const entry of readdirSync(new URL(`../${relative}`, import.meta.url), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        const child = `${relative}/${entry.name}`
        if (entry.isDirectory()) visit(child)
        else if (/\.tsx?$/.test(entry.name)) {
          readFileSync(new URL(`../${child}`, import.meta.url), 'utf8').split('\n').forEach((line, index) => {
            if (violates(line)) offenders.push(`${child}:${index + 1} ${line.trim()}`)
          })
        }
      }
    }
    visit('app')
    visit('lib')
    expect(offenders).toEqual([])
  })

  test('the guard still allows every legitimate use — it bans a word, not a stem', () => {
    for (const legal of [
      'Monto total', 'el monto de la venta', 'montos liquidados', 'tres montos sugeridos, rango del monto libre',
      'Bicicleta de montaña Trek', 'Cadereyta de Montes', 'montaje',
    ]) {
      expect(violates(legal), `"${legal}" must stay legal`).toBe(false)
    }
    for (const banned of [
      'Monta la tienda', 'lo deja montado', 'te ayuda a montar tu catálogo', 'Montamos tu catálogo',
      // The gerund is here because the first version of this guard MISSED it: the sweep
      // caught the dictionary and left `ganar comisión montando tiendas` live in
      // lib/agent-prompt.ts, rendered inside the promoter page's own prompt block.
      'ganar comisión montando tiendas', 'móntala hoy',
    ]) {
      expect(violates(banned), `"${banned}" must be caught`).toBe(true)
    }
  })
})
