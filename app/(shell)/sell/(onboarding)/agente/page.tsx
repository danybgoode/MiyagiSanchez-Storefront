import { redirect } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import { getMySeller } from '@/lib/get-my-seller'
import { getMlConnection } from '@/lib/ml-connection'
import AgenteIntakeClient from './AgenteIntakeClient'

export const metadata = {
  title: { absolute: 'Trae tu catálogo — Miyagi Sánchez' },
}

/**
 * S3 drop-anything intake (onboarding three-doors, Sprint 1 · Story 1.3).
 * The "Traer de Mercado Libre" row only ever applies to a merchant who
 * already has a Medusa seller AND a live ML connection — rare for a
 * genuinely pre-shop three-doors visitor, but wired correctly rather than
 * hardcoded false, so it lights up naturally for a returning merchant.
 */
export default async function AgentePage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const seller = await getMySeller()
  const mlConnected = seller
    ? (await getMlConnection(seller.slug)).connection !== null
    : false

  return <AgenteIntakeClient mlConnected={mlConnected} />
}
