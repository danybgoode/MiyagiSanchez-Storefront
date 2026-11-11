import { isFoundersPrice } from '../lib/promoter-packages'
import { expect, test } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import { sellerTrustPrompt } from '../lib/seller-acquisition'
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
    expect(anchor).toContain('https://miyagisanchez.com/')
    expect(anchor).not.toContain('/mx/vende')
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

  test('the promoter page sells only the three options, each with its money in plain words (Daniel, 2026-11-05)', () => {
    const rates = {
      custom_domain: 0, print_ad: 0, subdomain: 0, ml_sync: 0, migration: 0, negocio_anual: 55, negocio_arranque: 50, setup_gratis: 80,
      negocio_renewal: 10, tienda_anual: 60, negocio_semestral: 55, tienda_renewal: 10, negocio_upgrade: 20,
    }
    const config = buildPromoterPageConfig(fullCopy, { customDomainPriceMxn: 499, enabled: true, commissionRates: rates })
    // plan-tienda D11: the three packages on sale; the retired two never appear for sale.
    expect(config.proofPoints.map((p) => p.title)).toEqual(['Plan Tienda · 1 año', 'Plan Negocio · 6 meses', 'Plan Negocio · 1 año'])
    // The money first, then what the merchant gets, with the three free months on top.
    // Tienda shows today's price: the founders' $250 until the end of 2026 (Daniel 2026-11-11), then the list $500.
    const tiendaLine = isFoundersPrice('tienda_anual')
      ? 'Cobras $250. Le pasas $100 a Miyagi Sánchez. Te quedas $150.'
      : 'Cobras $500. Le pasas $200 a Miyagi Sánchez. Te quedas $300.'
    expect(config.proofPoints[0].body.startsWith(tiendaLine)).toBe(true)
    expect(config.proofPoints[1].body.startsWith('Cobras $1,100. Le pasas $495 a Miyagi Sánchez. Te quedas $605.')).toBe(true)
    expect(config.proofPoints[2].body.startsWith('Cobras $2,000. Le pasas $900 a Miyagi Sánchez. Te quedas $1,100.')).toBe(true)
    for (const p of config.proofPoints) expect(p.body).toContain('3 meses gratis van además del tiempo pagado')
    expect(JSON.stringify(config.proofPoints)).not.toMatch(/Plan Gratis|3 meses \(|Plan Negocio · 3 meses/)
    // The retired single products and the printed ad are gone, and so is the old "your code is a discount" claim.
    const words = JSON.stringify(promoterCopy)
    for (const gone of ['Anuncio impreso', 'Subdominio', 'descuento', 'Muy pronto']) expect(words).not.toContain(gone)
    // The renewal share is a stat read from the live rate, never typed.
    expect(config.socialStats.map((s) => s.value)).toContain('10%')
  })

  test('no "cerrar / cierre" vocabulary on the promoter page, the guide or the migration guide (Daniel, 2026-11-05)', () => {
    // The workspace URL /promotor/cerrar is the only allowed occurrence: it is an address, not a word a promoter reads.
    const words = JSON.stringify([promoterCopy, fullCopy.promotorMigracion]).replaceAll('/promotor/cerrar', '/promotor/[panel]')
    expect(words).not.toMatch(/cerrar|cierre|cierra/i)
  })

  test('the 1-year option never promises to BUY a domain: a domain the merchant has is connected', () => {
    expect(promoterCopy.guide.say.negocio_anual).toContain('Si tienes un dominio')
    expect(promoterCopy.guide.say.negocio_anual).not.toMatch(/[Ii]ncluye tu propio dominio/)
  })

  test('a not-yet-bound visitor gets the apply CTA, never the dead-ended workspace CTA', () => {
    const config = buildPromoterPageConfig(fullCopy, { customDomainPriceMxn: 499, enabled: true, isBoundPromoter: false })
    expect(config.primaryCta?.label).toBe('Quiero ser promotor')
    expect(config.primaryCta?.label).not.toBe('Abrir mi panel')
    // Never a dead link: the apply CTA anchors to the on-page teaser, not a route.
    expect(config.primaryCta?.href).toBe('#promotor-aplica')
    expect(config.applyTeaser?.id).toBe('promotor-aplica')
  })

  test('a bound promoter keeps the real close-workspace CTA', () => {
    const config = buildPromoterPageConfig(fullCopy, { customDomainPriceMxn: 499, enabled: true, isBoundPromoter: true })
    expect(config.primaryCta?.label).toBe('Abrir mi panel')
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
