import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { collectSourceFiles, guardExcludedPrefixes, type SourceFile } from './design-token-audit'

export type EmojiOffense = {
  filePath: string
  lineNumber: number
  literal: string
  line: string
}

export type VoiceAllowlistRule = {
  path: string
  literal: string
  contains: string
  reason: string
}

// Real colorful pictograph emoji (Miscellaneous Symbols & Pictographs, Emoticons,
// Transport & Map, Supplemental Symbols & Pictographs, Dingbats/Misc Symbols).
// Deliberately EXCLUDES the Arrows block (U+2190-U+21FF): thin system-font glyphs
// like ← → ↗ ↑ ↓ used as navigational wayfinding (back-links, external-link
// markers, sort carets) are a different, far more pervasive convention than
// colorful emoji and were scoped out of the emoji-to-iconoir-sweep epic (see its
// README) — sweeping them would be a much larger, unrelated refactor.
//
// ── Three blocks added 2026-08-15, because the guard could not see its own
//    enforced files ─────────────────────────────────────────────────────────────
// `app/(shell)/shop/manage/analytics/AnalyticsClient.tsx` has been in
// `enforcedSweptPaths` since the sweep shipped and carried 🆕 and ⏳ the whole
// time, green, because neither glyph is in the ranges above. That is the
// "guard the population, not the door you found" failure in its purest form:
// the file list was right and the DETECTOR had a hole, so widening the list
// would never have found it. The three additions:
//
//   U+1F000-U+1F2FF — Mahjong/Domino/Cards, Enclosed Alphanumeric Supplement
//                     (🆕 🆗 🆒 …) and Enclosed Ideographic Supplement. This
//                     range also contains the REGIONAL INDICATORS U+1F1E6-U+1F1FF,
//                     which is how a pair of them makes a flag emoji (🇲🇽 = U+1F1F2
//                     U+1F1FD) — the market selector's country flags, now gone.
//   U+231A/U+231B, U+23E9-U+23F3, U+23F8-U+23FA — the emoji-presentation subset
//                     of Miscellaneous Technical (⌚ ⌛ ⏩ ⏰ ⏳ ⏸ ⏺ …). Deliberately
//                     NOT the whole 2300-23FF block: ⌘ ⌥ ⌫ ⏎ are keyboard glyphs
//                     that legitimately render as text in a shortcut hint, and a
//                     guard that rejects correct output is worse than one that
//                     misses a rare fault.
//
// U+FE0F (the emoji variation selector) is NOT matched on its own: it only ever
// follows a base character, and every base worth banning is already in a range
// above — matching it alone would report an offense at a column where there is
// no visible glyph, which is a confusing false positive rather than a catch.
const emojiChromePattern =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{231A}\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}]/gu

// The sweep only ever touches app/ and components/ (JSX render surfaces) — never
// lib/, where legitimate voice copy lives (email templates, Telegram notification
// builders). That's what structurally keeps voice text out of this guard's reach
// without needing an allowlist entry for every notification string.
const scanDirs = ['app', 'components']

// The two/five 🎉 instances the sweep deliberately left as emoji: deliberate
// celebratory sentence tone, not an icon slot (same rationale as email voice).
export const voiceAllowlist: VoiceAllowlistRule[] = [
  {
    path: 'app/(shell)/account/orders/[id]/OrderTrackingClient.tsx',
    literal: '🎉',
    contains: '¡Tu pedido fue entregado! Espero que te encante',
    reason: 'celebratory buyer-facing status message, not an icon slot',
  },
  {
    path: 'app/(shell)/account/orders/[id]/OrderTrackingClient.tsx',
    literal: '🎉',
    contains: '¡Recogiste tu artículo! Esperamos que te encante',
    reason: 'celebratory buyer-facing status message, not an icon slot',
  },
  {
    path: 'app/(shell)/shop/manage/canal-propio/CanalPropioClient.tsx',
    literal: '🎉',
    contains: '¡Tu tienda está activa en 2 canales!',
    reason: 'celebratory milestone message, not an icon slot',
  },
  {
    path: 'app/(shell)/v/[slug]/VoteClient.tsx',
    literal: '🎉',
    contains: '¡Se alcanzó la meta!',
    reason: 'celebratory sentence tone, not an icon slot — user-confirmed during the sweep',
  },
  {
    path: 'app/components/SellerBundleSection.tsx',
    literal: '🎉',
    contains: 'de descuento aplicado',
    reason: 'celebratory sentence tone, not an icon slot — user-confirmed during the sweep',
  },
]

// The sweep's actual coverage (emoji-to-iconoir-sweep, Sprint 1 · Story 1.1) — the
// hard gate below only asserts zero violations within this set. The rest of
// app/+components/ is scanned too (for visibility as a future pass expands the
// sweep) but not yet enforced, matching the same incremental-adoption shape as
// the raw-color guard's `enforcedSweptPaths` in design-token-audit.ts.
//
// Ten files the sweep touched are deliberately NOT in this set — each still has
// at least one emoji this pass could not mechanically convert, so the file isn't
// "fully swept" by this gate's own zero-tolerance standard:
//   - OrderTrackingClient.tsx, ConversationClient.tsx (messages/page.tsx's sibling
//     renderSystemText), l/[id]/page.tsx's `agendarLabel`, EditForm.tsx +
//     SellWizard.tsx's delivery-mode `label` configs, OfferInbox.tsx's
//     STATUS_LABEL/toast strings, Negociacion.tsx's trust-level `label` configs —
//     the emoji lives inside a plain TS string with no separate icon slot at the
//     render site (a `{meta.message}`/`{opt.label}` interpolation, or a toast
//     string). Converting these needs a data-model change (split the field into
//     `{ icon, label }` and update the call site), not a character swap — pass 2.
//   `sell/edit/[id]/page.tsx` and `shop/manage/offers/OfferInbox.tsx` had their
//   chrome emoji (⏸, ⏰) converted on 2026-08-15 and were CONSIDERED for this set,
//   then left out on the evidence: the widened pattern showed both still carry
//   pass-2 emoji inside plain TS strings (a `listing-type` label config, and
//   OfferInbox's STATUS_LABEL/toast ✓). Adding them would have made this gate red
//   on work it was never asked to do.
//   - embed/s/[slug]/page.tsx, CopyButton.tsx, SlugField.tsx — the only remaining
//     match is inside a code COMMENT (never rendered), a naive-text-scan false
//     positive the same way `lib/design-token-audit.ts` has to self-exclude for
//     its own hex-literal comments.
export const enforcedSweptPaths = new Set<string>([
  'app/(shell)/_shop-collection/CollectionPage.tsx',
  'app/(shell)/account/notificaciones/BuyerNotificationPreferences.tsx',
  'app/(shell)/account/orders/AccountOrdersClient.tsx',
  'app/(shell)/account/print-ads/AccountPrintAdsClient.tsx',
  'app/(shell)/account/subscriptions/AccountSubscriptionsClient.tsx',
  'app/(shell)/admin/print/[editionId]/print/PrintToolbar.tsx',
  'app/(shell)/admin/print/PrintAdminClient.tsx',
  'app/(shell)/agent/page.tsx',
  'app/(shell)/checkout/CheckoutExperience.tsx',
  'app/(shell)/comunidad/mis-aportes/MisAportesClient.tsx',
  'app/(shell)/comunidad/nuevo/ComunidadForm.tsx',
  'app/(shell)/l/[id]/SubscriptionSection.tsx',
  'app/(shell)/payment/success/page.tsx',
  'app/(shell)/promotor/cerrar/ProductosStep.tsx',
  'app/(shell)/promotor/cerrar/PromoterCloseClient.tsx',
  'app/(shell)/s/[slug]/claim/page.tsx',
  'app/(shell)/s/[slug]/ClosetListingCard.tsx',
  'app/(shell)/s/[slug]/convocatoria/ConvocatoriaClient.tsx',
  'app/(shell)/s/[slug]/page.tsx',
  'app/(shell)/sell/(onboarding)/agente/AgenteIntakeClient.tsx',
  'app/(shell)/sell/edit/[id]/OpcionesSection.tsx',
  'app/(shell)/sell/edit/[id]/PersonalizationSection.tsx',
  'app/(shell)/sell/InspectionReportField.tsx',
  'app/(shell)/sell/page.tsx',
  'app/(shell)/sell/print/[editionId]/PrintAdBuilder.tsx',
  'app/(shell)/sell/setup/SetupClient.tsx',
  'app/(shell)/shop/manage/analytics/AnalyticsClient.tsx',
  'app/(shell)/shop/manage/canal-propio/CanalPropioClient.tsx',
  'app/(shell)/shop/manage/canal-propio/DnsSetupPanel.tsx',
  'app/(shell)/shop/manage/canal-propio/DomainPaywallUpsell.tsx',
  'app/(shell)/shop/manage/canal-propio/PromoterCodeField.tsx',
  'app/(shell)/shop/manage/canal-propio/SubdomainSection.tsx',
  'app/(shell)/shop/manage/catalogo/CatalogTable.tsx',
  'app/(shell)/shop/manage/catalogo/page.tsx',
  'app/(shell)/shop/manage/comparte/ComparteClient.tsx',
  'app/(shell)/shop/manage/content/ContentClient.tsx',
  'app/(shell)/shop/manage/import/ImportClient.tsx',
  'app/(shell)/shop/manage/ManageDashboard.tsx',
  'app/(shell)/shop/manage/orders/[id]/OrderDetail.tsx',
  'app/(shell)/shop/manage/orders/OrdersInbox.tsx',
  'app/(shell)/shop/manage/PrintEditionCard.tsx',
  'app/(shell)/shop/manage/settings/_components/CopyPromptButton.tsx',
  'app/(shell)/shop/manage/settings/_components/PickupSpotManager.tsx',
  'app/(shell)/shop/manage/settings/_sections/Agentes.tsx',
  'app/(shell)/shop/manage/settings/_sections/Citas.tsx',
  'app/(shell)/shop/manage/settings/_sections/Diseno.tsx',
  'app/(shell)/shop/manage/settings/_sections/Envios.tsx',
  'app/(shell)/shop/manage/settings/_sections/Pagos.tsx',
  'app/(shell)/shop/manage/settings/_sections/Perfil.tsx',
  'app/(shell)/shop/manage/settings/import/SettingsImportClient.tsx',
  'app/(shell)/shop/manage/settings/NotificationPreferences.tsx',
  'app/(shell)/shop/manage/settings/page.tsx',
  'app/(shell)/shop/manage/settings/pagos/wizard/CobrosWizardClient.tsx',
  'app/(shell)/shop/manage/SetupGuideCard.tsx',
  'app/(shell)/shop/manage/shopify/import/parity/[batchId]/page.tsx',
  'app/(shell)/shop/manage/subscriptions/SubscriptionsClient.tsx',
  'app/(shell)/v/[slug]/VoteClient.tsx',
  'app/(shell)/mx/vende/promotor/sell-sheet/page.tsx',
  'app/components/AgentHandoff.tsx',
  'app/components/ArtworkFileInput.tsx',
  'app/components/BuyButton.tsx',
  'app/components/CartDrawer.tsx',
  'app/components/CheckoutPayButton.tsx',
  'app/components/MakeOfferButton.tsx',
  'app/components/PersonalizationEcho.tsx',
  'app/components/PrintAdBlock.tsx',
  'app/components/PrintAdPreview.tsx',
  'app/components/SellerBundleSection.tsx',
  'components/ConnectAgentPanel.tsx',
  'components/SuccessCard.tsx',
])

export function isEmojiGuardExcluded(filePath: string) {
  return guardExcludedPrefixes.some((prefix) => filePath.startsWith(prefix))
}

export async function readEmojiGuardSourceFiles(repoRoot: string): Promise<SourceFile[]> {
  const files = (await Promise.all(scanDirs.map((dir) => collectSourceFiles(repoRoot, dir))))
    .flat()
    .filter((filePath) => !isEmojiGuardExcluded(filePath))

  return Promise.all(files.map(async (filePath) => ({
    filePath,
    content: await readFile(path.join(repoRoot, filePath), 'utf8'),
  })))
}

export async function findEmojiChromeOffenders(repoRoot: string) {
  return findEmojiChromeOffendersInSourceFiles(await readEmojiGuardSourceFiles(repoRoot))
}

export function findEmojiChromeOffendersInSourceFiles(files: SourceFile[]) {
  const offenders: EmojiOffense[] = []

  for (const file of files) {
    if (isEmojiGuardExcluded(file.filePath)) continue
    for (const match of file.content.matchAll(emojiChromePattern)) {
      const offense = buildOffense(file, match)
      if (!isVoiceAllowed(offense)) offenders.push(offense)
    }
  }

  return offenders
}

/** Only the violations inside Story 1.1's actual swept-file coverage — the hard gate. */
export function withinEnforcedSweep(offenders: EmojiOffense[]) {
  return offenders.filter((offense) => enforcedSweptPaths.has(offense.filePath))
}

export function formatOffense(offense: EmojiOffense) {
  return `${offense.filePath}:${offense.lineNumber}: ${offense.literal} in ${offense.line.trim()}`
}

function isVoiceAllowed(offense: EmojiOffense) {
  return voiceAllowlist.some((rule) =>
    rule.path === offense.filePath &&
    rule.literal === offense.literal &&
    offense.line.includes(rule.contains)
  )
}

function buildOffense(file: SourceFile, match: RegExpMatchArray): EmojiOffense {
  const offset = match.index ?? 0
  return {
    filePath: file.filePath,
    lineNumber: lineNumberForOffset(file.content, offset),
    literal: match[0],
    line: lineForOffset(file.content, offset),
  }
}

function lineNumberForOffset(content: string, offset: number) {
  return content.slice(0, offset).split('\n').length
}

function lineForOffset(content: string, offset: number) {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1
  const lineEnd = content.indexOf('\n', offset)
  return content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd)
}
