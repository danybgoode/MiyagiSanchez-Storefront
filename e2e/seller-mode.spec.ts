import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { isSellerModePath } from '../lib/seller-mode'
import { isSellShellCandidatePath } from '../lib/sell-shell-path'
import {
  SELLER_NAV,
  SELLER_NAV_MOBILE_PRIMARY,
  SELLER_NAV_MOBILE_OVERFLOW_GROUPS,
  activeSellerNavHref,
  filterNavByEnabledFlags,
  filterEntriesByEnabledFlags,
  hasRelayBadge,
  type SellerNavEntry,
} from '../lib/seller-nav'
import type { FlagKey } from '../lib/flags'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * Seller-mode shell — pure logic (api gate, no browser). The root layout reads
 * `isSellerModePath` to suppress buyer chrome and `SellerNav` reads the config +
 * matcher, so the suppression boundary and the nav can't drift from the test.
 *
 * Every `/shop/manage/*` route asserted here is confirmed present in the repo.
 */

// The real manage sub-pages a nav entry may legitimately target (besides the
// `/shop/manage` dashboard itself). Kept in lockstep with app/shop/manage/*.
const REAL_MANAGE_ROUTES = new Set([
  '/shop/manage',
  '/shop/manage/orders',
  '/shop/manage/en-persona',
  '/shop/manage/cobros',
  '/shop/manage/offers',
  '/shop/manage/catalogo',
  '/shop/manage/analytics',
  '/shop/manage/profit',
  '/shop/manage/collections',
  '/shop/manage/canal-propio',
  '/shop/manage/promotions',
  '/shop/manage/subscriptions',
  '/shop/manage/content',
  '/shop/manage/eventos',
  '/shop/manage/sweepstakes',
  '/shop/manage/import',
  '/shop/manage/mercadolibre',
  '/shop/manage/settings',
  // Living Shop (epic 07) — the Wall/Sections/Theme/Brand studio. This set is a
  // deliberate ALLOW-LIST, not a filesystem scan: its job is "no new pages by
  // accident", so a genuinely new page is added here on purpose, in the same
  // commit that adds the nav entry.
  '/shop/manage/tienda',
])

function hrefPath(href: string): string {
  const i = href.indexOf('#')
  return i === -1 ? href : href.slice(0, i)
}

test.describe('seller-mode · isSellerModePath', () => {
  test('matches the manage surface and everything beneath it', () => {
    expect(isSellerModePath('/shop/manage')).toBe(true)
    expect(isSellerModePath('/shop/manage/orders')).toBe(true)
    expect(isSellerModePath('/shop/manage/orders/ord_42')).toBe(true)
    expect(isSellerModePath('/shop/manage/settings/payments')).toBe(true)
  })

  test('does not match buyer routes', () => {
    expect(isSellerModePath('/')).toBe(false)
    expect(isSellerModePath('/l')).toBe(false)
    expect(isSellerModePath('/l/abc')).toBe(false)
    expect(isSellerModePath('/account')).toBe(false)
    expect(isSellerModePath('/account/orders')).toBe(false)
    expect(isSellerModePath('/sell')).toBe(false)
    expect(isSellerModePath('/vecindario')).toBe(false)
    expect(isSellerModePath('')).toBe(false)
  })

  test('does not match a route that merely shares the prefix (no boundary slash)', () => {
    expect(isSellerModePath('/shop/managexyz')).toBe(false)
    expect(isSellerModePath('/shop/manager')).toBe(false)
    expect(isSellerModePath('/shop')).toBe(false)
  })
})

/**
 * seller-shell-gate (catalog-management epic, Sprint 6 · Story 6.1) — the
 * owner-aware seller shell over /sell + /sell/setup for a signed-in shop
 * owner. Deliberately a SEPARATE predicate from `isSellerModePath` above (that
 * one stays pure/path-only and is unchanged by this story — see the block
 * above still asserting `isSellerModePath('/sell') === false`).
 *
 * `isSellShellCandidatePath` is the pure fast-path `sellShellEligible` gates
 * on before touching Clerk/Medusa/the flag store — the only part directly
 * testable without a live server. The full `sellShellEligible` (auth + flag +
 * Medusa ownership) needs a live Clerk session and a real/mocked Medusa
 * response, so it's NOT covered here:
 *   - the authed owner-shell on /sell + /sell/setup, and the
 *     `seller.shell_on_sell_enabled` flag-OFF instant revert, are the
 *     sprint's stated "owed to Daniel" browser smokes (sprint-6.md);
 *   - the signed-out /sell buyer-chrome case is coverable anonymously by the
 *     browser project (no Clerk session needed) but is out of scope for this
 *     `api` spec.
 */
test.describe('seller-mode · isSellShellCandidatePath', () => {
  test('matches exactly /sell and /sell/setup', () => {
    expect(isSellShellCandidatePath('/sell')).toBe(true)
    expect(isSellShellCandidatePath('/sell/setup')).toBe(true)
  })

  test('does not match sibling /sell/* routes (not a prefix match)', () => {
    expect(isSellShellCandidatePath('/sell/edit/abc123')).toBe(false)
    expect(isSellShellCandidatePath('/sell/print/ed_1')).toBe(false)
    expect(isSellShellCandidatePath('/sell/')).toBe(false)
  })

  test('does not match unrelated routes, including /shop/manage', () => {
    expect(isSellShellCandidatePath('/shop/manage')).toBe(false)
    expect(isSellShellCandidatePath('/')).toBe(false)
    expect(isSellShellCandidatePath('')).toBe(false)
  })
})

test.describe('seller-mode · SELLER_NAV config', () => {
  test('has the four expected groups in order', () => {
    expect(SELLER_NAV.map(g => g.label)).toEqual(['Operar', 'Catálogo', 'Crecer', 'Configuración'])
  })

  test('every entry targets a real manage route (no new pages)', () => {
    for (const group of SELLER_NAV) {
      for (const entry of group.entries) {
        expect(REAL_MANAGE_ROUTES.has(hrefPath(entry.href)), `${entry.label} → ${entry.href}`).toBe(true)
      }
    }
  })

  test('labels match the sprint spec', () => {
    expect(SELLER_NAV[0].entries.map(e => e.label)).toEqual(['Resumen', 'Pedidos', 'Ofertas', 'Vender en persona', 'Cobrar con un link'])
    expect(SELLER_NAV[1].entries.map(e => e.label)).toEqual(['Anuncios', 'Colecciones', 'Canales', 'Mercado Libre', 'Importar catálogo'])
    expect(SELLER_NAV[2].entries.map(e => e.label)).toEqual([
      'Cupones', 'Suscripciones', 'Contenido', 'Eventos', 'Sorteos', 'Analíticas', 'Ganancias',
    ])
    expect(SELLER_NAV[3].entries.map(e => e.label)).toEqual(['Mi tienda', 'Configuración'])
  })

  test('every entry has a stable key and an Iconoir class', () => {
    const keys = SELLER_NAV.flatMap(g => g.entries.map(e => e.key))
    expect(new Set(keys).size).toBe(keys.length) // unique
    for (const group of SELLER_NAV) {
      for (const entry of group.entries) {
        expect(entry.icon.startsWith('iconoir-')).toBe(true)
      }
    }
  })
})

// ── Story 5.1 — R13 flag-safe nav parity ────────────────────────────────────

test.describe('seller-mode · filterNavByEnabledFlags (R13 flag-safe nav parity)', () => {
  test('Ganancias carries the ops.profit_enabled gate', () => {
    const ganancias = SELLER_NAV[2].entries.find(e => e.key === 'ganancias')
    expect(ganancias?.flag).toBe('ops.profit_enabled')
  })

  test('flag OFF: Ganancias is absent from the rail; every other entry stays', () => {
    const filtered = filterNavByEnabledFlags(SELLER_NAV, new Set<FlagKey>())
    const allLabels = filtered.flatMap(g => g.entries.map(e => e.label))
    expect(allLabels).not.toContain('Ganancias')
    // Nothing else in Crecer was dropped — the group itself survives (6 of 7 left).
    const crecer = filtered.find(g => g.key === 'crecer')
    expect(crecer?.entries.map(e => e.label)).toEqual([
      'Cupones', 'Suscripciones', 'Contenido', 'Eventos', 'Sorteos', 'Analíticas',
    ])
  })

  test('flag ON: Ganancias is present in the rail, in its original position', () => {
    const filtered = filterNavByEnabledFlags(SELLER_NAV, new Set<FlagKey>(['ops.profit_enabled']))
    const crecer = filtered.find(g => g.key === 'crecer')
    expect(crecer?.entries.map(e => e.label)).toEqual([
      'Cupones', 'Suscripciones', 'Contenido', 'Eventos', 'Sorteos', 'Analíticas', 'Ganancias',
    ])
  })

  test('a group left with zero entries after filtering is dropped entirely (defensive)', () => {
    const oneEntryGroup = [{ key: 'x', label: 'X', entries: [{ key: 'y', label: 'Y', href: '/shop/manage/y', icon: 'iconoir-y', flag: 'ops.profit_enabled' as FlagKey }] }]
    expect(filterNavByEnabledFlags(oneEntryGroup, new Set<FlagKey>())).toEqual([])
  })

  test('filterEntriesByEnabledFlags applies the same gate to a flat entry list (the mobile primary bar)', () => {
    const gatedEntries = [{ key: 'ganancias', label: 'Ganancias', href: '/shop/manage/profit', icon: 'iconoir-coins', flag: 'ops.profit_enabled' as FlagKey }, ...SELLER_NAV_MOBILE_PRIMARY]
    expect(filterEntriesByEnabledFlags(gatedEntries, new Set<FlagKey>()).map(e => e.label)).not.toContain('Ganancias')
    expect(filterEntriesByEnabledFlags(gatedEntries, new Set<FlagKey>(['ops.profit_enabled'])).map(e => e.label)).toContain('Ganancias')
  })
})

// ── Story 5.2 — mobile bar redesign (F5) ────────────────────────────────────

test.describe('seller-mode · mobile bar shape (Story 5.2)', () => {
  test('primary bar is exactly 3 data-backed slots: Resumen, Pedidos, Anuncios', () => {
    expect(SELLER_NAV_MOBILE_PRIMARY.map(e => e.key)).toEqual(['resumen', 'pedidos', 'anuncios'])
  })

  test('Anuncios carries the "Catálogo" mobile-only label override (rail keeps "Anuncios")', () => {
    const anuncios = SELLER_NAV_MOBILE_PRIMARY.find(e => e.key === 'anuncios')
    expect(anuncios?.label).toBe('Anuncios')
    expect(anuncios?.mobileLabel).toBe('Catálogo')
  })

  test('"Más" sheet has exactly 4 groups: Operar, Catálogo, Crecer (grid), Configuración', () => {
    expect(SELLER_NAV_MOBILE_OVERFLOW_GROUPS.map(g => ({ key: g.key, label: g.label, layout: g.layout ?? 'list' }))).toEqual([
      { key: 'operar', label: 'Operar', layout: 'list' },
      { key: 'catalogo', label: 'Catálogo', layout: 'list' },
      { key: 'crecer', label: 'Crecer', layout: 'grid' },
      { key: 'configuracion', label: 'Configuración', layout: 'list' },
    ])
  })

  test('completeness guard: every SELLER_NAV entry not promoted to the primary bar appears in exactly one overflow group (nothing silently vanishes)', () => {
    const primaryKeys = new Set(SELLER_NAV_MOBILE_PRIMARY.map(e => e.key))
    const allKeys = SELLER_NAV.flatMap(g => g.entries.map(e => e.key))
    const expectedOverflowKeys = allKeys.filter(k => !primaryKeys.has(k))

    const overflowKeyCounts = new Map<string, number>()
    for (const group of SELLER_NAV_MOBILE_OVERFLOW_GROUPS) {
      for (const entry of group.entries) {
        overflowKeyCounts.set(entry.key, (overflowKeyCounts.get(entry.key) ?? 0) + 1)
      }
    }

    for (const key of expectedOverflowKeys) {
      expect(overflowKeyCounts.get(key), `${key} should appear in exactly one overflow group`).toBe(1)
    }
    // And nothing extra: every overflow entry is one of the expected keys.
    expect([...overflowKeyCounts.keys()].sort()).toEqual([...expectedOverflowKeys].sort())
  })

  test('flag OFF: Ganancias absent from the Crecer overflow group; flag ON: present', () => {
    const off = filterNavByEnabledFlags(SELLER_NAV_MOBILE_OVERFLOW_GROUPS, new Set<FlagKey>())
    expect(off.find(g => g.key === 'crecer')?.entries.map(e => e.key)).not.toContain('ganancias')

    const on = filterNavByEnabledFlags(SELLER_NAV_MOBILE_OVERFLOW_GROUPS, new Set<FlagKey>(['ops.profit_enabled']))
    expect(on.find(g => g.key === 'crecer')?.entries.map(e => e.key)).toContain('ganancias')
  })
})

test.describe('seller-mode · hasRelayBadge (Story 5.2 — "Más" trigger relay dot)', () => {
  const groups: { entries: SellerNavEntry[] }[] = [
    { entries: [{ key: 'ofertas', label: 'Ofertas', href: '/shop/manage/offers', icon: 'iconoir-hand-cash' }] },
  ]

  test('true when an overflow entry has a nonzero badge', () => {
    expect(hasRelayBadge(groups, { ofertas: 2 })).toBe(true)
  })

  test('false when no badges are set, or all are zero', () => {
    expect(hasRelayBadge(groups, {})).toBe(false)
    expect(hasRelayBadge(groups, { ofertas: 0 })).toBe(false)
  })

  test('false for a badge on an entry not in any overflow group (e.g. Pedidos, which lives in the primary bar)', () => {
    expect(hasRelayBadge(groups, { pedidos: 5 })).toBe(false)
  })
})

// ── Story 5.3 — one import door + mobile restore (F7, narrowed scope) ──────
// Confirmed scope: only ManageDashboard.tsx's mobile-hidden "Importar" button is
// fixed; the settings-page banner stays on its own distinct /shop/manage/settings/import
// (store-configuration import — a different feature, not touched here).

test.describe('seller-mode · Importar button mobile restore (Story 5.3, static source scan)', () => {
  test('ManageDashboard.tsx: Importar is no longer mobile-hidden, and still routes to /shop/manage/import', async () => {
    const content = await readFile(path.join(repoRoot, 'app/(shell)/shop/manage/ManageDashboard.tsx'), 'utf8')
    const importarBlockMatch = content.match(/<Link\s+href="\/shop\/manage\/import"[\s\S]{0,120}?>/)
    expect(importarBlockMatch, 'Importar <Link> block not found').not.toBeNull()
    const block = importarBlockMatch![0]
    expect(block).not.toMatch(/hidden\s+sm:inline-block/)
    expect(block).toContain('href="/shop/manage/import"')
  })

  test('settings/page.tsx import banner is untouched — stays on its own distinct route', async () => {
    const content = await readFile(path.join(repoRoot, 'app/(shell)/shop/manage/settings/page.tsx'), 'utf8')
    expect(content).toContain('href="/shop/manage/settings/import"')
  })
})

test.describe('seller-mode · activeSellerNavHref', () => {
  test('dashboard highlights Resumen', () => {
    expect(activeSellerNavHref('/shop/manage')).toBe('/shop/manage')
  })

  test('a sub-page highlights its own entry by longest prefix', () => {
    expect(activeSellerNavHref('/shop/manage/orders')).toBe('/shop/manage/orders')
    expect(activeSellerNavHref('/shop/manage/orders/ord_42')).toBe('/shop/manage/orders')
    expect(activeSellerNavHref('/shop/manage/catalogo')).toBe('/shop/manage/catalogo')
    expect(activeSellerNavHref('/shop/manage/settings')).toBe('/shop/manage/settings')
    expect(activeSellerNavHref('/shop/manage/settings/payments')).toBe('/shop/manage/settings')
    expect(activeSellerNavHref('/shop/manage/analytics')).toBe('/shop/manage/analytics')
    expect(activeSellerNavHref('/shop/manage/subscriptions')).toBe('/shop/manage/subscriptions')
    expect(activeSellerNavHref('/shop/manage/content')).toBe('/shop/manage/content')
    expect(activeSellerNavHref('/shop/manage/sweepstakes')).toBe('/shop/manage/sweepstakes')
  })

  test('returns null off the seller surface', () => {
    expect(activeSellerNavHref('/account')).toBeNull()
    expect(activeSellerNavHref('/')).toBeNull()
    expect(activeSellerNavHref('')).toBeNull()
  })
})

// ── R2 — one .btn-primary per view ──────────────────────────────────────────

/**
 * `/shop/manage` and `/shop/manage/orders` are Clerk-gated, so an anonymous
 * `request` fixture hit just redirects to /sign-in — there's no rendered HTML
 * to grep. Instead this statically scans the route's own source files for
 * `btn-primary` occurrences, mirroring `lib/design-token-audit.ts`'s file-scan
 * pattern. This is an APPROXIMATION: it counts JSX occurrences in source, not
 * what actually renders for a given order/listing at runtime (conditional
 * branches that never render simultaneously are still counted together).
 *
 * Counts BOTH the raw `.btn-primary` class string AND `<Button variant="primary">`
 * usage — once a route adopts the shared `<Button>` component (Sprint 2's
 * adoption sweep), the literal string "btn-primary" moves into Button.tsx's
 * own source and stops appearing in the route file at all, which would
 * silently defeat a class-string-only scan (always counting 0).
 */
function countBtnPrimaryInSource(content: string): number {
  const rawClass = (content.match(/\bbtn-primary\b/g) ?? []).length
  const buttonComponent = (content.match(/<Button\b[^>]*\bvariant=["']primary["']/g) ?? []).length
  return rawClass + buttonComponent
}

async function countBtnPrimary(relPaths: string[]): Promise<number> {
  let total = 0
  for (const relPath of relPaths) {
    const content = await readFile(path.join(repoRoot, relPath), 'utf8')
    total += countBtnPrimaryInSource(content)
  }
  return total
}

/**
 * Per-step/per-section scan for a file whose whole-file `.btn-primary` count is
 * NOT ≤1 by design — e.g. a multi-step wizard where each step has its own primary
 * CTA, but only one step ever renders at a time. Slices the source between each
 * named top-level function's declaration and the next one (or EOF), so a real
 * regression (two primary buttons within the SAME step/section) still fails,
 * without the whole-file total falsely tripping the assertion.
 */
async function countBtnPrimaryPerFunction(relPath: string, functionNames: string[]): Promise<Record<string, number>> {
  const content = await readFile(path.join(repoRoot, relPath), 'utf8')
  const starts = functionNames
    .map((name) => ({ name, index: content.indexOf(`function ${name}(`) }))
    .filter((f) => f.index !== -1)
    .sort((a, b) => a.index - b.index)

  const counts: Record<string, number> = {}
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].index
    const to = i + 1 < starts.length ? starts[i + 1].index : content.length
    counts[starts[i].name] = countBtnPrimaryInSource(content.slice(from, to))
  }
  return counts
}

test.describe('seller-mode · R2 one .btn-primary per view (static source scan)', () => {
  test('/shop/manage renders at most one .btn-primary', async () => {
    const count = await countBtnPrimary([
      'app/(shell)/shop/manage/page.tsx',
      'app/(shell)/shop/manage/ManageDashboard.tsx',
    ])
    expect(count).toBeLessThanOrEqual(1)
  })

  test('/shop/manage/orders renders at most one .btn-primary', async () => {
    const count = await countBtnPrimary([
      'app/(shell)/shop/manage/orders/page.tsx',
      'app/(shell)/shop/manage/orders/OrdersInbox.tsx',
      'app/(shell)/shop/manage/orders/[id]/page.tsx',
      'app/(shell)/shop/manage/orders/[id]/OrderDetail.tsx',
    ])
    expect(count).toBeLessThanOrEqual(1)
  })

  // seller-portal-rails-foundation S2 · Story 2.1 adoption sweep — newly-swept routes.
  test('/shop/manage/offers renders at most one .btn-primary', async () => {
    const count = await countBtnPrimary([
      'app/(shell)/shop/manage/offers/page.tsx',
      'app/(shell)/shop/manage/offers/OfferInbox.tsx',
    ])
    expect(count).toBeLessThanOrEqual(1)
  })

  // /sell (SellWizard) is a 3-step wizard — only one step ever renders at once, so
  // the assertion is per-step, not whole-file (StepShop/StepListing each have their
  // own "Continue"/"Publish" CTA; StepSuccess has its own primary CTA anchor).
  test('/sell renders at most one primary CTA per wizard step', async () => {
    const counts = await countBtnPrimaryPerFunction('app/(shell)/sell/SellWizard.tsx', [
      'StepShop', 'StepListing', 'StepSuccess',
    ])
    expect(Object.keys(counts)).toEqual(['StepShop', 'StepListing', 'StepSuccess'])
    for (const [step, count] of Object.entries(counts)) {
      expect(count, `${step} primary CTA count`).toBeLessThanOrEqual(1)
    }
  })

  // /sell/setup (SetupClient) is NOT covered by an equivalent per-section count:
  // FirstRunApply alone has 2 mutually-exclusive conditional states (paste form vs
  // staging preview) inside one function, so a function-boundary slice can't tell
  // them apart without parsing the JSX conditionals themselves — not worth building
  // for this static-scan APPROXIMATION (see the file-level docstring above).
})
