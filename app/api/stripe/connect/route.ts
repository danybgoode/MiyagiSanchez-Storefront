import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { stripe, createAccountLink, getShopStripe } from '@/lib/stripe'
import { db } from '@/lib/supabase'
import { syncMedusaSellerProfile } from '@/lib/medusa-seller-sync'
import { resolveOrigin, publicUrl } from '@/lib/request-origin'
import { getMySeller } from '@/lib/get-my-seller'
import { connectPlanFor, isAllowedConnectNavigation, usOnboardingUrl } from '@/lib/stripe-connect-market'

const MEDUSA_BASE = process.env.MEDUSA_STORE_URL ?? 'http://localhost:9000'
const PUB_KEY = process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY ?? ''

// GET — initiate Stripe Connect onboarding for the current seller
export async function GET(req: NextRequest) {
  const { userId, getToken } = await auth()
  if (!userId) {
    return NextResponse.redirect(publicUrl('/sign-in', req))
  }

  const errorRedirect = (reason: string) =>
    NextResponse.redirect(
      publicUrl(`/shop/manage/settings?stripe=error&reason=${encodeURIComponent(reason)}`, req),
    )

  // Fetch shop
  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, metadata')
    .eq('clerk_user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!shop) {
    return NextResponse.redirect(publicUrl('/sell', req))
  }


  const meta = (shop.metadata ?? {}) as Record<string, unknown>
  const settings = (meta.settings ?? {}) as Record<string, unknown>
  const stripeSettings = getShopStripe(shop.metadata as Record<string, unknown> | null)

  let origin: string
  try {
    origin = resolveOrigin({ siteUrl: process.env.NEXT_PUBLIC_SITE_URL, host: req.headers.get('host') })
  } catch (e) {
    return errorRedirect(e instanceof Error ? e.message : 'origin_unresolvable')
  }

  // A US shop onboards through the backend's Accounts v2 route; everything below is the Mexican Express flow
  // (`lib/stripe-connect-market.ts` has the why). An unreadable market is refused, never treated as Mexico.
  const plan = connectPlanFor(await getMySeller().catch(() => null))
  if (plan.kind === 'unknown_market') return errorRedirect('market_unavailable')
  if (plan.kind === 'us_v2') {
    if (!isAllowedConnectNavigation({ secFetchSite: req.headers.get('sec-fetch-site'), referer: req.headers.get('referer'), siteHost: new URL(origin).host })) {
      return errorRedirect('cross_site')
    }
    const jwt = await getToken()
    if (!jwt) return NextResponse.redirect(publicUrl('/sign-in', req))
    const res = await fetch(`${MEDUSA_BASE}/store/sellers/me/stripe-connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-publishable-api-key': PUB_KEY, Authorization: `Bearer ${jwt}` },
      body: '{}',
      cache: 'no-store',
    }).catch(() => null)
    const url = res && res.ok ? usOnboardingUrl(await res.json().catch(() => null)) : null
    if (!url) {
      console.error('[stripe/connect] US v2 onboarding failed', res?.status ?? 'fetch_failed')
      return errorRedirect('us_onboarding_failed')
    }
    return NextResponse.redirect(url)
  }

  // ── Create or retrieve Connect account ───────────────────────────────────
  let accountId = stripeSettings.account_id

  if (!accountId) {
    try {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'MX',
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: {
          mcc: '5999', // miscellaneous retail
        },
      })
      accountId = account.id

      // Persist the account ID immediately (before onboarding completes)
      const nextSettings = {
        ...settings,
        stripe: { ...stripeSettings, account_id: accountId, charges_enabled: false, onboarding_complete: false },
      }

      await db.from('marketplace_shops').update({
        metadata: {
          ...meta,
          settings: nextSettings,
        },
      }).eq('id', shop.id)

      try {
        await syncMedusaSellerProfile(await getToken(), { metadata: { settings: nextSettings } })
      } catch (e) {
        console.error('[stripe/connect] Medusa seller sync failed (non-fatal):', e)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[stripe/connect] accounts.create failed:', msg)
      return errorRedirect(msg)
    }
  }

  // ── Generate onboarding link ─────────────────────────────────────────────
  // If accountId came from a stale/previous attempt and accountLinks.create fails,
  // clear it and retry once with a fresh account.
  try {
    const url = await createAccountLink(accountId, origin)
    return NextResponse.redirect(url)
  } catch (linkErr) {
    const linkMsg = linkErr instanceof Error ? linkErr.message : String(linkErr)
    console.error('[stripe/connect] accountLinks.create failed for', accountId, ':', linkMsg)

    // Stale account ID — clear it and try creating a brand-new account
    if (stripeSettings.account_id) {
      try {
        const freshAccount = await stripe.accounts.create({
          type: 'express',
          country: 'MX',
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          business_profile: { mcc: '5999' },
        })
        const freshId = freshAccount.id

        const nextSettings = {
          ...settings,
          stripe: { ...stripeSettings, account_id: freshId, charges_enabled: false, onboarding_complete: false },
        }

        await db.from('marketplace_shops').update({
          metadata: {
            ...meta,
            settings: nextSettings,
          },
        }).eq('id', shop.id)

        try {
          await syncMedusaSellerProfile(await getToken(), { metadata: { settings: nextSettings } })
        } catch (e) {
          console.error('[stripe/connect] Medusa seller sync failed (non-fatal):', e)
        }

        const freshUrl = await createAccountLink(freshId, origin)
        return NextResponse.redirect(freshUrl)
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
        console.error('[stripe/connect] retry also failed:', retryMsg)
        return errorRedirect(retryMsg)
      }
    }

    return errorRedirect(linkMsg)
  }
}
