import { redirect } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import SetupClient from './SetupClient'

export const metadata = {
  title: { absolute: 'Arma tu tienda con tu agente — Miyagi Sánchez' },
  description:
    'Pega el archivo que generó tu agente de IA y crea tu tienda y catálogo en un solo paso.',
}

// First-run apply (Onboarding 0, Sprint 2). Unlike /shop/manage/import, this entry
// deliberately does NOT require an existing shop — its whole job is to create one
// (create-shop-if-missing) from the pasted setup file. Sign-in is the only gate.
export default async function SellSetupPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-up')

  return <SetupClient />
}
