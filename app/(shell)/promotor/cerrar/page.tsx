import { redirect, notFound } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import { isEnabled } from '@/lib/flags'
import { getPromoterByClerkId } from '@/lib/promoter'
import PromoterCloseClient from './PromoterCloseClient'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Abrir una tienda — Promotor', robots: { index: false } }

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

  const [promoter, transferEnabled, previewEnabled, activationCrmEnabled] = await Promise.all([
    getPromoterByClerkId(user.id),
    isEnabled('promoter.transfer_enabled'),
    isEnabled('promoter.private_preview_enabled'),
    isEnabled('promoter.activation_crm_enabled'),
  ])

  return (
    <PromoterCloseClient
      bound={promoter ? { code: promoter.code, name: promoter.name } : null}
      transferEnabled={transferEnabled}
      previewEnabled={previewEnabled}
      activationCrmEnabled={activationCrmEnabled}
    />
  )
}
