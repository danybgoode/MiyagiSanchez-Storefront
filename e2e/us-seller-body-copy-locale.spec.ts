import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const ROOT = path.resolve(import.meta.dirname, '..')
const source = (relativePath: string) => readFileSync(path.join(ROOT, relativePath), 'utf8')

test('seller body copy is a complete market-derived transform and MX remains the original', async () => {
  const transformPath = path.join(ROOT, 'lib/seller-copy.ts')
  const populationPath = path.join(ROOT, 'scripts/derive-seller-locale-population.ts')

  // This assertion is deliberately first: the spec was observed red while the
  // transform did not exist, before any implementation was added.
  expect(existsSync(transformPath)).toBe(true)
  expect(existsSync(populationPath)).toBe(true)

  const [{ deriveSellerLocalePopulation, serializeSellerLocalePopulation }, sellerCopy] = await Promise.all([
    import('../scripts/derive-seller-locale-population'),
    import('../lib/seller-copy'),
  ])
  const es = JSON.parse(source('locales/es.json')) as { sellerCopy: Record<string, string> }
  const en = JSON.parse(source('locales/en.json')) as { sellerCopy: Record<string, string> }
  const population = deriveSellerLocalePopulation(ROOT)

  expect(population.direct.length).toBeGreaterThan(100)
  expect(population.entries.length).toBeGreaterThan(500)
  expect(population.direct).toContain('app/(shell)/shop/manage/ManageDashboard.tsx')
  expect(population.direct).toContain('app/(shell)/sell/SellWizard.tsx')
  expect(population.entries.map(({ source }) => source)).toEqual(expect.arrayContaining([
    'Pago pendiente',
    'Sin uso, en empaque original',
    'Error al subir. Toca para reintentar.',
    'Guardar cambios',
  ]))
  expect(source('locales/seller-population.json')).toBe(serializeSellerLocalePopulation(population))

  const expectedKeys = population.entries.map(({ key }) => key).sort()
  expect(Object.keys(es.sellerCopy).sort()).toEqual(expectedKeys)
  expect(Object.keys(en.sellerCopy).sort()).toEqual(expectedKeys)
  for (const { key, source: original } of population.entries) {
    expect(es.sellerCopy[key]).toBe(original)
    expect(new Set(en.sellerCopy[key].match(/\{\d+\}/g) ?? [])).toEqual(
      new Set(original.match(/\{\d+\}/g) ?? []),
    )
  }

  for (const brand of ['Miyagi Sánchez', 'Mercado Libre', 'Mercado Pago', 'MercadoPago', 'Stripe', 'WhatsApp']) {
    for (const { key, source: original } of population.entries.filter(({ source }) => source.includes(brand))) {
      expect(en.sellerCopy[key], `${brand} changed in ${original}`).toContain(brand)
    }
  }

  const copy = sellerCopy.createSellerCopyTransform(population.entries, en.sellerCopy)
  // Spanish is the authored source, so it is the identity case; English is the
  // only transform. The switch is the render LOCALE, not the shop's market — the
  // market only supplies the default (lib/seller-locale.ts).
  expect(copy('Guardar cambios', 'es')).toBe('Guardar cambios')
  expect(copy('Guardar cambios')).toBe('Guardar cambios')
  expect(copy('Guardar cambios', 'en')).toBe('Save changes')
  expect(copy('Importar catálogo', 'en')).toBe('Import catalog')
  expect(copy('Crea una nueva API key (nombre: “Miyagi Sánchez”)', 'en')).toBe(
    'Create a new API key (name: “Miyagi Sánchez”)',
  )
  expect(copy('Mercado Libre', 'en')).toBe('Mercado Libre')
  expect(copy('Stripe · MercadoPago · WhatsApp', 'en')).toBe('Stripe · MercadoPago · WhatsApp')
  expect(copy('Sin traducir', 'es')).toBe('Sin traducir')

  const attributes = { href: '/shop/manage', icon: 'iconoir-shop', key: 'shop', title: 'Guardar cambios' }
  expect(sellerCopy.localizeSellerAttributes(attributes, 'es', copy)).toEqual(attributes)
  expect(sellerCopy.localizeSellerAttributes(attributes, 'en', copy)).toEqual({
    href: '/shop/manage',
    icon: 'iconoir-shop',
    key: 'shop',
    title: 'Save changes',
  })

  const manageLayout = source('app/(shell)/shop/manage/layout.tsx')
  const sellLayout = source('app/(shell)/sell/layout.tsx')
  const boundary = source('app/components/SellerCopyBoundary.tsx')
  for (const layout of [manageLayout, sellLayout]) {
    expect(layout).toContain('getMySeller()')
    // The market is still read, but only to DEFAULT the locale — the seller's
    // stored preference is what decides, and Spanish still short-circuits before
    // any boundary or dictionary enters the render path.
    expect(layout).toContain('seller?.market')
    expect(layout).toContain('resolveSellerLocale(')
    expect(layout).toContain('preference: await getLanguagePreference()')
    expect(layout).toContain('SellerCopyBoundary')
    expect(layout).toContain('if (!sellerCopyBoundaryNeeded(locale)) return content')
    expect(layout).not.toContain("if (market !== 'us') return content")
  }
  const sellPage = source('app/(shell)/sell/page.tsx')
  expect(sellPage).toContain('resolveSellerSignupMarket(marketParam)')
  expect(sellPage).not.toMatch(/normalizeLocale|accept-language/i)
  expect(boundary).not.toMatch(/normalizeLocale|accept-language/i)
})

test('the population covers every directory the boundary renders, and the portal\'s toast helper', async () => {
  const { deriveSellerLocalePopulation } = await import('../scripts/derive-seller-locale-population')
  const population = deriveSellerLocalePopulation(ROOT)
  const collected = new Set(population.entries.map(({ source }) => source))

  // The boundary translates everything beneath it, but only from strings this
  // scan collected. When the depth pass moved shared seller components into
  // `components/seller`, their copy left the population and an English portal
  // rendered Spanish undo toasts with every gate green.
  expect(population.direct).toContain('components/seller/PendingListingDeleteProvider.tsx')

  // GUARD THE POPULATION, NOT A SAMPLE: `showToast` is how the portal talks to a
  // merchant in 60+ places, and none of it was collected. Rather than pin two
  // examples, sweep every literal first argument in the portal and require it.
  const walk = (dir: string): string[] => {
    const absolute = path.join(ROOT, dir)
    if (!existsSync(absolute)) return []
    return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(dir, entry.name))
        : entry.name.endsWith('.tsx') ? [path.join(dir, entry.name)] : [],
    )
  }
  const files = ['app/(shell)/shop/manage', 'app/(shell)/sell', 'components/seller'].flatMap(walk)

  const uncollected: string[] = []
  for (const file of files) {
    for (const [, , literal] of source(file).matchAll(/showToast\(\s*(['"])((?:[^\\]|\\.)*?)\1/g)) {
      const value = literal.replace(/\\(['"])/g, '$1').replace(/\s+/g, ' ').trim()
      if (/[\p{L}]/u.test(value) && !collected.has(value)) uncollected.push(`${file}: ${value}`)
    }
  }
  expect(uncollected, 'showToast copy missing from the seller population').toEqual([])

  // The second argument is a machine-readable toast type, not copy. Collecting it
  // would put "success"/"error" in the population, where they would be matched
  // against real page text.
  expect(collected.has('success')).toBe(false)
  expect(collected.has('error')).toBe(false)
})
