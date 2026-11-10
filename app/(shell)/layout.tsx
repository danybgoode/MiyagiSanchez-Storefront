import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import MarketDocument, { ROOT_METADATA, ROOT_VIEWPORT } from '@/app/components/MarketDocument'
import ChannelLayout from '@/app/(shell)/s/[slug]/ChannelLayout'
import { shopShowsBadge } from '@/lib/plan-badge-server'
import { badgeHref } from '@/lib/plan'
import TrustSignals from '@/app/components/TrustSignals'
import PlatformShell from '@/app/components/PlatformShell'
import PlatformThemeScript from '@/app/components/PlatformThemeScript'
import ReferralAttribution from '@/app/components/ReferralAttribution'
import { AgentContextProvider } from '@/app/components/AgentContext'
import { getShop } from '@/lib/listings'
import { isShopPreviewPrivateBySlug } from '@/lib/preview-access'
import { deriveShopTrustInputs } from '@/lib/trust-inputs'
import { isPlatformThemeEligiblePath } from '@/lib/platform-theme'
import { isSellerModePath } from '@/lib/seller-mode'
import { sellShellEligible } from '@/lib/seller-shell-gate'
import { isOnboardingPath } from '@/lib/onboarding-path'
import '@/app/globals.css'
import '@/app/iconoir-subset.css'

export const metadata: Metadata = ROOT_METADATA
export const viewport: Viewport = ROOT_VIEWPORT

/**
 * Dynamic `(shell)` shell — holds the per-request chrome decision that used to live in
 * the root layout (which is now static so the `(site)` homepage can go static). Reading
 * `headers()` here opts THIS subtree into dynamic rendering without tainting `(site)`.
 *
 * Chrome modes:
 *   • white-label (embed iframe OR live custom-domain / subdomain) → `ChannelLayout`
 *   • buyer chrome (everything else on the platform) → `PlatformShell`
 *   • seller-mode (`/shop/manage/*`), owner-eligible `/sell`+`/sell/setup`, or the
 *     onboarding three-doors first-run (`/sell/bienvenida`, `/sell/puertas`,
 *     `/sell/agente`) → bare `<main>` (the matching nested layout fills it)
 */
export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  // The embeddable full-shop iframe (/embed/*) is white-label — middleware tags it so we
  // drop the platform header/footer/tab bar and render just the shop.
  const hdrs = await headers()
  const isEmbed = hdrs.get('x-miyagi-embed') === '1'
  const platformPath = hdrs.get('x-miyagi-path') ?? '/'

  // Custom-domain ("own channel") AND subdomain (slug.miyagisanchez.com) requests are
  // white-label: middleware tags them with the resolved shop slug so we drop platform
  // chrome here and wrap the WHOLE storefront in the shop's branded shell.
  const channel = hdrs.get('x-miyagi-channel')
  const isChannel = channel === 'custom' || channel === 'subdomain'
  const channelSlug = hdrs.get('x-miyagi-shop-slug') ?? ''
  const channelDomain = hdrs.get('x-miyagi-domain') ?? ''
  // Consent-safe previews: the channel shell renders the shop's NAME and logo on
  // every 200 served from a subdomain/custom domain, so a preview-private shop
  // must not resolve here either. Dropping to null degrades to the platform
  // chrome rather than throwing — the page inside is separately guarded and will
  // 404 on its own; this only ensures the wrapper never carries the merchant's
  // identity in the meantime.
  const resolvedChannelShop = isChannel && channelSlug ? await getShop(channelSlug) : null
  const channelShop =
    resolvedChannelShop && (await isShopPreviewPrivateBySlug(resolvedChannelShop.slug, resolvedChannelShop.clerk_user_id))
      ? null
      : resolvedChannelShop
  const channelSettings = ((channelShop?.metadata as Record<string, unknown> | null)?.settings ?? {}) as Record<string, unknown>
  const channelTheme = (channelSettings.theme ?? {}) as { accent_color?: string | null }
  const channelAccent = channelTheme.accent_color ?? '#1d6f42'
  // The Gratis badge (plans-gratis-negocio D7): hidden for Negocio and trial shops.
  const channelShowsBadge = channelShop ? await shopShowsBadge(channelShop.slug) : true

  // White-label = no platform chrome (embed iframe OR a live custom domain).
  const whiteLabel = isEmbed || isChannel

  // Seller-mode shell (/shop/manage/*): also drop the buyer chrome — the nested
  // app/(shell)/shop/manage/layout.tsx renders a seller-distinct shell in this
  // suppressed space. This mirrors the whiteLabel branch and composes with it: a manage
  // page on a custom domain/subdomain is already whiteLabel, so the nested layout defers
  // to ChannelLayout and never double-suppresses or stacks two shells.
  const sellerMode = isSellerModePath(platformPath)

  // Owner-aware seller shell on /sell + /sell/setup (catalog-management epic,
  // Sprint 6 · Story 6.1): a signed-in shop owner gets the seller shell there
  // too, same "root suppresses buyer chrome, nested layout fills the gap"
  // composition as sellerMode above — the new app/(shell)/sell/layout.tsx fills
  // the bare <main> branch below with SellerShellChrome. isSellerModePath itself
  // is UNCHANGED (still false for /sell) — this is a separate, additional
  // OR-term, never folded into sellerMode or the pure predicate. Short-circuits
  // on whiteLabel first so a white-label /sell never trips this (consistent
  // with the double-suppression guarantee) and never spends the Clerk/Medusa
  // round-trip on a channel host.
  const ownerSellShellEligible = !whiteLabel && (await sellShellEligible(platformPath))

  // Onboarding three-doors first-run (seller-portal-onboarding-three-doors
  // Sprint 1): the S1/S2/S3 screens are PRE-shop (a merchant with no seller
  // yet), so neither sellerMode nor ownerSellShellEligible above ever covers
  // them — this is a third, separate, additive OR-term (same "root
  // suppresses, nested layout fills" composition, not a re-extension of
  // either existing gate). `isOnboardingPath` is a pure path match, no
  // auth/flag check here — the nested `app/(shell)/sell/(onboarding)/`
  // layout and each page own that.
  const onboardingMode = !whiteLabel && isOnboardingPath(platformPath)

  const showBuyerChrome = !whiteLabel && !sellerMode && !ownerSellShellEligible && !onboardingMode

  const platformThemeEligible = !whiteLabel && isPlatformThemeEligiblePath(platformPath)

  return (
    <MarketDocument market="mx">
    {/* AgentContextProvider wraps both the chrome (where AIAgentButton's card lives) and
        children (where a server page's SetAgentContext pushes its details) so the
        hand-off prompt can name the actual product/shop. It wraps all three branches; on
        white-label/seller-mode the AIAgentButton consumer isn't rendered, so any details a
        page sets are simply never read (harmless). */}
    <AgentContextProvider>
      {/* Seasonal-theme boot script (beforeInteractive) — only on eligible platform
          pages (`/l*`, `/agent`), never white-label/embed/ineligible. The static root
          can't gate by path, so it's emitted here where eligibility is known. */}
      {platformThemeEligible && <PlatformThemeScript />}
      {isChannel && channelShop ? (
        <ChannelLayout
          shopName={channelShop.name}
          accentColor={channelAccent}
          logoUrl={channelShop.logo_url ?? null}
          domain={channelDomain}
          showBadge={channelShowsBadge}
          badgeHref={channelShop ? badgeHref(channelShop.slug) : undefined}
          trust={
            // Epic D / D.2 — slim trust chips beside the assurance lead line the shell
            // renders. paymentProtected is suppressed here (the lead line "Pago seguro ·
            // Compra protegida" already carries that assurance).
            <TrustSignals
              variant="slim"
              channel={channel === 'custom' ? 'custom_domain' : 'subdomain'}
              {...deriveShopTrustInputs(channelShop.metadata as Record<string, unknown> | null, channelShop.verified)}
              paymentProtected={false}
            />
          }
        >
          {children}
        </ChannelLayout>
      ) : showBuyerChrome ? (
        <PlatformShell market="mx" platformThemeEligible={platformThemeEligible}>
          {children}
        </PlatformShell>
      ) : (
        <main>{children}</main>
      )}
      <ReferralAttribution />
    </AgentContextProvider>
    </MarketDocument>
  )
}
