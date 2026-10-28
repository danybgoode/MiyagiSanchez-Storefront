import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export type SourceFile = {
  filePath: string
  content: string
}

export type RawColorOffense = {
  filePath: string
  lineNumber: number
  literal: string
  line: string
}

export type AllowedLiteralRule = {
  path: string
  literal: string
  contains: string
  reason: string
}

export type ContrastPair = {
  name: string
  foregroundToken: string
  backgroundToken: string
  minimumRatio: number
  textSize: 'body' | 'large'
  rationale?: string
}

export type ContrastResult = ContrastPair & {
  foreground: string
  background: string
  ratio: number
  passes: boolean
}

const sourceExtensions = new Set(['.css', '.js', '.jsx', '.ts', '.tsx'])
const arbitraryHexClassPattern = /(?:bg|text|border|from|to|via|fill|stroke|ring|outline|decoration)-\[#[0-9a-fA-F]{3,8}\]/g
const rawHexPattern = /#[0-9a-fA-F]{3,8}\b/g

// ── seller-portal-rails-foundation S2 · Story 2.2 — adoption-sweep guards ──
// Raw palette classes / bg-white / literal radii / toast-banner import location.
// Same scan (app + lib), same exclusion lists, as the raw-color guards above.
const rawPaletteClassPattern = /\b(?:bg|text|border)-(?:green|amber|red|blue|indigo|purple|yellow)-\d+\b/g
const bgWhitePattern = /\bbg-white(?![\w/])/g
// Bare `rounded`, a named Tailwind radius suffix, a directional/corner variant
// (`rounded-l`, `rounded-tl`, …), or a corner+size combo (`rounded-l-lg`) — but
// NOT the arbitrary-value form using a --r- token (e.g. rounded with a bracketed
// var reference) — the negative lookahead rejects a following `-` that isn't one
// of the named suffixes, which is exactly what that arbitrary-value form has.
// (Written without literal brackets here — Tailwind's own content scanner reads
// this file as source and chokes trying to generate CSS for a bracketed literal
// candidate it finds inside a comment.) Found missing the directional
// variants entirely in the seller-portal-rails-foundation S2.5 cleanup — `Envios.tsx`
// used `rounded-l`/`rounded-r` on grouped input+suffix controls and the original
// pattern couldn't see them at all.
const literalRadiusPattern = /\brounded(-(?:t|r|b|l|tl|tr|br|bl)(-(?:none|xs|sm|md|lg|xl|2xl|3xl|full))?|-(?:none|xs|sm|md|lg|xl|2xl|3xl|full))?(?![-\w])/g
const feedbackSymbolImportPattern = /import\s*(?:type\s*)?\{[^}]*\b(?:Toast|Banner)\b[^}]*\}\s*from\s*['"]([^'"]+)['"]/g

export const guardExcludedPrefixes = [
  'app/(shell)/admin/',
  'app/api/',
  'app/style-sandbox/',
]

// cms-contenido-restore-and-polish S3.4 — the redesigned admin/contenido
// files are checked in DESPITE the whole `app/(shell)/admin/` prefix being
// excluded above (most admin pages are still un-swept and stay excluded).
// Checked FIRST in `isGuardExcluded`, so listing a file here overrides the
// broader prefix exclusion for exactly that file — the same incremental-
// adoption shape as `enforcedSweptPaths` below, just for scan COVERAGE
// rather than enforcement (a file must be scanned at all before its
// enforcedSweptPaths entry can mean anything).
export const enforcedDespiteExcludedPrefix = new Set<string>([
  'app/(shell)/admin/AdminShell.tsx',
  'app/(shell)/admin/contenido/ContenidoAdminClient.tsx',
  'app/(shell)/admin/contenido/ContenidoImportExportPanel.tsx',
  'app/(shell)/admin/contenido/ContenidoPageNav.tsx',
])

export const guardExcludedFiles = new Set([
  'app/apple-icon.tsx',
  'app/components/PrintAdBlock.tsx',
  'app/components/PrintAdPreview.tsx',
  'app/globals.css',
  'app/icon.svg',
  'app/layout.tsx',
  'app/(shell)/layout.tsx',
  'app/opengraph-image.tsx',
  'app/(shell)/shop/manage/PrintAdBlock.tsx',
  'app/(shell)/shop/manage/PrintAdPreview.tsx',
  // Printable promoter sell-sheet (epic 08 · S4) — a print surface whose @media
  // print CSS needs literal colors (same rationale as the print-export libs).
  'app/(shell)/mx/vende/promotor/sell-sheet/page.tsx',
  // Printable migration runbook (epic 03 · platform-migrations S3) — same print
  // surface + injected <style> idiom as the sell-sheet above, same rationale.
  'app/(shell)/mx/vende/promotor/migracion/page.tsx',
  // The shop catalog print page (share-kit S2.2) — headless Chromium prints it to a PDF; same print surface + injected
  // <style> idiom as the two above, and its colours are the paper's, not the theme's.
  'app/(shell)/mx/s/[slug]/catalogo/imprimir/page.tsx',
  'lib/email.ts',
  'lib/design-token-audit.ts',
  'lib/platform-theme.ts',
  'lib/print-export.ts',
  'lib/print-layout.ts',
  'lib/print-qr.ts',
])

export const allowedLiteralRules: AllowedLiteralRule[] = [
  {
    // Moved to canal-propio/ (catalog-management S6.2 — federation split out of settings).
    path: 'app/(shell)/shop/manage/canal-propio/EmbedSnippetSection.tsx',
    literal: '#111',
    contains: "accent && accent !== '#111'",
    reason: 'embed snippet data-accent default is serialized for third-party hosts',
  },
  {
    path: 'app/(shell)/shop/manage/settings/SupportWidgetSection.tsx',
    literal: '#1d6f42',
    contains: "accent || '#1d6f42'",
    reason: 'support-widget preview serializes a fallback accent into iframe markup',
  },
  {
    path: 'app/(shell)/shop/manage/settings/SupportWidgetSection.tsx',
    literal: '#111',
    contains: "accent && accent !== '#111'",
    reason: 'support-widget snippet data-accent default is serialized for third-party hosts',
  },
  {
    path: 'app/(shell)/shop/manage/settings/SupportWidgetSection.tsx',
    literal: '#fbfaf7',
    contains: '#fbfaf7',
    reason: 'self-contained iframe preview cannot depend on parent CSS vars',
  },
  {
    path: 'app/(shell)/shop/manage/settings/SupportWidgetSection.tsx',
    literal: '#26231f',
    contains: '#26231f',
    reason: 'self-contained iframe preview cannot depend on parent CSS vars',
  },
  {
    path: 'app/(shell)/shop/manage/settings/SupportWidgetSection.tsx',
    literal: '#eeece8',
    contains: '#eeece8',
    reason: 'self-contained iframe preview cannot depend on parent CSS vars',
  },
  {
    path: 'app/(shell)/shop/manage/settings/SupportWidgetSection.tsx',
    literal: '#dedbd4',
    contains: '#dedbd4',
    reason: 'self-contained iframe preview cannot depend on parent CSS vars',
  },
  {
    path: 'app/(shell)/shop/manage/settings/SupportWidgetSection.tsx',
    literal: '#f0efeb',
    contains: '#f0efeb',
    reason: 'self-contained iframe preview cannot depend on parent CSS vars',
  },
  {
    path: 'app/(shell)/shop/manage/settings/_sections/Diseno.tsx',
    literal: '#1d6f42',
    contains: "t.accent_color ?? '#1d6f42'",
    reason: 'native color input state needs a concrete hex value (extracted from ShopSettings monolith)',
  },
  {
    // Split from Canal.tsx (catalog-management S6.2) — federation half, now
    // canal-propio/CanalPropioClient.tsx; feeds the embed iframe preview.
    path: 'app/(shell)/shop/manage/canal-propio/CanalPropioClient.tsx',
    literal: '#1d6f42',
    contains: "initial.accent ?? '#1d6f42'",
    reason: 'accent fallback serialized into the embed iframe markup (extracted from ShopSettings monolith)',
  },
  {
    // Split from Canal.tsx (catalog-management S6.2) — support-widget half, now
    // settings/_sections/Apoyo.tsx; feeds the support-widget iframe preview.
    path: 'app/(shell)/shop/manage/settings/_sections/Apoyo.tsx',
    literal: '#1d6f42',
    contains: "initial.accent ?? '#1d6f42'",
    reason: 'accent fallback serialized into the support-widget iframe markup (extracted from ShopSettings monolith)',
  },
  {
    // mobile-clerk-account-management — Clerk's <UserProfile> appearance.variables
    // needs a concrete color, not a CSS custom property: Clerk's own docs warn their
    // color-mix()-based theming doesn't reliably resolve var(--...) for broader browser
    // support, and recommend a direct hex value instead. Mirrors --color-accent.
    path: 'app/(shell)/account/settings/[[...rest]]/page.tsx',
    literal: '#1d6f42',
    contains: "colorPrimary: '#1d6f42'",
    reason: "Clerk appearance.variables requires a literal hex (their color-mix() theming doesn't reliably resolve CSS custom properties); mirrors --color-accent",
  },
  {
    // mobile-clerk-account-management — same Clerk appearance.variables constraint
    // as above, mirrors --color-background.
    path: 'app/(shell)/account/settings/[[...rest]]/page.tsx',
    literal: '#f9f9f7',
    contains: "colorBackground: '#f9f9f7'",
    reason: "Clerk appearance.variables requires a literal hex (their color-mix() theming doesn't reliably resolve CSS custom properties); mirrors --color-background",
  },
  {
    // Moved from settings/page.tsx to lib/setup-guide.ts (seller-portal-setup-guide
    // epic, B.1 extraction) — same comparison, new location.
    path: 'lib/setup-guide.ts',
    literal: '#1d6f42',
    contains: "themeSettings.accent_color !== '#1d6f42'",
    reason: 'setup-completion check compares saved data against the core accent default',
  },
  {
    path: 'lib/settings-import.ts',
    literal: '#1d6f42',
    contains: "accent_color: '#1d6f42'",
    reason: 'Storefront-as-Code example manifest needs a concrete persisted accent default',
  },
  {
    path: 'lib/prompt-to-shop/blocks.ts',
    literal: '#ffffff',
    contains: "const PAGE_WHITE = '#ffffff'",
    reason: 'Prompt-to-shop measures a generated accent against the white page it renders on (a contrast input, never painted)',
  },
  ...['#1f6f5c', '#8a3b12', '#2f4b8a', '#6b2f6b'].map((literal) => ({
    path: 'lib/prompt-to-shop/blocks.ts',
    literal,
    contains: 'const FALLBACK_ACCENTS',
    reason: 'Prompt-to-shop fallback accents are persisted shop data (accent_color), like the example manifest above',
  })),
]

// Two deliberately-styled dark "terminal" code/DNS-record previews (seller-portal-rails-
// foundation S2 · Story 2.2) — a code-console color scheme, not a status-badge dialect.
export const allowedRawPaletteRules: AllowedLiteralRule[] = [
  {
    path: 'app/(shell)/shop/manage/settings/_sections/Agentes.tsx',
    literal: 'text-green-400',
    contains: 'bg-gray-900 text-green-400',
    reason: 'terminal-style JSON payload preview <pre> block, not a status indicator',
  },
  {
    path: 'app/(shell)/shop/manage/canal-propio/CanalPropioClient.tsx',
    literal: 'bg-green-500',
    contains: "bg-green-500/20 text-green-400",
    reason: 'DNS record card "copied" glow state inside a dark terminal-style preview, not a status badge',
  },
  {
    path: 'app/(shell)/shop/manage/canal-propio/CanalPropioClient.tsx',
    literal: 'text-green-400',
    contains: "bg-green-500/20 text-green-400",
    reason: 'DNS record card "copied" glow state inside a dark terminal-style preview, not a status badge',
  },
  {
    path: 'app/(shell)/shop/manage/canal-propio/CanalPropioClient.tsx',
    literal: 'text-amber-300',
    contains: 'text-white/30 mb-1',
    reason: 'DNS record card terminal theme (TIPO field), not a status indicator',
  },
  {
    path: 'app/(shell)/shop/manage/canal-propio/CanalPropioClient.tsx',
    literal: 'text-green-300',
    contains: 'text-white/30 mb-1',
    reason: 'DNS record card terminal theme (VALOR field), not a status indicator',
  },
]

// The adoption sweep's actual coverage (seller-portal-rails-foundation S2 + the S2.5
// follow-up cleanup). Story 2.2's hard gate enforces zero raw-palette/bg-white/
// literal-radius violations only within this set — everything else in app/+lib/ is
// still scanned (for visibility) but not yet required, matching the sweep's real scope
// rather than the whole app. `CatalogTable.tsx` is enforced only for its swept region
// (DeleteDialog + STATUS_LABEL/MarginCellDisplay/status pill/delete-hover, all fixed in
// S2.5) — its `<td>` render block's OTHER cells + bulk-bar wiring were never touched by
// either sweep and may still carry debt outside what these checks look for.
export const enforcedSweptPaths = new Set<string>([
  'app/(shell)/shop/manage/orders/OrdersInbox.tsx',
  'app/(shell)/shop/manage/ManageDashboard.tsx',
  'app/(shell)/shop/manage/PrintEditionCard.tsx',
  'app/(shell)/sell/SellWizard.tsx',
  'app/(shell)/sell/setup/SetupClient.tsx',
  'app/(shell)/shop/manage/offers/OfferInbox.tsx',
  'app/(shell)/shop/manage/orders/[id]/OrderDetail.tsx',
  'app/(shell)/shop/manage/catalogo/CatalogTable.tsx',
  'app/(shell)/shop/manage/settings/_sections/Notificaciones.tsx',
  'app/(shell)/shop/manage/canal-propio/PromoterCodeField.tsx',
  'app/(shell)/shop/manage/settings/_sections/Negociacion.tsx',
  'app/(shell)/shop/manage/settings/_sections/Pedidos.tsx',
  'app/(shell)/shop/manage/settings/_sections/Perfil.tsx',
  'app/(shell)/shop/manage/canal-propio/DomainPaywallUpsell.tsx',
  'app/(shell)/shop/manage/settings/_sections/Paginas.tsx',
  'app/(shell)/shop/manage/canal-propio/SubdomainSection.tsx',
  'app/(shell)/shop/manage/settings/_sections/Devoluciones.tsx',
  'app/(shell)/shop/manage/settings/_sections/Agentes.tsx',
  'app/(shell)/shop/manage/settings/_sections/Citas.tsx',
  'app/(shell)/shop/manage/settings/_sections/Diseno.tsx',
  'app/(shell)/shop/manage/settings/_sections/Pagos.tsx',
  'app/(shell)/shop/manage/canal-propio/CanalPropioClient.tsx',
  'app/(shell)/shop/manage/settings/_sections/Envios.tsx',
  'app/(shell)/shop/manage/settings/_components/CopyPromptButton.tsx',
  'app/(shell)/shop/manage/settings/_components/PickupSpotManager.tsx',
  'app/(shell)/shop/manage/settings/_components/SectionSaveBar.tsx',
  'app/(shell)/shop/manage/settings/_components/ToggleSwitch.tsx',
  // cms-contenido-restore-and-polish S3.4 — the Sprint 3 admin/contenido
  // re-skin (paired with `enforcedDespiteExcludedPrefix` above, which un-
  // excludes these same 4 files from the scan itself).
  'app/(shell)/admin/AdminShell.tsx',
  'app/(shell)/admin/contenido/ContenidoAdminClient.tsx',
  'app/(shell)/admin/contenido/ContenidoImportExportPanel.tsx',
  'app/(shell)/admin/contenido/ContenidoPageNav.tsx',
  // ui-refresh-launch S2 · Story 2.1/2.2 — buyer-core + marketing polish pass,
  // converting stray bare Tailwind radius utilities (and 2 bare `bg-white`
  // instances on SearchBar's colored filter card) to the S1 `--r-*` token
  // scale. `SubscriptionSection.tsx` was polished for radius too but is
  // deliberately NOT added here — it also carries pre-existing raw
  // green/red Tailwind palette classes (a success/error state) that are out
  // of this sprint's token-re-skin scope (color *values*, not radius/type);
  // adding it would fail the guard on debt this sprint didn't touch.
  'app/(site)/page.tsx',
  'app/(shell)/l/page.tsx',
  'app/(shell)/l/SearchBar.tsx',
  'app/(shell)/l/[id]/page.tsx',
  'app/(shell)/l/[id]/AutoHero.tsx',
  'app/(shell)/l/[id]/ServiceHero.tsx',
  'app/(shell)/l/[id]/RentalBooking.tsx',
  'app/(shell)/l/[id]/InmuebleHero.tsx',
  'app/(shell)/l/[id]/Gallery.tsx',
  'app/(shell)/l/[id]/EventBuyBox.tsx',
  'app/(shell)/l/[id]/ConfiguratorBuyBox.tsx',
  'app/(shell)/l/[id]/ExcerptPanel.tsx',
  'app/(shell)/l/[id]/SpecsTable.tsx',
  'app/(shell)/l/[id]/CollapsibleDescription.tsx',
  // ui-refresh-launch S2 · Story 2.2 — marketing polish pass (/agent, /acerca).
  'app/(shell)/agent/page.tsx',
  'app/(shell)/acerca/_components/AboutSections.tsx',
  // ui-refresh-launch S3 · Story 3.1 — seller portal polish pass. Same
  // straggler sweep as S2 (bare rounded-* -> --r-*, literal 15/17px ->
  // --t-*), scoped to /shop/manage/* + /sell/*. 5 files only had literal-
  // radius debt, 4 only had the literal-fontSize stray — both groups are
  // fully clean (radius + raw-palette + bg-white) with no pre-existing
  // color-value debt, so they're added here. The other 24 touched files in
  // this scope (radius + bg-white fixed too) still carry pre-existing raw
  // Tailwind palette classes (status pills, success/error banners, terminal
  // previews) — a color-*value* redesign out of this token-re-skin sprint's
  // scope, same rationale as SubscriptionSection.tsx in S2.1 — so they are
  // deliberately NOT added here.
  'app/(shell)/sell/page.tsx',
  'app/(shell)/shop/manage/catalogo/page.tsx',
  'app/(shell)/shop/manage/catalogo/CatalogFilterBar.tsx',
  'app/(shell)/shop/manage/convocatoria/ConvocatoriaSettingsClient.tsx',
  'app/(shell)/shop/manage/settings/NotificationPreferences.tsx',
  'app/(shell)/sell/edit/[id]/PublishToMl.tsx',
  'app/(shell)/shop/manage/convocatoria/campanas/CampaignsManager.tsx',
  'app/(shell)/shop/manage/convocatoria/page.tsx',
  'app/(shell)/shop/manage/mercadolibre/MercadoLibreStatus.tsx',
])

export const documentedContrastPairs: ContrastPair[] = [
  { name: 'Primary text on page canvas', foregroundToken: '--fg', backgroundToken: '--bg', minimumRatio: 4.5, textSize: 'body' },
  { name: 'Muted text on page canvas', foregroundToken: '--fg-muted', backgroundToken: '--bg', minimumRatio: 4.5, textSize: 'body' },
  { name: 'Primary text on raised surface', foregroundToken: '--fg', backgroundToken: '--bg-elevated', minimumRatio: 4.5, textSize: 'body' },
  { name: 'Muted text on raised surface', foregroundToken: '--fg-muted', backgroundToken: '--bg-elevated', minimumRatio: 4.5, textSize: 'body' },
  { name: 'Primary text on recessed surface', foregroundToken: '--fg', backgroundToken: '--bg-sunk', minimumRatio: 4.5, textSize: 'body' },
  { name: 'Inverse text on accent', foregroundToken: '--fg-inverse', backgroundToken: '--accent', minimumRatio: 4.5, textSize: 'body' },
  { name: 'Accent ink on accent soft', foregroundToken: '--accent-ink', backgroundToken: '--accent-soft', minimumRatio: 4.5, textSize: 'body' },
  { name: 'Success text on success soft', foregroundToken: '--success', backgroundToken: '--success-soft', minimumRatio: 4.5, textSize: 'body' },
  { name: 'Warning text on warning soft', foregroundToken: '--warning', backgroundToken: '--warning-soft', minimumRatio: 4.5, textSize: 'body' },
  { name: 'Danger text on danger soft', foregroundToken: '--danger', backgroundToken: '--danger-soft', minimumRatio: 4.5, textSize: 'body' },
  { name: 'Info text on info soft', foregroundToken: '--info', backgroundToken: '--info-soft', minimumRatio: 4.5, textSize: 'body' },
  { name: 'Energy text on energy soft', foregroundToken: '--energy', backgroundToken: '--energy-soft', minimumRatio: 4.5, textSize: 'body' },
  { name: 'Promo text on promo soft', foregroundToken: '--promo', backgroundToken: '--promo-soft', minimumRatio: 4.5, textSize: 'body' },
  { name: 'Agent text on agent soft', foregroundToken: '--agent', backgroundToken: '--agent-soft', minimumRatio: 4.5, textSize: 'body' },
  {
    name: 'Subtle text on page canvas',
    foregroundToken: '--fg-subtle',
    backgroundToken: '--bg',
    minimumRatio: 3,
    textSize: 'large',
    rationale: '--fg-subtle is reserved for placeholder/metadata affordances; body copy must use --fg-muted or stronger.',
  },
]

export async function collectSourceFiles(repoRoot: string, dir: string): Promise<string[]> {
  const absoluteDir = path.join(repoRoot, dir)
  const entries = await readdir(absoluteDir, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return collectSourceFiles(repoRoot, entryPath)
    if (!sourceExtensions.has(path.extname(entry.name))) return []
    return [entryPath]
  }))

  return files.flat()
}

export function isGuardExcluded(filePath: string) {
  if (enforcedDespiteExcludedPrefix.has(filePath)) return false
  return guardExcludedFiles.has(filePath) || guardExcludedPrefixes.some((prefix) => filePath.startsWith(prefix))
}

export async function readSourceFiles(repoRoot: string, dirs = ['app', 'lib']): Promise<SourceFile[]> {
  const files = (await Promise.all(dirs.map((dir) => collectSourceFiles(repoRoot, dir))))
    .flat()
    .filter((filePath) => !isGuardExcluded(filePath))

  return Promise.all(files.map(async (filePath) => ({
    filePath,
    content: await readFile(path.join(repoRoot, filePath), 'utf8'),
  })))
}

export async function findArbitraryHexClassOffenders(repoRoot: string) {
  return findArbitraryHexClassOffendersInSourceFiles(await readSourceFiles(repoRoot))
}

export async function findRawHexLiteralOffenders(repoRoot: string) {
  return findRawHexLiteralOffendersInSourceFiles(await readSourceFiles(repoRoot))
}

export function findArbitraryHexClassOffendersInSourceFiles(files: SourceFile[]) {
  const offenders: RawColorOffense[] = []

  for (const file of files) {
    if (isGuardExcluded(file.filePath)) continue
    for (const match of file.content.matchAll(arbitraryHexClassPattern)) {
      offenders.push(buildOffense(file, match))
    }
  }

  return offenders
}

export function findRawHexLiteralOffendersInSourceFiles(files: SourceFile[]) {
  const offenders: RawColorOffense[] = []

  for (const file of files) {
    if (isGuardExcluded(file.filePath)) continue
    for (const match of file.content.matchAll(rawHexPattern)) {
      const offense = buildOffense(file, match)
      if (!isAllowedLiteral(offense)) offenders.push(offense)
    }
  }

  return offenders
}

// The "invisible accent button" defect: an element that sets `bg-[var(--accent)]`
// alongside an *untyped* `text-[var(--fg-inverse)]`. In Tailwind v4 the untyped
// arbitrary text value is ambiguous (color vs font-size) so the colour rule never
// emits — anchors then inherit `:where(a){color:var(--accent)}` and render the label
// green-on-green. The fix is the `.btn .btn-primary` primitive (plain CSS) for
// buttons, or the typed `text-[color:var(--fg-inverse)]` hint for chips/badges; both
// clear this guard. (Seller bug sweep S3, 2026-06-10.)
const invisibleAccentBgClass = 'bg-[var(--accent)]'
const untypedInverseTextClass = 'text-[var(--fg-inverse)]'

export async function findInvisibleAccentButtonOffenders(repoRoot: string) {
  return findInvisibleAccentButtonOffendersInSourceFiles(await readSourceFiles(repoRoot))
}

export function findInvisibleAccentButtonOffendersInSourceFiles(files: SourceFile[]) {
  const offenders: RawColorOffense[] = []

  for (const file of files) {
    if (isGuardExcluded(file.filePath)) continue
    file.content.split('\n').forEach((line, index) => {
      if (line.includes(invisibleAccentBgClass) && line.includes(untypedInverseTextClass)) {
        offenders.push({
          filePath: file.filePath,
          lineNumber: index + 1,
          literal: `${invisibleAccentBgClass} + ${untypedInverseTextClass}`,
          line,
        })
      }
    })
  }

  return offenders
}

export async function findRawPaletteClassOffenders(repoRoot: string) {
  return findRawPaletteClassOffendersInSourceFiles(await readSourceFiles(repoRoot))
}

export function findRawPaletteClassOffendersInSourceFiles(files: SourceFile[]) {
  const offenders: RawColorOffense[] = []

  for (const file of files) {
    if (isGuardExcluded(file.filePath)) continue
    for (const match of file.content.matchAll(rawPaletteClassPattern)) {
      const offense = buildOffense(file, match)
      if (!isAllowedRawPaletteLiteral(offense)) offenders.push(offense)
    }
  }

  return offenders
}

export async function findBgWhiteOffenders(repoRoot: string) {
  return findBgWhiteOffendersInSourceFiles(await readSourceFiles(repoRoot))
}

export function findBgWhiteOffendersInSourceFiles(files: SourceFile[]) {
  const offenders: RawColorOffense[] = []

  for (const file of files) {
    if (isGuardExcluded(file.filePath)) continue
    for (const match of file.content.matchAll(bgWhitePattern)) {
      offenders.push(buildOffense(file, match))
    }
  }

  return offenders
}

export async function findLiteralRadiusOffenders(repoRoot: string) {
  return findLiteralRadiusOffendersInSourceFiles(await readSourceFiles(repoRoot))
}

export function findLiteralRadiusOffendersInSourceFiles(files: SourceFile[]) {
  const offenders: RawColorOffense[] = []

  for (const file of files) {
    if (isGuardExcluded(file.filePath)) continue
    for (const match of file.content.matchAll(literalRadiusPattern)) {
      offenders.push(buildOffense(file, match))
    }
  }

  return offenders
}

// Rail R6: only `components/feedback/` may render `<Toast>`/`<Banner>` — so importing
// either symbol from anywhere else means a duplicate/bespoke implementation crept back in.
export async function findFeedbackImportOffenders(repoRoot: string) {
  return findFeedbackImportOffendersInSourceFiles(await readSourceFiles(repoRoot))
}

export function findFeedbackImportOffendersInSourceFiles(files: SourceFile[]) {
  const offenders: RawColorOffense[] = []

  for (const file of files) {
    if (isGuardExcluded(file.filePath)) continue
    if (file.filePath.startsWith('components/feedback/')) continue
    for (const match of file.content.matchAll(feedbackSymbolImportPattern)) {
      const modulePath = match[1]
      if (!modulePath.includes('components/feedback/')) {
        offenders.push(buildOffense(file, match))
      }
    }
  }

  return offenders
}

/** Only the violations inside Story 2.1's actual swept-file coverage (`enforcedSweptPaths`) — the hard gate. */
export function withinEnforcedSweep(offenders: RawColorOffense[]) {
  return offenders.filter((offense) => enforcedSweptPaths.has(offense.filePath))
}

function isAllowedRawPaletteLiteral(offense: RawColorOffense) {
  return allowedRawPaletteRules.some((rule) =>
    rule.path === offense.filePath &&
    rule.literal.toLowerCase() === offense.literal.toLowerCase() &&
    offense.line.includes(rule.contains)
  )
}

export function formatOffense(offense: RawColorOffense) {
  return `${offense.filePath}:${offense.lineNumber}: ${offense.literal} in ${offense.line.trim()}`
}

function buildOffense(file: SourceFile, match: RegExpMatchArray): RawColorOffense {
  const offset = match.index ?? 0
  return {
    filePath: file.filePath,
    lineNumber: lineNumberForOffset(file.content, offset),
    literal: match[0],
    line: lineForOffset(file.content, offset),
  }
}

function isAllowedLiteral(offense: RawColorOffense) {
  return allowedLiteralRules.some((rule) =>
    rule.path === offense.filePath &&
    rule.literal.toLowerCase() === offense.literal.toLowerCase() &&
    offense.line.includes(rule.contains)
  )
}

function lineNumberForOffset(content: string, offset: number) {
  return content.slice(0, offset).split('\n').length
}

function lineForOffset(content: string, offset: number) {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1
  const lineEnd = content.indexOf('\n', offset)
  return content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd)
}

export function parseBaseCssTokens(css: string) {
  const tokens = new Map<string, string>()
  for (const block of [extractBlock(css, '@theme inline'), extractBlock(css, ':root')]) {
    for (const match of block.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(match[1], match[2].trim())
    }
  }
  return tokens
}

/**
 * Parse the CSS-variable declarations out of one arbitrary selector's block —
 * e.g. an own-shop theme-preset scope like `[data-shop-preset="papel"]`
 * (`app/globals.css`). Used by `e2e/theme-preset-contrast.spec.ts` to resolve
 * each preset's override tokens on top of the base tree from
 * `parseBaseCssTokens`, without re-implementing brace-matching.
 */
export function parseSelectorCssTokens(css: string, selector: string) {
  const tokens = new Map<string, string>()
  for (const match of extractBlock(css, selector).matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(match[1], match[2].trim())
  }
  return tokens
}

export function auditDocumentedContrastPairs(css: string, pairs = documentedContrastPairs): ContrastResult[] {
  const tokens = parseBaseCssTokens(css)
  return pairs.map((pair) => {
    const foreground = resolveTokenToHex(tokens, pair.foregroundToken)
    const background = resolveTokenToHex(tokens, pair.backgroundToken)
    const ratio = contrastRatio(foreground, background)
    return {
      ...pair,
      foreground,
      background,
      ratio,
      passes: ratio >= pair.minimumRatio,
    }
  })
}

export function formatContrastResult(result: ContrastResult) {
  const status = result.passes ? 'PASS' : result.rationale ? 'FLAGGED' : 'FAIL'
  return `${status} ${result.name}: ${result.foregroundToken} ${result.foreground} on ${result.backgroundToken} ${result.background} = ${result.ratio.toFixed(2)} (min ${result.minimumRatio})`
}

function blockPatternFor(marker: string): RegExp {
  if (marker === ':root') return /^\s*:root\s*\{/m
  if (marker === '@theme inline') return /^\s*@theme\s+inline\s*\{/m
  // An arbitrary selector (e.g. an attribute selector like `[data-shop-preset="papel"]`) —
  // escape regex metacharacters and match it followed by an opening brace.
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{`)
}

function extractBlock(css: string, marker: string) {
  const blockPattern = blockPatternFor(marker)
  const match = blockPattern.exec(css)
  if (!match) throw new Error(`Missing CSS block marker: ${marker}`)
  const openIndex = match.index + match[0].lastIndexOf('{')

  let depth = 0
  for (let index = openIndex; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(openIndex + 1, index)
    }
  }

  throw new Error(`Missing closing brace for CSS block: ${marker}`)
}

export function resolveTokenToHex(tokens: Map<string, string>, tokenName: string, seen = new Set<string>()): string {
  const value = tokens.get(tokenName)
  if (!value) throw new Error(`Missing CSS token: ${tokenName}`)
  if (seen.has(tokenName)) throw new Error(`Circular CSS token reference: ${Array.from(seen).join(' -> ')} -> ${tokenName}`)

  const direct = parseHexColor(value)
  if (direct) return direct

  const varMatch = value.match(/^var\((--[a-zA-Z0-9-]+)(?:,\s*([^)]+))?\)$/)
  if (varMatch) {
    seen.add(tokenName)
    const referenced = tokens.has(varMatch[1]) ? varMatch[1] : null
    if (referenced) return resolveTokenToHex(tokens, referenced, seen)
    if (varMatch[2]) {
      const fallback = parseHexColor(varMatch[2])
      if (fallback) return fallback
    }
  }

  throw new Error(`Token ${tokenName} does not resolve to a supported hex color: ${value}`)
}

function parseHexColor(value: string) {
  const match = value.trim().match(/^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$/)
  if (!match) return null
  const hex = match[1].toLowerCase()
  if (hex.length === 4) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
  }
  return hex
}

function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function relativeLuminance(hex: string) {
  const [red, green, blue] = [0, 2, 4]
    .map((offset) => parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255)
    .map((channel) => channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4)

  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
}
