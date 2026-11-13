import { redirect } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import AccountPrintAdsClient from './AccountPrintAdsClient'

export const metadata = { title: { absolute: 'Mis anuncios impresos — Miyagi Sánchez' } }

export default async function AccountPrintAdsPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')
  return <AccountPrintAdsClient />
}
