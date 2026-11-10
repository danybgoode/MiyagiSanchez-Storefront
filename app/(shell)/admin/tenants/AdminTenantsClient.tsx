'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  selectTenants,
  entitlementReasonLabel,
  claimStatusLabel,
  domainStatusLabel,
  type TenantFilter,
  type TenantRow,
  type TenantSortKey,
  type SortDirection,
} from '@/lib/admin/tenant-directory'
import { sellerStatusLabel, sellerStatusTone, type SellerStatus } from '@/lib/seller-status'
import { ADMIN_LIST_FIRST_PAGE, paginate } from '@/lib/admin-pagination'
import TenantLifecyclePanel from './TenantLifecyclePanel'
import AdminPagination from '../_components/AdminPagination'
import type { DomainGrant, DomainEntitlementReason } from '@/lib/domain-entitlement'

/**
 * Tenant directory (admin-consolidation · S3 read model + S4 actions). Searches
 * the shaped rows in memory (`filterTenants`) and opens an inline inspector for
 * one shop. S4 adds the custom-domain comp **grant/revoke** controls on the
 * inspector — the only mutate surface; everything else stays read-only. The
 * canonical identity shown is the Medusa seller id.
 */

/** Shape of `POST/GET /api/admin/tenants/[id]` — the resolved entitlement. */
type EntitlementResponse = {
  entitlementReason: DomainEntitlementReason
  entitled: boolean
  grant: DomainGrant | null
}

// Keep the expensive tenant directory bounded to a practical operator page.
const TENANTS_PAGE_SIZE = 25

export default function AdminTenantsClient({ tenants }: { tenants: TenantRow[] }) {
  const [filter, setFilter] = useState<TenantFilter>({})
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<{ key: TenantSortKey; direction: SortDirection }>({
    key: 'name',
    direction: 'asc',
  })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /**
   * The last lifecycle outcome, held HERE rather than in the row.
   *
   * A status change can remove the row from the current filter — reactivating while
   * filtered to "en pausa" is the obvious case — and the row unmounts with its
   * message. The partial-restore warning is the most important thing this screen can
   * say, so it lives above the list and stays until dismissed.
   */
  const [report, setReport] = useState<{ shopName: string; message: string; incomplete: boolean } | null>(null)
  /**
   * Lifecycle locks, held HERE and keyed by shop rather than inside the row.
   *
   * The panel's `working` and `unknown` states used to live in component state, so
   * collapsing the row — or filtering it away and reopening it — remounted a fresh
   * panel in `idle` and allowed a second POST while the first was unresolved. That is
   * exactly the race the lock exists to prevent, defeated by React's own lifecycle.
   */
  const [locks, setLocks] = useState<Record<string, 'working' | 'unknown'>>({})
  // Local copy so a grant/revoke or a status change reflects in place.
  const [rows, setRows] = useState<TenantRow[]>(tenants)

  // The SAME pure selector the api spec asserts over, so the screen and the spec
  // cannot disagree about what "unclaimed, sorted by listings" means.
  const filtered = useMemo(() => selectTenants(rows, filter, sort), [rows, filter, sort])
  const pagination = useMemo(
    () => paginate(filtered, page, TENANTS_PAGE_SIZE),
    [filtered, page],
  )

  function updateFilter(patch: Partial<TenantFilter>) {
    setPage(ADMIN_LIST_FIRST_PAGE)
    setFilter((prev) => {
      const next = { ...prev, ...patch }
      for (const key of Object.keys(next) as (keyof TenantFilter)[]) {
        if (!next[key] || next[key] === 'any') delete next[key]
      }
      return next
    })
  }

  function updateSort(patch: Partial<{ key: TenantSortKey; direction: SortDirection }>) {
    setPage(ADMIN_LIST_FIRST_PAGE)
    setSort((prev) => ({ ...prev, ...patch }))
  }

  function patchRow(shopId: string, partial: Partial<TenantRow>) {
    setRows((prev) => prev.map((r) => (r.shopId === shopId ? { ...r, ...partial } : r)))
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Tiendas</h1>
        <p className="text-sm text-[var(--color-muted)] mt-1">
          Directorio de tiendas: identidad (vendedor Medusa), reclamo, dominio, plan y número de
          anuncios. Puedes otorgar o revocar cortesías (dominio, subdominio o sincronización ML) desde el detalle.
        </p>
      </div>

      {report && (
        <div
          role="status"
          className={`flex items-start gap-3 rounded-lg border px-3 py-2 text-sm ${
            report.incomplete
              ? 'border-[var(--color-warning,#9a6700)] bg-[var(--color-warning-bg,#fff4e5)]'
              : 'border-[var(--color-border)] bg-[var(--color-bg-subtle)]'
          }`}
        >
          <span className="flex-1">
            <strong>{report.shopName}:</strong> {report.message}
          </span>
          <button
            type="button"
            onClick={() => setReport(null)}
            className="text-xs underline"
            aria-label="Descartar"
          >
            Descartar
          </button>
        </div>
      )}

      <input
        type="search"
        value={filter.q ?? ''}
        onChange={(e) => updateFilter({ q: e.target.value })}
        placeholder="Busca por nombre, slug, dominio, id de vendedor o correo…"
        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
      />

      <div className="flex flex-wrap items-end gap-2 text-xs">
        <Select
          label="Estado"
          value={filter.status ?? 'any'}
          onChange={(v) => updateFilter({ status: v as SellerStatus | 'any' })}
          options={[
            ['any', 'Cualquiera'],
            ['active', 'Activa'],
            ['paused', 'En pausa'],
            ['deleted', 'Eliminada'],
            // The two non-status states are filterable too: they are exactly the rows
            // that need attention, and a distinction an operator cannot isolate is a
            // decorative one.
            ['not_imported', 'Sin importar a Medusa'],
            ['absent', 'Vendedor huérfano en Medusa'],
            ['unavailable', 'Estado no disponible'],
          ]}
        />
        <Select
          label="Reclamo"
          value={filter.claimed ?? 'any'}
          onChange={(v) => updateFilter({ claimed: v as 'claimed' | 'unclaimed' | 'any' })}
          options={[['any', 'Cualquiera'], ['claimed', 'Reclamada'], ['unclaimed', 'Sin reclamar']]}
        />
        <Select
          label="Mercado"
          value={filter.market ?? 'any'}
          onChange={(v) => updateFilter({ market: v as TenantFilter['market'] })}
          options={[['any', 'Cualquiera'], ['mx', 'México'], ['us', 'Estados Unidos'], ['unknown', 'Sin resolver']]}
        />
        <Select
          label="Dominio"
          value={filter.domain ?? 'any'}
          onChange={(v) => updateFilter({ domain: v as TenantFilter['domain'] })}
          options={[['any', 'Cualquiera'], ['verified', 'Verificado'], ['pending', 'Pendiente'], ['none', 'Sin dominio']]}
        />
        <Select
          label="Ordenar por"
          value={sort.key}
          onChange={(v) => updateSort({ key: v as TenantSortKey })}
          options={[
            ['name', 'Nombre'],
            ['listings', 'Anuncios'],
            ['created', 'Fecha de alta'],
            ['status', 'Estado'],
            ['market', 'Mercado'],
          ]}
        />
        <button
          type="button"
          onClick={() => updateSort({ direction: sort.direction === 'asc' ? 'desc' : 'asc' })}
          className="rounded border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-bg-subtle)]"
          aria-label="Invertir orden"
        >
          {sort.direction === 'asc' ? '↑ Ascendente' : '↓ Descendente'}
        </button>
      </div>

      <p className="text-xs text-[var(--color-muted)]">
        {filtered.length} {filtered.length === 1 ? 'tienda' : 'tiendas'}
        {Object.keys(filter).length ? ` (de ${rows.length})` : ''}
        {' · '}página {pagination.page} de {pagination.totalPages}
      </p>

      <div className="space-y-2">
        {pagination.pageItems.map((t) => {
          const open = t.shopId === selectedId
          return (
            <div key={t.shopId} className="rounded-lg border border-[var(--color-border)] overflow-hidden">
              <button
                type="button"
                onClick={() => setSelectedId(open ? null : t.shopId)}
                className="w-full text-left px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1 hover:bg-[var(--color-bg-subtle)]"
                aria-expanded={open}
              >
                <span className="font-medium">{t.name}</span>
                <span className="text-xs text-[var(--color-muted)]">/{t.slug}</span>
                <span className="ml-auto flex items-center gap-2 text-xs">
                  <Badge tone={sellerStatusTone(t.status)}>{sellerStatusLabel(t.status)}</Badge>
                  <Badge tone={t.claimed ? 'ok' : 'muted'}>{claimStatusLabel(t.claimed)}</Badge>
                  <Badge tone={t.domainStatus === 'verified' ? 'ok' : t.domainStatus === 'pending' ? 'warn' : 'muted'}>
                    {domainStatusLabel(t.domainStatus)}
                  </Badge>
                  <Badge tone={t.entitled ? 'ok' : t.subscriptionUnchecked ? 'warn' : 'muted'}>
                    {t.subscriptionUnchecked ? 'Sin plan (suscripción sin verificar)' : entitlementReasonLabel(t.entitlementReason)}
                  </Badge>
                  <Badge tone={t.operatingMarketCode ? 'ok' : 'warn'}>{t.marketplacePublicationLabel}</Badge>
                  {t.planLegacy !== 'absent' ? (
                    <Badge tone={t.planLegacy === 'marked' ? 'muted' : 'warn'}>{t.planLegacy === 'marked' ? 'Plan Gratis (de antes)' : 'Marca de Plan Gratis ilegible'}</Badge>
                  ) : null}
                  {t.pausedForPlan ? <Badge tone="warn">En pausa por falta de plan</Badge> : null}
                  <span className="text-[var(--color-muted)]">{t.listingCount} anuncios</span>
                </span>
              </button>

              {open && (
                <dl className="border-t border-[var(--color-border)] px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm bg-[var(--color-bg-subtle)]">
                  <Field label="Vendedor Medusa (id canónico)">
                    {t.medusaSellerId ? (
                      <code className="text-xs">{t.medusaSellerId}</code>
                    ) : (
                      <span className="text-[var(--color-muted)]">Sin vendedor Medusa (gema sin importar)</span>
                    )}
                  </Field>
                  <Field label="Slug">/{t.slug}</Field>
                  <Field label="Reclamo">{claimStatusLabel(t.claimed)}</Field>
                  <Field label="Mercado operativo">{t.operatingMarketLabel}</Field>
                  <Field label="Publicación de marketplace">{t.marketplacePublicationLabel}</Field>
                  <Field label="Dominio personalizado">
                    {t.customDomain ? (
                      <>
                        <code className="text-xs">{t.customDomain}</code>{' '}
                        <span className="text-[var(--color-muted)]">({domainStatusLabel(t.domainStatus)})</span>
                      </>
                    ) : (
                      <span className="text-[var(--color-muted)]">Sin dominio</span>
                    )}
                  </Field>
                  <div className="sm:col-span-2">
                    <dt className="text-xs text-[var(--color-muted)]">Plan de dominio</dt>
                    <dd className="mt-0.5">
                      <EntitlementControls row={t} onResolved={(p) => patchRow(t.shopId, p)} />
                    </dd>
                  </div>
                  <Field label="Correo de registro">
                    {t.registrationEmail === 'unavailable' ? (
                      // NOT a blank cell: "we could not ask Clerk" and "this merchant
                      // has no email" are different facts (D5).
                      <span className="text-[var(--color-muted)]">No disponible</span>
                    ) : t.registrationEmail ? (
                      <a href={`mailto:${t.registrationEmail}`} className="underline">{t.registrationEmail}</a>
                    ) : (
                      <span className="text-[var(--color-muted)]">Sin reclamar</span>
                    )}
                  </Field>
                  <Field label="Estado">{sellerStatusLabel(t.status)}</Field>
                  <div className="sm:col-span-2">
                    <dt className="text-xs text-[var(--color-muted)]">Ciclo de vida</dt>
                    <dd className="mt-0.5">
                      <TenantLifecyclePanel
                        row={t}
                        lock={locks[t.shopId] ?? null}
                        onLock={(lock) =>
                          setLocks((prev) => {
                            if (!lock) {
                              // Delete rather than destructure-omit: the omitted
                              // binding trips no-unused-vars, and this reads plainly.
                              const next = { ...prev }
                              delete next[t.shopId]
                              return next
                            }
                            return { ...prev, [t.shopId]: lock }
                          })
                        }
                        onChanged={(p) => patchRow(t.shopId, p)}
                        onReport={(next) =>
                          setReport((prev) =>
                            // Never overwrite an UNDISMISSED incomplete warning with a
                            // later success: the incomplete one names products that
                            // did not come back, and losing it loses the only record.
                            prev?.incomplete && !next.incomplete ? prev : next,
                          )
                        }
                      />
                    </dd>
                  </div>
                  <Field label="Anuncios">{t.listingCount}</Field>
                  <Field label="Creada">{t.createdAt ? new Date(t.createdAt).toLocaleDateString('es-MX') : '—'}</Field>
                </dl>
              )}
            </div>
          )
        })}

        {filtered.length === 0 && (
          <p className="text-sm text-[var(--color-muted)] py-8 text-center">
            {rows.length === 0 ? 'No hay tiendas para mostrar.' : 'Ninguna tienda coincide con tu búsqueda.'}
          </p>
        )}
      </div>

      <AdminPagination
        page={pagination.page}
        totalPages={pagination.totalPages}
        onPageChange={setPage}
      />
    </div>
  )
}

/**
 * Grant/revoke the custom-domain comp for one shop. On open it resolves the true
 * entitlement (incl. the per-seller subscription the list skips) to replace the
 * `subscriptionUnchecked` placeholder; grant/revoke POSTs and patches the parent
 * row from the resolved response. HIGH-risk (entitlement) — the live money-path
 * grant is owed to Daniel; this is the UI that drives it.
 */
function EntitlementControls({
  row,
  onResolved,
}: {
  row: TenantRow
  onResolved: (partial: Partial<TenantRow>) => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingRevoke, setConfirmingRevoke] = useState(false)
  // The raw durable grant, resolved on open (null = none, undefined = not yet known).
  const [grant, setGrant] = useState<DomainGrant | null | undefined>(undefined)
  // Which paid SKU's comp we're managing (S6: was custom-domain-only; Sprint 2
  // of shipping-provider-expansion adds 'envia' — a Medusa-seller-backed grant,
  // not a Supabase one, but the same UI/API shape).
  const [sku, setSku] = useState<'custom_domain' | 'subdomain' | 'ml_sync' | 'envia'>('custom_domain')

  // On open (and whenever the SKU changes), resolve the true reason for this one
  // shop + SKU (subscription incl.).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Defer the reset into the async synchronization path. React's effect
      // contract forbids a synchronous state cascade while subscribing to the
      // external entitlement read.
      await Promise.resolve()
      if (cancelled) return
      setError(null)
      setGrant(undefined)
      try {
        const res = await fetch(`/api/admin/tenants/${encodeURIComponent(row.shopId)}?sku=${sku}`)
        if (!res.ok) return
        const data = (await res.json()) as EntitlementResponse
        if (cancelled) return
        setGrant(data.grant)
        onResolved({
          entitlementReason: data.entitlementReason,
          entitled: data.entitled,
          subscriptionUnchecked: false,
        })
      } catch {
        /* leave the list-level reason in place on a failed resolve */
      }
    })()
    return () => {
      cancelled = true
    }
    // Resolve per inspected shop + SKU.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.shopId, sku])

  async function mutate(action: 'grant' | 'revoke') {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/tenants/${encodeURIComponent(row.shopId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'grant' ? { action, note, sku } : { action, sku }),
      })
      const data = (await res.json().catch(() => null)) as (EntitlementResponse & { error?: string }) | null
      if (!res.ok || !data) {
        setError(data?.error ?? 'No se pudo aplicar el cambio.')
        return
      }
      setGrant(data.grant)
      onResolved({
        entitlementReason: data.entitlementReason,
        entitled: data.entitled,
        subscriptionUnchecked: false,
      })
      setNote('')
      setConfirmingRevoke(false)
    } catch {
      setError('Error de red al aplicar el cambio.')
    } finally {
      setBusy(false)
    }
  }

  const hasComp = grant?.type === 'comp'
  const isGrandfather = grant?.type === 'grandfather'

  return (
    <div className="space-y-2">
      <div>
        {/* Honest until the detail GET resolves the per-seller subscription: while
            `subscriptionUnchecked`, never assert a bare "Sin plan". */}
        {row.subscriptionUnchecked
          ? 'Sin plan (suscripción sin verificar)'
          : entitlementReasonLabel(row.entitlementReason)}
        {hasComp && (
          <span className="block text-xs text-[var(--color-muted)] mt-0.5">
            Cortesía activa
            {grant?.granted_at ? ` desde ${new Date(grant.granted_at).toLocaleDateString('es-MX')}` : ''}
            {grant?.note ? ` · ${grant.note}` : ''}
          </span>
        )}
        {isGrandfather && (
          <span className="block text-xs text-[var(--color-muted)] mt-0.5">
            Heredada (cutover) — concesión permanente, no editable desde aquí.
          </span>
        )}
      </div>

      {/* A grandfather grant is a different, permanent entitlement — S4 only manages
          the comp, so expose no edit controls for it (the server refuses too). */}
      {grant === undefined ? (
        <p className="text-xs text-[var(--color-muted)]">Verificando plan…</p>
      ) : isGrandfather ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={sku}
            onChange={(e) => setSku(e.target.value as 'custom_domain' | 'subdomain' | 'ml_sync' | 'envia')}
            disabled={busy}
            aria-label="SKU"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
          >
            <option value="custom_domain">Dominio propio</option>
            <option value="subdomain">Subdominio</option>
            <option value="ml_sync">Sincronización ML</option>
            <option value="envia">Envía (cortesía)</option>
          </select>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Nota (opcional)"
            disabled={busy}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
          />
          <button
            type="button"
            onClick={() => mutate('grant')}
            disabled={busy}
            className="rounded-md bg-[var(--color-fg)] text-[var(--color-bg)] px-3 py-1 text-xs font-medium disabled:opacity-50"
          >
            {hasComp ? 'Actualizar cortesía' : 'Otorgar cortesía'}
          </button>

          {hasComp &&
            (confirmingRevoke ? (
              <span className="flex items-center gap-1 text-xs">
                <span className="text-[var(--color-muted)]">¿Revocar la cortesía?</span>
                <button
                  type="button"
                  onClick={() => mutate('revoke')}
                  disabled={busy}
                  className="rounded-md border border-[var(--color-border)] px-2 py-1 font-medium text-[var(--color-warning,#9a6700)] disabled:opacity-50"
                >
                  Sí, revocar
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingRevoke(false)}
                  disabled={busy}
                  className="rounded-md px-2 py-1 text-[var(--color-muted)] disabled:opacity-50"
                >
                  Cancelar
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingRevoke(true)}
                disabled={busy}
                className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-50"
              >
                Revocar
              </button>
            ))}

          {busy && <span className="text-xs text-[var(--color-muted)]">Guardando…</span>}
        </div>
      )}

      {error && <p className="text-xs text-[var(--color-danger,#b42318)]">{error}</p>}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[var(--color-muted)]">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}

function Badge({
  tone,
  children,
}: {
  // `danger` added for a deleted shop: it is not a warning, and rendering it in the
  // same amber as "en pausa" would blur the one distinction an operator scanning this
  // list most needs to make.
  tone: 'ok' | 'warn' | 'danger' | 'muted'
  children: React.ReactNode
}) {
  const cls =
    tone === 'ok'
      ? 'bg-[var(--color-success-bg,#e7f6ec)] text-[var(--color-success,#1a7f37)]'
      : tone === 'warn'
        ? 'bg-[var(--color-warning-bg,#fff4e5)] text-[var(--color-warning,#9a6700)]'
        : tone === 'danger'
          ? 'bg-[var(--color-danger-bg,#ffebe9)] text-[var(--color-danger,#b3261e)]'
          : 'bg-[var(--color-bg-subtle)] text-[var(--color-muted)]'
  return <span className={`rounded-full px-2 py-0.5 ${cls}`}>{children}</span>
}

/** A labelled select. Small enough to keep local; the filter bar is the only user. */
function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<[string, string]>
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[var(--color-muted)]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </label>
  )
}
