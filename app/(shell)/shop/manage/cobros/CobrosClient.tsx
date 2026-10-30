'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { useSellerFormat } from '@/app/components/SellerFormatProvider'
import { isSellable, matchesQuery, type CounterProduct } from '@/lib/in-person/counter-catalog'
import { MAX_QUANTITY } from '@/lib/in-person/counter-cart'
import {
  buildLinkBody, extraPayments, isLinkCancellable, linkBadge, linkShortUrl, linkTitle, linkUrl, linkWhatsAppUrl,
  LINK_DEFAULT_DAYS, LINK_MAX_DAYS, type LinkView,
} from '@/lib/in-person/payment-link'

/** The result of creating a link: URL, short URL, WhatsApp and a QR drawn in the browser. */
function LinkResult({ link, shopName, what }: { link: LinkView; shopName: string; what: string }) {
  const url = linkUrl(link.token)
  const short = linkShortUrl(link.token)
  const wa = linkWhatsAppUrl(link.token, shopName, what)
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!short) return
    let cancelled = false
    import('qrcode').then((m) => m.toDataURL(short, { margin: 1, width: 360, errorCorrectionLevel: 'M' })).then((u) => { if (!cancelled) setQr(u) }).catch(() => {})
    return () => { cancelled = true }
  }, [short])
  async function copy() {
    try { await navigator.clipboard.writeText(short ?? url ?? ''); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* the link is on screen */ }
  }
  if (!url || !short) return null
  return (
    <Card variant="panel" className="p-4 mt-4">
      <h2 className="text-lg font-bold">Tu link está listo</h2>
      <p className="mt-2 break-all font-medium">{short}</p>
      <p className="text-xs text-[var(--color-muted)] break-all">{url}</p>
      <div className="flex flex-wrap gap-2 mt-3">
        <Button variant="secondary" className="min-h-[44px]" onClick={copy}><i className="iconoir-copy" aria-hidden /> {copied ? 'Copiado' : 'Copiar link'}</Button>
        {wa && <a className="btn btn-primary min-h-[44px]" href={wa} target="_blank" rel="noopener noreferrer">Compartir por WhatsApp</a>}
      </div>
      {qr && (
        // A data URL drawn in the browser: next/image has nothing to optimise.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} alt="Código QR del link de cobro" width={180} height={180} className="mt-4 bg-white rounded-[var(--r-md)]" />
      )}
    </Card>
  )
}

export default function CobrosClient({ products, shopName }: { products: CounterProduct[]; shopName: string }) {
  const fmt = useSellerFormat()
  const money = (cents: number) => fmt.money(cents, 'MXN')

  const [mode, setMode] = useState<'products' | 'amount'>('products')
  const [picked, setPicked] = useState<Record<string, number>>({})
  const [query, setQuery] = useState('')
  const [uses, setUses] = useState<'single' | 'multi'>('single')
  const [days, setDays] = useState(LINK_DEFAULT_DAYS)
  const [concept, setConcept] = useState('')
  const [amountText, setAmountText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ link: LinkView; what: string } | null>(null)
  const [links, setLinks] = useState<LinkView[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)

  const variants = useMemo(() => products.flatMap((p) => p.variants.map((v) => ({ p, v }))), [products])
  const visible = useMemo(() => variants.filter(({ p }) => matchesQuery(p.title, query)), [variants, query])
  const lines = Object.entries(picked).filter(([, q]) => q > 0).map(([variant_id, quantity]) => ({ variant_id, quantity }))

  const loadLinks = useCallback(async () => {
    try {
      const res = await fetch('/api/shop/cobros/links', { signal: AbortSignal.timeout(20_000) })
      const json = (await res.json().catch(() => null)) as { payment_links?: LinkView[]; message?: string } | null
      if (res.ok && json?.payment_links) { setLinks(json.payment_links); setListError(null) } else setListError(json?.message ?? 'No pudimos cargar tus links.')
    } catch { setListError('Sin conexión. No pudimos cargar tus links.') }
  }, [])
  useEffect(() => { queueMicrotask(() => { void loadLinks() }) }, [loadLinks])

  function setQty(variantId: string, qty: number) {
    setPicked((cur) => ({ ...cur, [variantId]: Math.max(0, Math.min(MAX_QUANTITY, qty)) }))
  }

  async function create() {
    if (busy) return
    const built = buildLinkBody({ mode, lines, uses: mode === 'amount' ? 'single' : uses, days, concept, amountText })
    if (!built.ok) { setError(built.message); return }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/shop/cobros/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(built.body), signal: AbortSignal.timeout(30_000) })
      const json = (await res.json().catch(() => null)) as { payment_link?: LinkView; message?: string } | null
      if (res.ok && json?.payment_link) {
        setCreated({ link: json.payment_link, what: mode === 'amount' ? concept.trim() : 'tu pedido' })
        setPicked({}); setConcept(''); setAmountText('')
        void loadLinks()
      } else setError(json?.message ?? 'No pudimos crear el link.')
    } catch { setError('Sin conexión. Inténtalo de nuevo.') } finally { setBusy(false) }
  }

  async function cancel(link: LinkView) {
    if (!window.confirm('Quien abra este link ya no podrá pagar. ¿Cancelarlo?')) return
    try {
      const res = await fetch(`/api/shop/cobros/links/${link.id}/cancel`, { method: 'POST', signal: AbortSignal.timeout(20_000) })
      const json = (await res.json().catch(() => null)) as { message?: string } | null
      if (!res.ok) setListError(json?.message ?? 'No pudimos cancelar el link.')
      await loadLinks()
    } catch { setListError('Sin conexión. No pudimos cancelar el link.') }
  }

  return (
    <div>
      <div className="flex gap-1 border border-[var(--color-border)] rounded-[var(--r-lg)] p-1 w-fit" role="group" aria-label="Tipo de cobro">
        {(['products', 'amount'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); setError(null) }}
            className={`px-4 min-h-[44px] rounded-[var(--r-md)] text-sm font-medium ${mode === m ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-muted)]'}`}>
            {m === 'products' ? 'Productos' : 'Cobro libre'}
          </button>
        ))}
      </div>

      {mode === 'products' ? (
        <div className="mt-4">
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar producto" aria-label="Buscar producto"
            className="w-full min-h-[48px] px-3 rounded-[var(--r-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-base" />
          {products.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)] mt-3">Aún no tienes productos activos con precio en pesos.</p>
          ) : (
            <ul className="list-none p-0 mt-3 flex flex-col divide-y divide-[var(--color-border)]">
              {visible.map(({ p, v }) => {
                const qty = picked[v.variantId] ?? 0
                return (
                  <li key={v.variantId} className="py-2 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{p.title}{v.title ? ` · ${v.title}` : ''}</div>
                      <div className="text-sm text-[var(--color-muted)]">{money(v.unitCents)}</div>
                    </div>
                    <Button variant="secondary" className="min-h-[44px] min-w-[44px]" aria-label={`Quitar uno de ${p.title}`} disabled={qty === 0} onClick={() => setQty(v.variantId, qty - 1)}><i className="iconoir-minus" aria-hidden /></Button>
                    <span className="w-8 text-center font-semibold">{qty}</span>
                    <Button variant="secondary" className="min-h-[44px] min-w-[44px]" aria-label={`Agregar uno de ${p.title}`} disabled={!isSellable(v) || (v.available !== null && qty >= v.available)} onClick={() => setQty(v.variantId, qty + 1)}><i className="iconoir-plus" aria-hidden /></Button>
                  </li>
                )
              })}
            </ul>
          )}
          <div className="flex gap-2 mt-4" role="group" aria-label="Cuántos pagos">
            {(['single', 'multi'] as const).map((u) => (
              <button key={u} type="button" aria-pressed={uses === u} onClick={() => setUses(u)}
                className={`px-3 min-h-[44px] rounded-[var(--r-pill)] text-sm font-medium border ${uses === u ? 'bg-[var(--color-accent)] text-white border-transparent' : 'border-[var(--color-border)] text-[var(--color-muted)]'}`}>
                {u === 'single' ? 'Un solo pago' : 'Varios pagos'}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          <label className="text-sm font-medium">Concepto
            <input value={concept} onChange={(e) => setConcept(e.target.value)} maxLength={80} placeholder="Anticipo de pedido"
              className="mt-1 w-full min-h-[48px] px-3 rounded-[var(--r-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-base" />
          </label>
          <label className="text-sm font-medium">Monto
            <input value={amountText} onChange={(e) => setAmountText(e.target.value)} inputMode="decimal" placeholder="500"
              className="mt-1 w-full min-h-[48px] px-3 rounded-[var(--r-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-base" />
          </label>
          <p className="text-xs text-[var(--color-muted)]">De $10 a $50,000. Un cobro libre es de un solo pago.</p>
        </div>
      )}

      <label className="block mt-4 text-sm font-medium">Vence en
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="ml-2 min-h-[44px] px-2 rounded-[var(--r-md)] border border-[var(--color-border)] bg-[var(--color-surface)]">
          {Array.from({ length: LINK_MAX_DAYS }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d} {d === 1 ? 'día' : 'días'}</option>)}
        </select>
      </label>

      {error && <p role="alert" className="text-sm text-[var(--color-danger)] mt-3">{error}</p>}
      <Button variant="primary" size="lg" className="w-full mt-4 min-h-[52px]" loading={busy} onClick={create}>Crear link</Button>

      {created && <LinkResult link={created.link} shopName={shopName} what={created.what} />}

      <h2 className="text-lg font-bold mt-8 mb-2">Tus links</h2>
      {listError && <p role="alert" className="text-sm text-[var(--color-danger)]">{listError}</p>}
      {links === null && !listError && <p className="text-sm text-[var(--color-muted)]">Cargando…</p>}
      {links !== null && links.length === 0 && <p className="text-sm text-[var(--color-muted)]">Todavía no has creado links.</p>}
      <ul className="list-none p-0 flex flex-col gap-2">
        {(links ?? []).map((l) => {
          const extra = extraPayments(l)
          return (
            <li key={l.id}>
              <Card className="p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{linkTitle(l)}{l.amount_cents != null ? ` · ${money(l.amount_cents)}` : ''}</div>
                  <div className="text-xs text-[var(--color-muted)]">{l.uses === 'multi' ? 'Varios pagos' : 'Un solo pago'} · vence {fmt.date(l.expires_at, { day: 'numeric', month: 'short' })}{l.paid_order_ids.length > 0 ? ` · ${l.paid_order_ids.length} pagos` : ''}</div>
                  {extra > 0 && <div className="text-xs text-[var(--color-warning)]">Se pagó más de una vez: revisa tus pedidos.</div>}
                </div>
                <StatusBadge token={linkBadge(l).token}>{linkBadge(l).label}</StatusBadge>
                {isLinkCancellable(l.state) && <Button variant="ghost" size="sm" className="min-h-[44px]" onClick={() => cancel(l)}>Cancelar</Button>}
              </Card>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
