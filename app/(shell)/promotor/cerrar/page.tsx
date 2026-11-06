import { redirect, notFound } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import { isEnabled } from '@/lib/flags'
import { getCommissionRates, getPromoterByClerkId } from '@/lib/promoter'
import { PACKAGE_SKUS } from '@/lib/promoter-packages'
import { getOverriddenDictionary } from '@/lib/copy-overrides'
import PromoterCloseClient from './PromoterCloseClient'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Tu panel de promotor', robots: { index: false } }

/**
 * Authed promoter "close" workspace (epic 08 · S4). Where a logged-in promoter
 * binds their PRM- code (one-time), sets up an unclaimed shop for a merchant,
 * pays the SKU on the merchant's behalf (cash collected in person), and hands off
 * a WhatsApp claim link. Distinct from the unauthed read-only `/promotor/[code]`
 * commission dashboard. Clerk- + `promoter.enabled`-gated.
 */
export default async function PromoterClosePage() {
  if (!(await isEnabled('promoter.enabled'))) notFound()

  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const [promoter, transferEnabled, previewEnabled, activationCrmEnabled, rates, dict] = await Promise.all([
    getPromoterByClerkId(user.id),
    isEnabled('promoter.transfer_enabled'),
    isEnabled('promoter.private_preview_enabled'),
    isEnabled('promoter.activation_crm_enabled'),
    getCommissionRates(),
    getOverriddenDictionary('es'),
  ])
  // Only the three options' rates reach the client: the workspace shows each one's split where the promoter pays.
  const packageRates = Object.fromEntries(PACKAGE_SKUS.map((sku) => [sku, rates[sku] ?? 0]))

  return (
    <PromoterCloseClient
      bound={promoter ? { code: promoter.code, name: promoter.name } : null}
      transferEnabled={transferEnabled}
      previewEnabled={previewEnabled}
      activationCrmEnabled={activationCrmEnabled}
      packageRates={packageRates}
      copy={dict.promotorPanel}
    />
  )
}
