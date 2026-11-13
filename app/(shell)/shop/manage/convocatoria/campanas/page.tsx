import { redirect, notFound } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { isEnabled } from '@/lib/flags'
import { SellerBreadcrumb } from '../../SellerBreadcrumb'
import CampaignsManager from './CampaignsManager'

export const metadata = { title: { absolute: 'Campañas de votación — Miyagi Sánchez' } }

/**
 * Bookshop launchpad · Sprint 3.1 — the voting-campaign builder, nested under the
 * convocatoria hub. Dark-shipped behind `launchpad.enabled` (fail-safe OFF): the
 * whole surface 404s until an admin flips the flag on.
 */
export default async function CampanasPage() {
  if (!(await isEnabled('launchpad.enabled'))) notFound()

  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, slug')
    .eq('clerk_user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!shop) redirect('/sell')

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div style={{ marginBottom: 20 }}>
        <SellerBreadcrumb extra={[
          { label: 'Convocatoria', href: '/shop/manage/convocatoria' },
          { label: 'Campañas', href: null },
        ]} />
        <h1 style={{ fontWeight: 700, fontSize: 22, marginTop: 8 }}>Campañas de votación</h1>
        <p style={{ color: 'var(--color-muted)', fontSize: 14, marginTop: 6 }}>
          La comunidad vota por las obras. Al alcanzar el umbral de votos, se desbloquea un cupón de
          descuento sobre la impresión del libro.
        </p>
      </div>

      <CampaignsManager shopSlug={shop.slug} />
    </div>
  )
}
