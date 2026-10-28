import { currentUser } from '@clerk/nextjs/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import SellWizard from './SellWizard'
import DescribeBox from '@/app/(shell)/mx/vende/_components/DescribeBox'
import SellerCopyBoundary from '@/app/components/SellerCopyBoundary'
import { getDictionary } from '@/lib/dictionary'
import { getMySeller } from '@/lib/get-my-seller'
import { isEnabled } from '@/lib/flags'
import { getTenantIntake } from '@/lib/tenant-intake'
import { resolveSellerSignupMarket } from '@/lib/seller-signup-market'
import { SELLER_LOCALE_COOKIE, resolveSellerLocale, sellerCopyBoundaryNeeded } from '@/lib/seller-locale'
import { sellerLandingRedirectPath } from '@/lib/seller-acquisition'

// First-run, agent-native path (Onboarding 0, Sprint 2). Offered to signed-in
// users who don't have a shop yet; the manual <SellWizard> stays as the no-agent
// fallback right below it.
function AgentSetupNudge() {
  return (
    <Link
      href="/sell/setup"
      className="block no-underline rounded-[var(--r-lg)] border border-[var(--color-border)] bg-[var(--surface-muted)] p-4 mb-5 hover:border-[var(--color-accent)] transition-colors"
    >
      <div className="flex items-start gap-3">
        <i className="iconoir-sparks text-2xl leading-none" aria-hidden />
        <div>
          <p className="font-semibold text-[var(--fg)] text-sm">
            ¿Tu agente ya armó tu tienda? Pégala aquí.
          </p>
          <p className="text-xs text-[var(--color-muted)] mt-0.5">
            Si tu IA generó un archivo de configuración, créala con catálogo en un solo paso —
            sin llenar el formulario. <span className="text-[var(--color-accent)] font-medium">Abrir →</span>
          </p>
        </div>
      </div>
    </Link>
  )
}

/**
 * `/sell` is the publish wizard, and nothing else.
 *
 * It used to serve two audiences off one URL: signed-out it rendered a marketing
 * hero (Mexican by default, the US recruiting landing when the request happened to
 * carry `?market=us`), signed-in it rendered the wizard. That made the most
 * guessable URL on the site a page in the wrong language for half its visitors, and
 * gave the US landing no address of its own. Both landings now have real URLs
 * (`/mx/vende`, `/us/sell`) and the signed-out branch is a redirect to whichever
 * one belongs to the visitor's market.
 *
 * So the metadata is a constant again, and it is `noindex`: everything here is
 * behind an account, and the only thing a crawler can reach is the redirect.
 */
export const metadata = {
  title: 'Publicar anuncio — Miyagi Sánchez',
  description: 'Publica tu producto, servicio o renta en segundos. Sin comisiones, sin complicaciones.',
  robots: { index: false, follow: true },
}

export default async function SellPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  // A not-yet-created seller has no Medusa market. The explicit, validated
  // signup market is the existing S5 authority for this one pre-seller state.
  const params = (await searchParams) ?? {}
  const marketParam = Array.isArray(params.market) ? params.market[0] : params.market
  const signupMarket = resolveSellerSignupMarket(marketParam)

  // A visitor with no shop yet has no Medusa market, so the validated signup
  // market is what DEFAULTS their language here — and their stored preference
  // still overrides it, exactly as it does for a seller who already has a shop.
  // Hardcoding 'en' on this branch would hand an English wizard to a US signup
  // who had explicitly chosen Spanish.
  //
  // The seller shell around this page cannot make the same call: middleware
  // publishes `x-miyagi-path` as the pathname only, so a layout never sees
  // `?market=us`. Market therefore picks the PAGE (below) and the resolved
  // locale picks the LANGUAGE.
  const locale = resolveSellerLocale({
    preference: (await cookies()).get(SELLER_LOCALE_COOKIE)?.value,
    market: signupMarket,
  })
  const user = await currentUser()

  if (!user) {
    // A visitor who cannot publish yet belongs on the pitch page for their market,
    // not on a thinner copy of it wearing the wizard's URL. `/mx/vende` in Spanish,
    // `/us/sell` in English, with the campaign attribution carried across so the
    // hop does not cost the landing its `from`, its A/B variant or its UTM.
    //
    // A redirect and not a render: two pages that say the same thing drift, and the
    // one nobody links to drifts first — this branch had been promising "0% comisión ·
    // SPEI · Mercado Pago" to US visitors before PR 389, and nothing caught it because
    // nothing pointed at it.
    redirect(sellerLandingRedirectPath(signupMarket, params))
  }

  // Medusa is the source of truth for sellers (same as /shop/manage). Checking it
  // here keeps shop-detection consistent: a user who created a shop but no listing
  // yet still skips Step 1 instead of being asked to re-create the shop.
  // `getMySeller()` is request-memoized (React `cache()`) — the seller-shell
  // eligibility gate in `app/(shell)/layout.tsx`/`app/(shell)/sell/layout.tsx`
  // calls the same function, so this costs one Medusa round-trip per request,
  // not two.
  const existingShop = await getMySeller()
  // Arranged-only delivery (epic, S1.2) — the "Entrega" toggle stays hidden
  // pre-launch; server-evaluated so the flag flip needs no client round-trip.
  const arrangedOnlyEnabled = await isEnabled('shipping.arranged_only_enabled')
  // "Solo mi tienda" (owned-shop-operating-channel epic, S3.1) — the checkbox
  // stays hidden while catalog.owned_shop_only_enabled is off (D8); same
  // server-evaluated pattern as arrangedOnlyEnabled above.
  const ownedShopOnlyEnabled = await isEnabled('catalog.owned_shop_only_enabled')

  // Onboarding three-doors first-run entry (Sprint 1 · Story 1.1). A fresh,
  // shop-less merchant who hasn't already started (no tenant_intake row) and
  // hasn't deliberately opted out this session (the ghost CTA's skip
  // signal) gets redirected into S1 Bienvenida instead of today's
  // SellWizard entry. Flag OFF (the default) or any shop/intake/skip signal
  // present ⇒ this is a no-op, unchanged behavior.
  if (!existingShop) {
    const cookieStore = await cookies()
    const skipped = cookieStore.get('onboarding_skip')?.value === '1'
    if (!skipped && (await isEnabled('onboarding.three_doors_enabled'))) {
      const intake = await getTenantIntake(user.id)
      if (!intake) redirect('/sell/bienvenida')
    }
  }

  const content = (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {/* Prompt-to-shop S2.2: a signed-in merchant with no shop starts by describing. The manual wizard stays right
          below (its own anchor), and the three-doors redirect above is untouched — S3.3 removes it. */}
      {/* es-MX only (AGENTS rule 5): generation is an MX-shaped shop in Spanish, so a US signup keeps today's flow. */}
      {!existingShop && signupMarket !== 'us' && (
        <div className="mb-6">
          <DescribeBox siteKey={process.env.TURNSTILE_SITE_KEY || null} manualHref="#armar-a-mano" />
        </div>
      )}
      {!existingShop && <AgentSetupNudge />}
      <div id="armar-a-mano">
        <SellWizard
          existingShop={existingShop}
          arrangedOnlyEnabled={arrangedOnlyEnabled}
          ownedShopOnlyEnabled={ownedShopOnlyEnabled}
          signupMarket={signupMarket}
        />
      </div>
    </div>
  )
  // Existing US shops are wrapped by the layout from their Medusa market. This
  // branch is only for a fresh seller whose validated signup market is US.
  if (existingShop || !sellerCopyBoundaryNeeded(locale)) return content
  const copy = (await getDictionary(locale)).sellerCopy
  return <SellerCopyBoundary locale={locale} copy={copy}>{content}</SellerCopyBoundary>
}
