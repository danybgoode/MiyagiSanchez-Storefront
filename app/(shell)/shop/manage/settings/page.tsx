import { redirect } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import Link from 'next/link'
import { SellerBreadcrumb } from '../SellerBreadcrumb'
import { orderedSections, MANUAL_KEYS } from '@/lib/shop-settings/taxonomy'
import { isEnabled } from '@/lib/flags'
import { computeShopCompletion, completedSectionKeys, type ShopRow } from '@/lib/setup-guide'
import GuideRestoreToggle from './GuideRestoreToggle'

export const metadata = { title: { absolute: 'Configuración — Miyagi Sánchez' } }

// ── Section definitions ────────────────────────────────────────────────────────
// Sourced from the one canonical taxonomy (lib/shop-settings/taxonomy.ts).
// Adapted to the card-render shape this grid already uses (key/title), so the
// JSX below is unchanged. `cardTitle` is the index-card label (only "Devoluciones"
// differs from the focused-page heading). MANUAL_KEYS — sections needing a live
// handshake (OAuth / money / domain / webhook) — also comes from the map.

const SECTIONS = orderedSections().map((s) => ({
  key: s.slug,
  icon: s.icon,
  title: s.cardTitle,
  desc: s.desc,
  color: s.color,
  bg: s.bg,
}))

export default async function SettingsIndexPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const { data: shop } = await db
    .from('marketplace_shops')
    .select('id, slug, name, description, logo_url, metadata, mp_enabled, custom_domain, ucp_webhook_url')
    .eq('clerk_user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!shop) redirect('/sell')

  const flags = computeShopCompletion(shop as unknown as ShopRow)
  const done = completedSectionKeys(flags)
  const guideDismissed = !!(shop.metadata as { settings?: { guide?: { guide_dismissed?: boolean } } } | null)?.settings?.guide?.guide_dismissed

  // Mercado Libre connect is dark-shipped behind a flag (epic 03 · mercadolibre-sync).
  // The entry card appears only once `ml.connect_enabled` is flipped on.
  const mlEnabled = await isEnabled('ml.connect_enabled')

  // Bookshop launchpad (epic 03 · bookshop-launchpad) — writer submissions. The
  // entry card appears only once `launchpad.enabled` is flipped on (fail-safe OFF).
  const launchpadEnabled = await isEnabled('launchpad.enabled')

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <SellerBreadcrumb className="mb-3" />
        <h1 style={{ fontWeight: 700, fontSize: 24 }}>Configuración</h1>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)', marginTop: 4 }}>
          {done.size} de {SECTIONS.filter(s => !('soon' in s && s.soon)).length} secciones configuradas
        </p>
        {/* Progress bar */}
        <div style={{ height: 4, background: 'var(--border)', borderRadius: 4, marginTop: 10, overflow: 'hidden' }}>
          <div style={{ height: '100%', background: 'var(--accent)', borderRadius: 4, width: `${(done.size / SECTIONS.filter(s => !('soon' in s && s.soon)).length) * 100}%`, transition: 'width 600ms' }} />
        </div>
      </div>

      {/* Setup guide restore toggle (seller-portal-setup-guide epic, B.3) */}
      <GuideRestoreToggle initialDismissed={guideDismissed} />

      {/* Import config CTA */}
      <Link href="/shop/manage/settings/import" className="no-underline">
        <div style={{ marginBottom: 16, padding: '14px 16px', background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 'var(--r-lg)', display: 'flex', alignItems: 'center', gap: 12 }} className="hover:shadow-[var(--shadow-2)]">
          <i className="iconoir-import" style={{ fontSize: 20, color: 'var(--accent)', flexShrink: 0 }} />
          <div className="flex-1 min-w-0">
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--accent)' }}>¿Te cambias de plataforma? Importa tu configuración</p>
            <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2, lineHeight: 1.4 }}>Sube un archivo y configura tu tienda de un jalón, sin pasar por cada pantalla.</p>
          </div>
          <i className="iconoir-arrow-right" style={{ fontSize: 14, color: 'var(--fg-subtle)', flexShrink: 0 }} />
        </div>
      </Link>

      {/* Section grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(1, 1fr)', gap: 10 }} className="sm:grid-cols-2">
        {SECTIONS.map(section => {
          const isSoon = 'soon' in section && section.soon
          return (
          <Link
            key={section.key}
            href={`/shop/manage/settings/${section.key}`}
            className="no-underline"
            style={{ opacity: isSoon ? 0.65 : 1 }}
          >
            <div
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 14,
                padding: '16px', background: 'var(--bg-elevated)',
                border: '1.5px solid var(--border)',
                borderRadius: 'var(--r-lg)',
                boxShadow: 'var(--shadow-1)',
                transition: 'box-shadow 150ms',
                position: 'relative',
                overflow: 'hidden',
              }}
              className={isSoon ? '' : 'hover:shadow-[var(--shadow-2)]'}
            >
              <div style={{ width: 40, height: 40, borderRadius: 'var(--r-md)', background: section.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <i className={section.icon} style={{ fontSize: 20, color: section.color }} />
              </div>
              <div className="flex-1 min-w-0">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <p style={{ fontWeight: 600, fontSize: 14, color: 'var(--fg)' }}>{section.title}</p>
                  {isSoon ? (
                    <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--warning)', background: 'var(--warning-soft)', border: '1px solid var(--warning)', borderRadius: 'var(--r-pill)', padding: '2px 7px', flexShrink: 0 }}>Próximamente</span>
                  ) : done.has(section.key) ? (
                    <i className="iconoir-check" aria-hidden style={{ fontSize: 11, color: 'var(--success)', fontWeight: 600, flexShrink: 0 }} />
                  ) : MANUAL_KEYS.has(section.key) ? (
                    <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-muted)', background: 'var(--bg-sunk)', border: '1px solid var(--border)', borderRadius: 'var(--r-pill)', padding: '2px 7px', flexShrink: 0 }}>Pendiente</span>
                  ) : null}
                </div>
                <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2, lineHeight: 1.4 }}>{section.desc}</p>
                {!isSoon && !done.has(section.key) && MANUAL_KEYS.has(section.key) && (
                  <p style={{ fontSize: 11, color: 'var(--warning)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4, lineHeight: 1.3 }}>
                    <i className="iconoir-warning-triangle" style={{ fontSize: 12, flexShrink: 0 }} />
                    Aún requiere un paso manual — termínalo aquí.
                  </p>
                )}
              </div>
              <i className="iconoir-arrow-right" style={{ fontSize: 14, color: 'var(--fg-subtle)', alignSelf: 'center', flexShrink: 0 }} />
            </div>
          </Link>
          )
        })}
      </div>

      {/* Mercado Libre (dark-shipped behind ml.connect_enabled) */}
      {mlEnabled && (
        <Link href="/shop/manage/mercadolibre" className="no-underline">
          <div style={{ marginTop: 16, padding: '16px', background: 'var(--bg-elevated)', border: '1.5px solid var(--border)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-1)', display: 'flex', alignItems: 'flex-start', gap: 14 }} className="hover:shadow-[var(--shadow-2)]">
            <div style={{ width: 40, height: 40, borderRadius: 'var(--r-md)', background: 'var(--warning-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <i className="iconoir-shop-four-tiles" style={{ fontSize: 20, color: 'var(--warning)' }} />
            </div>
            <div className="flex-1 min-w-0">
              <p style={{ fontWeight: 600, fontSize: 14, color: 'var(--fg)' }}>Mercado Libre</p>
              <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2, lineHeight: 1.4 }}>Conecta tu cuenta para sincronizar tu catálogo e inventario.</p>
            </div>
            <i className="iconoir-arrow-right" style={{ fontSize: 14, color: 'var(--fg-subtle)', alignSelf: 'center', flexShrink: 0 }} />
          </div>
        </Link>
      )}

      {/* Bookshop launchpad (dark-shipped behind launchpad.enabled) */}
      {launchpadEnabled && (
        <Link href="/shop/manage/convocatoria" className="no-underline">
          <div style={{ marginTop: 16, padding: '16px', background: 'var(--bg-elevated)', border: '1.5px solid var(--border)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-1)', display: 'flex', alignItems: 'flex-start', gap: 14 }} className="hover:shadow-[var(--shadow-2)]">
            <div style={{ width: 40, height: 40, borderRadius: 'var(--r-md)', background: 'var(--accent-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <i className="iconoir-book" style={{ fontSize: 20, color: 'var(--accent)' }} />
            </div>
            <div className="flex-1 min-w-0">
              <p style={{ fontWeight: 600, fontSize: 14, color: 'var(--fg)' }}>Convocatoria de manuscritos</p>
              <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2, lineHeight: 1.4 }}>Recibe manuscritos de escritores y publícalos como productos digitales.</p>
            </div>
            <i className="iconoir-arrow-right" style={{ fontSize: 14, color: 'var(--fg-subtle)', alignSelf: 'center', flexShrink: 0 }} />
          </div>
        </Link>
      )}

      {/* Agent CTA */}
      <div style={{ marginTop: 24, padding: '14px 16px', background: 'var(--agent-soft)', borderRadius: 'var(--r-lg)', border: '1px solid var(--agent)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <i className="iconoir-sparks" style={{ fontSize: 20, color: 'var(--agent)', flexShrink: 0, marginTop: 1 }} />
        <div>
          <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--agent)', marginBottom: 4 }}>Configura con tu agente</p>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
            Puedes pedirle a tu agente que configure tu tienda por ti. Comparte el enlace de tu tienda y deja que negocie mientras tú descansas.
          </p>
        </div>
      </div>
    </div>
  )
}
