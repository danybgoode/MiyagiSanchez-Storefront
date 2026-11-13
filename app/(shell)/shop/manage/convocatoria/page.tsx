import { redirect, notFound } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { isEnabled } from '@/lib/flags'
import { SellerBreadcrumb } from '../SellerBreadcrumb'
import ConvocatoriaSettingsClient from './ConvocatoriaSettingsClient'
import SubmissionsQueue from './SubmissionsQueue'
import ShelfCard from './ShelfCard'
import { marketplaceUrl } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'

export const metadata = { title: { absolute: 'Convocatoria — Miyagi Sánchez' } }

export default async function ConvocatoriaManagePage() {
  // Dark-shipped behind the launchpad kill-switch — the whole surface 404s
  // until an admin flips `launchpad.enabled` on (fail-safe OFF).
  if (!(await isEnabled('launchpad.enabled'))) notFound()

  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, slug, metadata')
    .eq('clerk_user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!shop) redirect('/sell')

  const meta = (shop.metadata ?? {}) as Record<string, unknown>
  const settings = (meta.settings ?? {}) as Record<string, unknown>
  const lp = (settings.launchpad ?? {}) as { accepts_manuscripts?: boolean; guidelines?: string | null }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div style={{ marginBottom: 20 }}>
        <SellerBreadcrumb extra={[{ label: 'Convocatoria', href: null }]} />
        <h1 style={{ fontWeight: 700, fontSize: 22, marginTop: 8 }}>Convocatoria de manuscritos</h1>
      </div>

      <ConvocatoriaSettingsClient
        initial={{
          accepts_manuscripts: lp.accepts_manuscripts === true,
          guidelines: typeof lp.guidelines === 'string' ? lp.guidelines : null,
        }}
        publicUrl={marketplaceUrl(SITE_ORIGIN, `/s/${shop.slug}/convocatoria`)}
      />

      <div className="mt-8">
        <ShelfCard />
      </div>

      <div className="mt-8">
        <SubmissionsQueue />
      </div>

      {/* Voting campaigns (Sprint 3): rally votes → unlock the 50% print coupon. */}
      <a
        href="/shop/manage/convocatoria/campanas"
        className="mt-8"
        style={{
          display: 'block', border: '1px solid var(--color-border)', borderRadius: 12,
          padding: 16, textDecoration: 'none', color: 'inherit',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div>
            <strong style={{ fontSize: 'var(--t-base)' }}>Campañas de votación</strong>
            <p style={{ fontSize: 13, color: 'var(--color-muted)', marginTop: 4 }}>
              La comunidad vota por las obras; al alcanzar el umbral se desbloquea el cupón de impresión.
            </p>
          </div>
          <span aria-hidden style={{ fontSize: 20, color: 'var(--fg-subtle)' }}>→</span>
        </div>
      </a>
    </div>
  )
}
