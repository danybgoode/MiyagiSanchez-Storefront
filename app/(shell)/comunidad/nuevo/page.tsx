import { redirect } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import ComunidadForm from './ComunidadForm'

export const metadata = { title: { absolute: 'Comparte con tu colonia — Miyagi Sánchez' } }

export default async function ComunidadNuevoPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in?redirect_url=/comunidad/nuevo')
  return <ComunidadForm />
}
