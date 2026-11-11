import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {
  listingHref,
  shopListingBase,
  SHOP_SCOPED_PDP_MARKET_BASE,
  shopInitials,
  heroContent,
  trustChips,
  hasShopStatus,
  relativeDay,
  railOccupiesTrack,
  railPanels,
} from '../lib/shop-presentation/chrome'
import { PRESET_RECIPES, THEME_RECIPE_FIELDS } from '../lib/shop-presentation/theme'

const ROOT = path.resolve(import.meta.dirname, '..')

/**
 * Living Shop · Sprint 8 — the shop's own chrome.
 *
 * The governing rule these specs exist to hold: **a panel with nothing real
 * behind it does not render.** The design concept is full of plausible copy —
 * "Usually ships in 2–4 days", "Next market: Roma Norte" — and inventing that
 * for a shop that never configured it would put a promise on a merchant's
 * storefront that they never made.
 *
 * Observed red by: making `heroContent().substantial` always true (the
 * nothing-to-say case failed), by having `railOccupiesTrack` ignore its panel
 * count (the empty-column case failed), and by returning all three trust chips
 * unconditionally (the only-real-facts case failed).
 */

test.describe('chrome · identity', () => {
  test('initials come from the first two words', () => {
    expect(shopInitials('Soft Signal Studio')).toBe('SS')
    expect(shopInitials('Panfleto')).toBe('PA')
    expect(shopInitials('  Champions   not  ')).toBe('CN')
  })

  test('a nameless shop still renders something rather than crashing', () => {
    expect(shopInitials('')).toBe('?')
    expect(shopInitials('   ')).toBe('?')
  })

  test('accents and non-Latin names survive', () => {
    expect(shopInitials('Ñandú Éditions')).toBe('ÑÉ')
  })
})

test.describe('chrome · the hero says nothing it was not told', () => {
  const shop = { name: 'Panfleto', description: null, location: null }

  test('a shop with a tagline leads with it', () => {
    const hero = heroContent(shop, 'Jah proveerá.')
    expect(hero.headline).toBe('Jah proveerá.')
    expect(hero.substantial).toBe(true)
  })

  test('a shop with only a description still earns a hero, headed by its name', () => {
    const hero = heroContent({ ...shop, description: 'Fanzines y rarezas.' }, null)
    expect(hero.headline).toBe('Panfleto')
    expect(hero.lead).toBe('Fanzines y rarezas.')
    expect(hero.substantial).toBe(true)
  })

  test('a shop with NEITHER gets no hero at all', () => {
    // The failure this prevents: the shop's own name restated at 64px over an
    // empty frame, which is worse than no hero.
    const hero = heroContent(shop, null)
    expect(hero.substantial).toBe(false)
  })

  test('whitespace is not content', () => {
    expect(heroContent(shop, '   ').substantial).toBe(false)
    expect(heroContent({ ...shop, description: '  ' }, null).substantial).toBe(false)
  })

  test('the eyebrow is the location, or nothing', () => {
    expect(heroContent({ ...shop, location: 'Puebla, Puebla' }, 'x').eyebrow).toBe('Puebla, Puebla')
    expect(heroContent(shop, 'x').eyebrow).toBeNull()
  })
})

test.describe('chrome · trust chips are facts, not decoration', () => {
  test('only what is true renders', () => {
    expect(trustChips({ verified: true, shipsNationwide: false, localPickup: true }).map((c) => c.key))
      .toEqual(['verified', 'pickup'])
  })

  test('a shop with none gets none', () => {
    expect(trustChips({ verified: false, shipsNationwide: false, localPickup: false })).toEqual([])
  })

  // The negation of what we ban — a guard that returned nothing always would
  // pass the test above for the wrong reason.
  test('a shop with all three gets all three', () => {
    expect(trustChips({ verified: true, shipsNationwide: true, localPickup: true })).toHaveLength(3)
  })
})

test.describe('chrome · shop status is real or absent', () => {
  test('no configured dispatch and no event means no panel', () => {
    expect(hasShopStatus({ dispatch: null, nextEvent: null })).toBe(false)
  })

  test('either fact alone earns the panel', () => {
    expect(hasShopStatus({ dispatch: '2–4 días', nextEvent: null })).toBe(true)
    expect(hasShopStatus({ dispatch: null, nextEvent: 'Feria · 22 ago' })).toBe(true)
  })
})

test.describe('chrome · relative dates compare CALENDAR days', () => {
  const now = new Date('2026-08-19T09:00:00.000Z')

  test('something posted late yesterday is "yesterday", not "today"', () => {
    // Elapsed-hours maths would call 23:00 yesterday "10 hours ago" → today,
    // which is not how a person reads their own wall.
    expect(relativeDay('2026-08-18T23:00:00.000Z', now)).toEqual({ kind: 'yesterday' })
  })

  test('earlier the same day is today', () => {
    expect(relativeDay('2026-08-19T01:00:00.000Z', now)).toEqual({ kind: 'today' })
  })

  test('within the week counts days; beyond it falls back to a date', () => {
    expect(relativeDay('2026-08-16T09:00:00.000Z', now)).toEqual({ kind: 'days', days: 3 })
    expect(relativeDay('2026-08-01T09:00:00.000Z', now)).toEqual({ kind: 'absolute' })
  })

  test('a malformed instant degrades to an absolute date rather than throwing', () => {
    expect(relativeDay('not-a-date', now)).toEqual({ kind: 'absolute' })
  })

  test('a future instant reads as today, never as negative days', () => {
    expect(relativeDay('2026-08-20T09:00:00.000Z', now)).toEqual({ kind: 'today' })
  })
})

test.describe('chrome · the rail closes the empty-column defect', () => {
  test('the second track opens whenever there is something to put in it', () => {
    // 🚨 THE REGRESSION THIS PINS. Sprint 4's feed-sidebar recipe made the Wall a
    // two-column grid whose only children were the post cards, so the cards
    // tiled into columns with nothing in the second track.
    expect(railOccupiesTrack(3)).toBe(true)
    expect(railOccupiesTrack(0)).toBe(false)
  })

  test('NO theme opts out of the shell — the layout is not a recipe choice', () => {
    // The design concept uses one Wall-beside-rail shell for all three of its
    // themes and overrides it for none. As a per-recipe axis it left the four
    // presets that predate the Wall rendering a lone column.
    for (const recipe of Object.values(PRESET_RECIPES)) {
      expect(Object.keys(recipe)).not.toContain('wall_layout')
    }
    expect(THEME_RECIPE_FIELDS).not.toContain('wall_layout')
  })

  test('the grid is opened by the SHELL, never by the feed itself', () => {
    // The defect's shape: a grid whose children are cards rather than
    // [main, rail]. The shell owns the columns; the feed stays one column.
    const css = readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8')
    expect(css).toMatch(/\.shop-shell\[data-rail="on"\]\s*\{[^}]*grid-template-columns/)
    expect(css).not.toMatch(/\.wall-feed\s*\{[^}]*grid-template-columns/)
  })
})

test.describe('chrome · Retro matches the concept, and stays accessible', () => {
  const css = readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8')

  test('the concept palette is present', () => {
    const retro = css.slice(css.indexOf('[data-shop-preset="retro"] {'))
    for (const token of ['#d7dbe8', '#f5f1ff', '#17153a', '#ff4fb3', '#2d245f', '#ffe96c']) {
      expect(retro, token).toContain(token)
    }
  })

  test('the signature elements exist: label bars, hard shadows, the grid background', () => {
    expect(css).toMatch(/\[data-shop-preset="retro"\][^{]*\[data-label\]::before/)
    expect(css).toMatch(/box-shadow:\s*3px 3px 0/)
    expect(css).toContain('background-size: 18px 18px')
  })

  test('CTA targets stay at least 44px, in every theme', () => {
    expect(css).toMatch(/\.shop-cta-primary[^{]*\{[\s\S]*?min-height:\s*44px/)
  })

  test('no era-authentic accessibility defect, in DECLARATIONS not prose', () => {
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const retro = declarations.slice(declarations.indexOf('[data-shop-preset="retro"]'))
    for (const banned of ['marquee', 'blink', 'animation-iteration-count: infinite']) {
      expect(retro.toLowerCase(), banned).not.toContain(banned)
    }
  })

  test('the shop header truncates a long name rather than wrapping', () => {
    expect(css).toMatch(/\.shop-name\s*\{[^}]*text-overflow:\s*ellipsis/)
  })
})

test.describe('chrome · no reactions, ever', () => {
  test('the Wall card has no like, share or save affordance', () => {
    // Product decision 8. The concept mockup shows "♡ 84 · Share · Save"; it is
    // illustrative, and this epic explicitly does not ship social reactions.
    // Comments stripped: the file's own header EXPLAINS that there is no
    // reaction or share UI, so scanning raw text finds the promise rather than a
    // breach of it. This suite has made that mistake three times now.
    const card = readFileSync(path.join(ROOT, 'app/(shell)/_wall/WallEntryCard.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    for (const banned of ['reaction', 'Compartir', '♡', 'onLike', 'Me gusta']) {
      expect(card.toLowerCase(), banned).not.toContain(banned.toLowerCase())
    }
  })
})

test.describe('chrome · the count and the render agree (reported live)', () => {
  test('an unclaimed shop with no About still COUNTS the panel it renders', () => {
    // 🚨 THE REPORTED BUG. The page counted panels from
    // [about||contacts, collections, dispatch] while ShopRail decided to render
    // the About panel from [about||chips||contacts||claim]. `el-manchon` — no
    // About, no contacts, unclaimed — rendered a panel the count said did not
    // exist, so the track never opened and the Wall spanned the page above a
    // lone floating panel. One function now answers for both.
    const panels = railPanels({
      about: null, chipCount: 0, contactCount: 0,
      hasClaim: true, collectionCount: 0, hasStatus: false,
    })
    expect(panels.about).toBe(true)
    expect(panels.count).toBe(1)
  })

  test('a shop with genuinely nothing has no rail at all', () => {
    const panels = railPanels({
      about: null, chipCount: 0, contactCount: 0,
      hasClaim: false, collectionCount: 0, hasStatus: false,
    })
    expect(panels.count).toBe(0)
    expect(railOccupiesTrack(panels.count)).toBe(false)
  })

  test('each input alone is enough for its own panel', () => {
    const base = { about: null, chipCount: 0, contactCount: 0, hasClaim: false, collectionCount: 0, hasStatus: false }
    expect(railPanels({ ...base, about: 'x' }).about).toBe(true)
    expect(railPanels({ ...base, chipCount: 1 }).about).toBe(true)
    expect(railPanels({ ...base, contactCount: 1 }).about).toBe(true)
    expect(railPanels({ ...base, collectionCount: 1 }).collections).toBe(true)
    expect(railPanels({ ...base, hasStatus: true }).status).toBe(true)
  })

  test('BOTH sides read railPanels — neither re-derives it', () => {
    // The trap is two expressions, not one wrong expression.
    const page = readFileSync(path.join(ROOT, 'app/(shell)/s/[slug]/ShopRenderer.tsx'), 'utf8')
    const rail = readFileSync(path.join(ROOT, 'app/(shell)/_shop-chrome/ShopRail.tsx'), 'utf8')
    expect(page).toContain('railPanels(')
    expect(rail).toContain('railPanels(')
    // And no hand-rolled `||` chain survives in either.
    expect(rail).not.toMatch(/showAbout\s*=\s*!!about/)
  })
})

test.describe('chrome · one header on every shop surface (reported live)', () => {
  test('ShopSectionNav renders the full header, not a bare chip strip', () => {
    // Reported: "going to /tienda changes the layout and the navbar moves to the
    // top left." The homepage had the Sprint 8 header while every other surface
    // kept the old strip — one shop, two chromes, depending on the link you
    // followed. Converged by making the nav BE the header.
    const nav = readFileSync(path.join(ROOT, 'app/(shell)/_shop-sections/ShopSectionNav.tsx'), 'utf8')
    expect(nav).toContain('ShopHeader')
    expect(nav).not.toContain('<nav')
  })

  test('every shop surface passes the shop identity through', () => {
    for (const file of [
      'app/(shell)/_shop-sections/ShopIndexBody.tsx',
      'app/(shell)/_shop-sections/CollectionsIndexBody.tsx',
      'app/(shell)/_shop-sections/EventsIndexBody.tsx',
      'app/(shell)/_shop-content/AcercaBody.tsx',
      'app/(shell)/_shop-content/FaqBody.tsx',
      'app/(shell)/_shop-content/PoliticasBody.tsx',
      'app/(shell)/_shop-collection/CollectionPage.tsx',
    ]) {
      const source = readFileSync(path.join(ROOT, file), 'utf8')
      expect(source, file).toMatch(/shopName=\{/)
    }
  })
})

test.describe('chrome · exactly one cart, and it is the platform’s', () => {
  test('the shop header carries no bag of its own', () => {
    // The concept renders a shop in isolation; this one lives inside the
    // marketplace chrome, which already carries the buyer's cart on every page.
    // Two bags two rows apart is two things to click for one job.
    const header = readFileSync(path.join(ROOT, 'app/(shell)/_shop-chrome/ShopHeader.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    expect(header).not.toContain('shop-bag')
    expect(header).not.toContain('cartHref')
  })
})

test.describe('chrome · the EMPTY WALL is the normal case, not an edge case', () => {
  test('a shop with only payment rails still earns a rail', () => {
    // Measured on the live population: 30/30 shops have a payment method while
    // only 2 have an About body and only 4 have any Wall entry. If commerce
    // signals did not count, the two-column shell would collapse on nearly every
    // real shop — which is the leftover-looking single column this change fixes.
    const panels = railPanels({
      about: null, chipCount: 2, contactCount: 0,
      hasClaim: false, collectionCount: 0, hasStatus: false,
    })
    expect(panels.about).toBe(true)
    expect(railOccupiesTrack(panels.count)).toBe(true)
  })

  test('and the WIRING actually feeds them in — both call sites', () => {
    // The test above proves the pure function. It stayed GREEN through a
    // mutation that stopped ShopRail passing signals at all, because a pure core
    // is only as true as its inputs. These assert the inputs.
    const rail = readFileSync(path.join(ROOT, 'app/(shell)/_shop-chrome/ShopRail.tsx'), 'utf8')
    expect(rail).toMatch(/chipCount:\s*chips\.length \+ signals\.length/)
    const page = readFileSync(path.join(ROOT, 'app/(shell)/s/[slug]/ShopRenderer.tsx'), 'utf8')
    expect(page).toMatch(/\+ railSignals\.length/)
  })

  test('the catalog shares the Wall’s column rather than a wider one', () => {
    // The page used to step from a 42rem feed to a 72rem grid, reading as two
    // pages stapled together. The grid now lives inside the shell's main track.
    const page = readFileSync(path.join(ROOT, 'app/(shell)/s/[slug]/ShopRenderer.tsx'), 'utf8')
    const shell = page.slice(page.indexOf('className="shop-shell"'), page.indexOf('<ShopRail'))
    expect(shell).toContain('ClosetListingCard')
    // And no wider container survives around it.
    expect(shell).not.toContain('max-w-6xl')
  })

  test('the Wall keeps a reading measure; the catalog does not', () => {
    const css = readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8')
    expect(css).toMatch(/\.shop-shell-main > \.wall-section \{[^}]*max-width:\s*42rem/)
  })

  test('trust signals moved INTO the rail, not duplicated beside it', () => {
    // Two copies of "acepta SPEI" on one page is worse than none.
    const page = readFileSync(path.join(ROOT, 'app/(shell)/s/[slug]/ShopRenderer.tsx'), 'utf8')
    expect(page).toContain('signals={railSignals}')
    // The old loose chip row is gone.
    expect(page).not.toMatch(/sellerHasMp && <span className="text-xs/)
  })
})

test.describe('chrome · no fact is claimed twice in one panel', () => {
  test('local pickup travels as a signal OR a chip, never both', () => {
    // Found by the codex cross-family review: `hasPickup` fed BOTH `trustChips`
    // and `railSignals`, and the Perfil panel renders both arrays — so a shop
    // with pickup said so twice, side by side. The signal wins because it can
    // name the actual spot ("Recolección local: Roma Norte"); the chip could
    // only say pickup exists.
    const page = readFileSync(path.join(ROOT, 'app/(shell)/s/[slug]/ShopRenderer.tsx'), 'utf8')
    const chipsCall = page.slice(page.indexOf('chips={trustChips({'), page.indexOf('collections={railCollections}'))
    expect(chipsCall).not.toMatch(/localPickup:\s*hasPickup/)
    // And the signal really is still there — the fix must not drop the fact.
    expect(page).toMatch(/key: 'pickup'/)
  })
})

test.describe('chrome · every shop product link opens a page that exists (reported live: 404, twice)', () => {
  test('on the Mexico marketplace a shop links its products to the SHOP-SCOPED PDP', () => {
    // 🚨 REPORTED LIVE 2026-11-11 (miel-verduras, a promoter training): a «Solo mi
    // tienda» product showed on /mx/s/<slug>/tienda and 404'd on click, because
    // the card pointed at /mx/l/<id> — the MARKETPLACE PDP, which only knows
    // products published into the Mexico marketplace. The shop-scoped PDP reads
    // through the shop's own channel, so it serves every product the shop shows.
    const base = shopListingBase({ onOwnedHost: false, marketBasePath: '/mx', shopSlug: 'miel-verduras' })
    expect(base).toBe('/mx/s/miel-verduras')
    expect(listingHref({ listingBase: base }, 'prod_1')).toBe('/mx/s/miel-verduras/l/prod_1')
  })

  test('the shop-scoped PDP route EXISTS — the first 404 was a link to a route that did not', () => {
    // 🚨 The earlier report (el-manchon, every card on /tienda 404'd) was links
    // built from the shop base while `/mx/s/<slug>/l/<id>` was not a route. The
    // link and the route must ship together; this pins the route's existence.
    const route = path.join(ROOT, 'app/(shell)/mx/s/[slug]/l/[id]/page.tsx')
    expect(existsSync(route), 'shop links point at /mx/s/<slug>/l/<id>, so that route must exist').toBe(true)
    expect(SHOP_SCOPED_PDP_MARKET_BASE).toBe('/mx')
  })

  test('the shop-scoped PDP admits only THIS shop\'s product in THIS market — page and metadata', () => {
    // Fresh-review catch on PR 494: without a market check, /mx/s/<us-shop>/l/<id>
    // rendered a US product as a self-canonical Mexico page. The predicate is the
    // checkout fallback's `acceptOwnedListing` (unit-tested in checkout-listing.spec);
    // this pins that BOTH render paths apply it.
    const source = readFileSync(path.join(ROOT, 'app/(shell)/l/[id]/ListingRenderer.tsx'), 'utf8')
    const guards = source.match(/acceptOwnedListing\(listing, \{ id, shopSlug: channelSlug[^}]*market \}\)/g) ?? []
    expect(guards.length, 'metadata + page body each check id/shop/market').toBe(2)
    expect(source).toContain('await isShopPreviewPrivateBySlug(channelSlug')
  })

  test('on an owned host the product lives at /l/<id>', () => {
    expect(shopListingBase({ onOwnedHost: true, marketBasePath: '/mx', shopSlug: 'x' })).toBe('')
    expect(listingHref({ listingBase: '' }, 'prod_1')).toBe('/l/prod_1')
  })

  test('a market WITHOUT a shop-scoped route keeps its market PDP (the negation)', () => {
    // Owned-shop-only selling is Mexico-only; there is no /us/s/<slug>/l/<id>, so a
    // US shop must keep linking /us/l/<id> rather than inherit a route that 404s.
    expect(shopListingBase({ onOwnedHost: false, marketBasePath: '/us', shopSlug: 'x' })).toBe('/us')
    expect(shopListingBase({ onOwnedHost: false, marketBasePath: '', shopSlug: 'x' })).toBe('')
  })

  test('no shop surface builds a PDP href from a raw base, whatever it is called', () => {
    // The POPULATION, not the one spelling that was reported. Both live 404s were
    // a surface picking its own base for a product link — first the shop base,
    // then the market base. Every shop surface must take the base from
    // `shopListingBase` (directly, or via `listingBase`/`productLinkBase`).
    //
    // The first version of this guard matched only `${basePath}/l/` and stayed
    // green through a mutation that rebuilt the defect as `${bases.shopBase}/l/`.
    // A guard pinned to one spelling of a name guards one spelling of a name.
    const RAW_BASE_NAMES = [
      'basePath', 'ctx.basePath', 'shopBase', 'bases.shopBase', 'navBasePath', 'marketBasePath',
    ]
    const pattern = new RegExp(
      `\\$\\{\\s*(?:${RAW_BASE_NAMES.map((n) => n.replace('.', '\\.')).join('|')})\\s*\\}/l/`,
    )
    for (const file of [
      'lib/wall/views.ts',
      'app/(shell)/_shop-sections/ShopIndexBody.tsx',
      'app/(shell)/_shop-sections/ShopIndexGrid.tsx',
      'app/(shell)/_shop-sections/CatalogBody.tsx',
      'app/(shell)/s/[slug]/ShopRenderer.tsx',
      'app/(shell)/_wall/WallEntryCard.tsx',
      'app/(shell)/embed/s/[slug]/page.tsx',
      'app/components/SellerBundleSection.tsx',
    ]) {
      const source = readFileSync(path.join(ROOT, file), 'utf8')
      expect(source, `${file} builds a PDP href from a raw base`).not.toMatch(pattern)
    }
  })

  test('a COLLECTION is shop-scoped, and still uses the shop base', () => {
    // The negation: this fix must not push collections onto the market base,
    // where /mx/c/<handle> is not a route either.
    const views = readFileSync(path.join(ROOT, 'lib/wall/views.ts'), 'utf8')
    expect(views).toMatch(/\$\{bases\.shopBase\}\/c\//)
  })
})
