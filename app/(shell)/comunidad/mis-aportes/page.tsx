import { redirect } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import MisAportesClient from './MisAportesClient'

export const metadata = { title: { absolute: 'Mis aportes — Miyagi Sánchez' } }

export default async function MisAportesPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in?redirect_url=/comunidad/mis-aportes')
  return <MisAportesClient />
}
