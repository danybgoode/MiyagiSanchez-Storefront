import { redirect } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import { getOrCreateReferralCode, getReferralStats } from '@/lib/referrals'
import ReferralsClient from './ReferralsClient'

export const metadata = { title: { absolute: 'Invita y gana — Miyagi Sánchez' } }
export const dynamic = 'force-dynamic'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://miyagisanchez.com'

export default async function ReferralsPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const [code, stats] = await Promise.all([
    getOrCreateReferralCode(user.id),
    getReferralStats(user.id),
  ])

  return <ReferralsClient code={code} stats={stats} siteUrl={SITE_URL} />
}
