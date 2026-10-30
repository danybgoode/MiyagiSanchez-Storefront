'use client'

/**
 * «Vender en persona» — the counter (in-person-sales S1.3). Phone first.
 *
 * THE EXACTLY-ONCE CONTRACT (D4) lives in `submitSale`:
 *  - `client_id` is minted with `crypto.randomUUID()` the FIRST time «Listo» is pressed for
 *    a sale, and the whole payload (id + lines + tendered) is frozen in `pendingRef`.
 *  - A retry re-sends that frozen payload verbatim, so a lost response, a flaky signal or a
 *    double tap is a server-side REPLAY of the same sale, never a second order.
 *  - Whether an id may be RELEASED is decided by `classifySaleResponse` (lib/in-person/sale-response.ts),
 *    by an allow-list of backend codes, never by HTTP status, with a sticky rule once any attempt
 *    was uncertain. The frozen sale is mirrored in sessionStorage so a reload keeps the same id.
 *  - After an UNCERTAIN failure (no connection, a 5xx, a claim still in progress) the sale
 *    stays frozen and the cart is locked — editing it would change the payload under the
 *    same id (`CLIENT_ID_REUSED`) or, worse, record a second sale while the first may exist.
 *  - After a DEFINITIVE refusal (validation, stock, ownership) nothing was recorded, so the
 *    frozen payload is dropped and the merchant fixes the cart; the next «Listo» is a new
 *    sale with a new id.
 *  - «Listo» is disabled while a request is in flight.
 *
 * Money is integer centavos end to end (`lib/in-person/counter-cart.ts`). Cards and
 * transfers arrive in Sprint 2, so those buttons are visible and disabled.
 */

import Image from 'next/image'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useSellerFormat } from '@/app/components/SellerFormatProvider'
import {
  addItem,
  applyPadKey,
  cartTotalCents,
  cartUnits,
  cashResult,
  centsToPadText,
  clearCart,
  decrementLine,
  emptyCart,
  incrementLine,
  lineTotalCents,
  padTextToCents,
  removeLine,
  toSaleLines,
  type CounterCart,
  type PadKey,
  type SaleLine,
} from '@/lib/in-person/counter-cart'
import { classifySaleResponse } from '@/lib/in-person/sale-response'
import { isSellable, matchesQuery, type CounterProduct, type CounterVariant } from '@/lib/in-person/counter-catalog'

type Stage = 'shop' | 'cash' | 'done'

interface FrozenSale {
  clientId: string
  lines: SaleLine[]
  tenderedCents: number | null
  /** Some attempt of THIS sale was uncertain, so the order may already exist (sticky rule). */
  uncertain: boolean
}

interface SaleDone {
  totalCents: number
  changeCents: number
  replayed: boolean
}

type SaleOutcome =
  | { kind: 'ok'; done: SaleDone }
  | { kind: 'refused'; message: string; serverTotalCents: number | null }
  | { kind: 'uncertain'; message: string }

const PAD_KEYS: PadKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del']
const QUICK_BILLS = [50, 100, 200, 500, 1000]
const IN_PROGRESS_RETRIES = 3
const IN_PROGRESS_WAIT_MS = 2000
const REQUEST_TIMEOUT_MS = 30_000
const STORAGE_KEY = 'ms.en-persona.frozen-sale'
const RETRY_HINT = 'Toca «Reintentar»: no se cobra doble.'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * POST the frozen sale and classify the answer. All the "may the id be released" logic is in
 * `classifySaleResponse`; this is only transport. `sale.uncertain` is updated in place so the
 * caller can persist it.
 */
async function postSale(sale: FrozenSale): Promise<SaleOutcome> {
  const body = JSON.stringify({
    client_id: sale.clientId,
    kind: 'cash',
    lines: sale.lines,
    tendered_cents: sale.tenderedCents,
  })
  for (let attempt = 0; attempt <= IN_PROGRESS_RETRIES; attempt += 1) {
    let res: Response
    try {
      res = await fetch('/api/shop/en-persona/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      sale.uncertain = true
      return { kind: 'uncertain', message: `Sin conexión. ${RETRY_HINT}` }
    }
    const json = (await res.json().catch(() => null)) as {
      order_id?: string
      total_cents?: number
      change_cents?: number
      replayed?: boolean
      code?: string
      message?: string
      details?: { total_cents?: number } | null
    } | null

    const hasOrder = !!json?.order_id && Number.isSafeInteger(json.total_cents)
    const verdict = classifySaleResponse({ status: res.status, code: json?.code, hasOrder, hadUncertainAttempt: sale.uncertain })
    if (verdict === 'recorded') {
      return { kind: 'ok', done: { totalCents: json!.total_cents as number, changeCents: json!.change_cents ?? 0, replayed: json!.replayed === true } }
    }
    if (verdict === 'retry_in_progress') {
      // A claim exists, so from here on the order may exist.
      sale.uncertain = true
      if (attempt < IN_PROGRESS_RETRIES) {
        await sleep(IN_PROGRESS_WAIT_MS)
        continue
      }
      return { kind: 'uncertain', message: `La venta sigue en proceso. ${RETRY_HINT}` }
    }
    const message = json?.message ?? 'No pudimos registrar la venta.'
    if (verdict === 'refused') {
      const total = json?.details?.total_cents
      return { kind: 'refused', message, serverTotalCents: Number.isSafeInteger(total) ? (total as number) : null }
    }
    sale.uncertain = true
    return { kind: 'uncertain', message: `${message} ${RETRY_HINT}` }
  }
  sale.uncertain = true
  return { kind: 'uncertain', message: `La venta sigue en proceso. ${RETRY_HINT}` }
}

function readStored(): { sale: FrozenSale; cart: CounterCart; padText: string } | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (typeof v?.sale?.clientId !== 'string' || !Array.isArray(v.sale.lines) || !Array.isArray(v.cart?.lines) || typeof v.padText !== 'string') return null
    return v
  } catch {
    return null
  }
}
function writeStored(value: { sale: FrozenSale; cart: CounterCart; padText: string } | null) {
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    else window.sessionStorage.removeItem(STORAGE_KEY)
  } catch { /* private window / blocked storage: the in-memory freeze still holds */ }
}

function stockLabel(variants: CounterVariant[]): string {
  if (variants.some((v) => v.available === null)) return 'Sin límite'
  const units = variants.reduce((sum, v) => sum + (v.available ?? 0), 0)
  return units > 0 ? `Quedan ${units}` : 'Agotado'
}

export default function CounterClient({ products: initialProducts, truncated }: { products: CounterProduct[]; truncated: boolean }) {
  const fmt = useSellerFormat()
  const money = (cents: number) => fmt.money(cents, 'MXN')

  const [products, setProducts] = useState(initialProducts)
  const [query, setQuery] = useState('')
  const [cart, setCart] = useState<CounterCart>(emptyCart)
  const [stage, setStage] = useState<Stage>('shop')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [picking, setPicking] = useState<CounterProduct | null>(null)
  const [padText, setPadText] = useState('')
  const [inFlight, setInFlight] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<SaleDone | null>(null)
  const pendingRef = useRef<FrozenSale | null>(null)

  // A reload after an uncertain outcome restores the SAME frozen sale (id + payload), so the
  // merchant retries it instead of re-ringing the cart under a new id.
  useEffect(() => {
    let cancelled = false
    // Deferred a tick: sessionStorage is only readable after mount (SSR has none), and the
    // restore is a one-shot sync from that external store.
    queueMicrotask(() => {
      const stored = readStored()
      if (!stored || cancelled) return
      pendingRef.current = stored.sale
      setCart(stored.cart)
      setPadText(stored.padText)
      setUncertain(true)
      setStage('cash')
      setSheetOpen(true)
      setError(`Quedó una venta sin confirmar. ${RETRY_HINT}`)
    })
    return () => { cancelled = true }
  }, [])

  const total = cartTotalCents(cart)
  const units = cartUnits(cart)
  const locked = uncertain || inFlight || stage === 'done'
  const tendered = padTextToCents(padText)
  const cash = tendered === null ? null : cashResult(total, tendered)
  // Blank pad = the exact total (the backend treats an absent tender as "no change owed").
  const canSubmit = !inFlight && cart.lines.length > 0 && (tendered === null || (cash?.short_cents ?? 0) === 0)

  const visible = useMemo(() => products.filter((p) => matchesQuery(p.title, query)), [products, query])

  function addVariant(product: CounterProduct, variant: CounterVariant) {
    if (locked || !isSellable(variant)) return
    setError(null)
    setCart((current) =>
      addItem(current, {
        variantId: variant.variantId,
        productId: product.productId,
        title: product.title,
        variantTitle: variant.title,
        unitCents: variant.unitCents,
        imageUrl: product.imageUrl,
        maxQuantity: variant.available,
      }),
    )
    setPicking(null)
  }

  function tapProduct(product: CounterProduct) {
    if (locked) return
    const sellable = product.variants.filter(isSellable)
    if (sellable.length === 0) return
    if (product.variants.length === 1) addVariant(product, sellable[0])
    else setPicking(product)
  }

  function resetSale() {
    pendingRef.current = null
    writeStored(null)
    setCart(clearCart())
    setPadText('')
    setUncertain(false)
    setError(null)
    setDone(null)
    setStage('shop')
    setSheetOpen(false)
  }

  async function submitSale() {
    if (!canSubmit) return
    // First press mints the id and freezes the payload; every retry re-sends that exact payload.
    if (!pendingRef.current) {
      pendingRef.current = { clientId: crypto.randomUUID(), lines: toSaleLines(cart), tenderedCents: tendered, uncertain: false }
    }
    const sale = pendingRef.current
    // Persist BEFORE sending, marked uncertain: if the page reloads while this request is
    // in flight, the server may have recorded the sale, so the reloaded counter must
    // resume THIS id, never re-ring the cart under a new one (codex re-review, PR 458).
    writeStored({ sale: { ...sale, uncertain: true }, cart, padText })
    setInFlight(true)
    setError(null)
    const outcome = await postSale(sale)
    setInFlight(false)

    if (outcome.kind === 'ok') {
      pendingRef.current = null
      writeStored(null)
      setUncertain(false)
      setDone(outcome.done)
      setStage('done')
      // Show the stock the sale just used without a reload; the server stays the source of truth.
      const sold = new Map(sale.lines.map((l) => [l.variant_id, l.quantity]))
      setProducts((current) =>
        current.map((p) => ({
          ...p,
          variants: p.variants.map((v) =>
            v.available !== null && sold.has(v.variantId) ? { ...v, available: Math.max(0, v.available - (sold.get(v.variantId) ?? 0)) } : v,
          ),
        })),
      )
      return
    }
    if (outcome.kind === 'refused') {
      // Nothing was recorded: drop the frozen sale so the merchant can fix the cart.
      pendingRef.current = null
      writeStored(null)
      setUncertain(false)
      setStage('shop')
      setError(outcome.serverTotalCents !== null ? `${outcome.message} El total es ${money(outcome.serverTotalCents)}.` : outcome.message)
      return
    }
    writeStored({ sale, cart, padText })
    setUncertain(true)
    setError(outcome.message)
  }

  function abandonUncertainSale() {
    if (!window.confirm('Si la venta ya se registró, aparecerá en Pedidos. ¿Empezar otra venta?')) return
    resetSale()
  }

  return (
    <div>
      <div className="relative">
        <i className="iconoir-search absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)]" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar producto"
          aria-label="Buscar producto"
          className="w-full min-h-[48px] pl-10 pr-3 rounded-[var(--r-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-base"
        />
      </div>
      {truncated && (
        <p className="text-xs text-[var(--color-muted)] mt-2">Mostramos hasta 200 productos de cada tipo. La búsqueda solo filtra los que ya cargaron; si no ves uno, ajusta su estado en Catálogo.</p>
      )}

      {products.length === 0 ? (
        <Card className="mt-4 p-6 text-center">
          <p className="font-medium">Aún no tienes productos activos para vender.</p>
          <p className="text-sm text-[var(--color-muted)] mt-1">Publica un producto con precio en pesos y aparecerá aquí.</p>
        </Card>
      ) : visible.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)] mt-4">No encontramos productos con ese nombre.</p>
      ) : (
        <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mt-4 list-none p-0">
          {visible.map((product) => {
            const sellable = product.variants.some(isSellable)
            const prices = product.variants.map((v) => v.unitCents)
            const from = Math.min(...prices)
            const label = stockLabel(product.variants)
            return (
              <li key={product.productId}>
                <button
                  type="button"
                  onClick={() => tapProduct(product)}
                  disabled={!sellable || locked}
                  className="card-tile w-full text-left p-0 overflow-hidden disabled:opacity-50 min-h-[44px]"
                >
                  <div className="aspect-square bg-[var(--color-surface-alt)] flex items-center justify-center overflow-hidden">
                    {product.imageUrl ? (
                      <Image src={product.imageUrl} alt="" width={240} height={240} className="w-full h-full object-cover" />
                    ) : (
                      <i className="iconoir-package text-3xl text-[var(--color-muted)]" aria-hidden />
                    )}
                  </div>
                  <div className="p-2">
                    <div className="font-medium text-sm leading-snug line-clamp-2">{product.title}</div>
                    <div className="text-sm mt-1">
                      {prices.some((p) => p !== from) ? 'Desde ' : ''}
                      {money(from)}
                    </div>
                    <div className={`text-xs mt-0.5 ${sellable ? 'text-[var(--color-muted)]' : 'text-[var(--color-danger)]'}`}>{label}</div>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {picking && (
        <Sheet label={`Elige una opción de ${picking.title}`} onClose={() => setPicking(null)}>
          <h2 className="text-lg font-bold mb-3">{picking.title}</h2>
          <ul className="list-none p-0 m-0 flex flex-col gap-2">
            {picking.variants.map((variant) => (
              <li key={variant.variantId}>
                <button
                  type="button"
                  onClick={() => addVariant(picking, variant)}
                  disabled={!isSellable(variant)}
                  className="card-tile w-full flex items-center justify-between gap-3 p-3 min-h-[56px] text-left disabled:opacity-50"
                >
                  <span>
                    <span className="block font-medium">{variant.title ?? picking.title}</span>
                    <span className="block text-xs text-[var(--color-muted)]">
                      {variant.available === null ? 'Sin límite' : variant.available > 0 ? `Quedan ${variant.available}` : 'Agotado'}
                    </span>
                  </span>
                  <span className="font-semibold">{money(variant.unitCents)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}

      {cart.lines.length > 0 && !sheetOpen && stage !== 'done' && (
        <div className="fixed left-0 right-0 bottom-20 md:bottom-4 z-40 px-4 flex justify-center pointer-events-none">
          <Button variant="primary" size="lg" className="pointer-events-auto w-full max-w-md min-h-[52px] justify-between" onClick={() => setSheetOpen(true)}>
            <span>
              <i className="iconoir-shopping-bag" aria-hidden /> <span>Ver venta</span> <span>{units}</span>
            </span>
            <span>{money(total)}</span>
          </Button>
        </div>
      )}

      {(sheetOpen || stage === 'done') && (
        <Sheet label="Venta" onClose={locked ? undefined : () => setSheetOpen(false)}>
          {stage === 'done' && done ? (
            <div className="text-center py-4">
              <i className="iconoir-check-circle text-5xl text-[var(--color-success)]" aria-hidden />
              <h2 className="text-xl font-bold mt-2">Venta registrada</h2>
              <p className="text-[var(--color-muted)] mt-1">Total {money(done.totalCents)}</p>
              {done.changeCents > 0 && (
                <p className="text-3xl font-bold mt-4">Cambio {money(done.changeCents)}</p>
              )}
              {done.replayed && <p className="text-sm text-[var(--color-muted)] mt-3">Esta venta ya estaba registrada; no se duplicó.</p>}
              <Button variant="primary" size="lg" className="w-full mt-6 min-h-[52px]" onClick={resetSale}>
                Nueva venta
              </Button>
            </div>
          ) : stage === 'cash' ? (
            <div>
              <h2 className="text-lg font-bold">¿Con cuánto te pagan?</h2>
              <p className="text-sm text-[var(--color-muted)]">Total {money(total)}</p>
              <div
                className="mt-3 rounded-[var(--r-md)] border border-[var(--color-border)] bg-[var(--color-surface-alt)] p-3 text-right text-3xl font-bold min-h-[64px]"
                aria-live="polite"
              >
                {padText === '' ? <span className="text-[var(--color-muted)]">{money(total)}</span> : `$${padText}`}
              </div>
              <p className="min-h-[28px] mt-2 text-lg font-semibold" aria-live="polite">
                {cash === null ? (
                  <span className="text-[var(--color-muted)]">Sin monto: se registra el total exacto.</span>
                ) : cash.short_cents > 0 ? (
                  <span className="text-[var(--color-danger)]">Falta {money(cash.short_cents)}</span>
                ) : (
                  <span className="text-[var(--color-success)]">Cambio {money(cash.change_cents)}</span>
                )}
              </p>

              <div className="flex flex-wrap gap-2 mt-3">
                <Button variant="secondary" className="min-h-[44px]" disabled={locked} onClick={() => setPadText(centsToPadText(total))}>
                  Exacto
                </Button>
                {QUICK_BILLS.map((bill) => (
                  <Button key={bill} variant="secondary" className="min-h-[44px]" disabled={locked} onClick={() => setPadText(String(bill))}>
                    {money(bill * 100)}
                  </Button>
                ))}
              </div>

              <div className="grid grid-cols-3 gap-2 mt-3">
                {PAD_KEYS.map((key) => (
                  <Button
                    key={key}
                    variant="secondary"
                    className="min-h-[56px] text-xl"
                    disabled={locked}
                    onClick={() => setPadText((text) => applyPadKey(text, key))}
                    aria-label={key === 'del' ? 'Borrar' : undefined}
                  >
                    {key === 'del' ? <i className="iconoir-nav-arrow-left" aria-hidden /> : key}
                  </Button>
                ))}
              </div>

              {error && <p role="alert" className="text-sm text-[var(--color-danger)] mt-3">{error}</p>}

              <Button variant="primary" size="lg" className="w-full mt-4 min-h-[52px]" loading={inFlight} disabled={!canSubmit} onClick={submitSale}>
                {uncertain ? 'Reintentar' : 'Listo'}
              </Button>
              {uncertain ? (
                <Button variant="ghost" className="w-full mt-2 min-h-[44px]" disabled={inFlight} onClick={abandonUncertainSale}>
                  Empezar otra venta sin reintentar
                </Button>
              ) : (
                <Button variant="ghost" className="w-full mt-2 min-h-[44px]" disabled={inFlight} onClick={() => setStage('shop')}>
                  Regresar
                </Button>
              )}
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-lg font-bold">Venta</h2>
                <Button variant="ghost" size="sm" className="min-h-[44px]" disabled={locked} onClick={() => { setCart(clearCart()); setSheetOpen(false) }}>
                  <i className="iconoir-trash" aria-hidden /> Vaciar
                </Button>
              </div>

              {cart.lines.length === 0 ? (
                <p className="text-sm text-[var(--color-muted)] py-4">Toca un producto para agregarlo.</p>
              ) : (
                <ul className="list-none p-0 m-0 flex flex-col divide-y divide-[var(--color-border)]">
                  {cart.lines.map((line) => (
                    <li key={line.variantId} className="py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{line.title}</div>
                        {line.variantTitle && <div className="text-xs text-[var(--color-muted)] truncate">{line.variantTitle}</div>}
                        <div className="text-sm text-[var(--color-muted)]">{money(line.unitCents)} c/u</div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button variant="secondary" className="min-h-[44px] min-w-[44px]" disabled={locked} aria-label={`Quitar uno de ${line.title}`} onClick={() => setCart((c) => decrementLine(c, line.variantId))}>
                          <i className="iconoir-minus" aria-hidden />
                        </Button>
                        <span className="w-8 text-center font-semibold" aria-live="polite">{line.quantity}</span>
                        <Button variant="secondary" className="min-h-[44px] min-w-[44px]" disabled={locked || (line.maxQuantity !== null && line.quantity >= line.maxQuantity)} aria-label={`Agregar uno de ${line.title}`} onClick={() => setCart((c) => incrementLine(c, line.variantId))}>
                          <i className="iconoir-plus" aria-hidden />
                        </Button>
                      </div>
                      <div className="w-20 text-right font-semibold">{money(lineTotalCents(line))}</div>
                      <Button variant="ghost" className="min-h-[44px] min-w-[44px]" disabled={locked} aria-label={`Quitar ${line.title}`} onClick={() => setCart((c) => removeLine(c, line.variantId))}>
                        <i className="iconoir-xmark" aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex items-baseline justify-between mt-3 pt-3 border-t border-[var(--color-border)]">
                <span className="text-lg">Total</span>
                <span className="text-3xl font-bold">{money(total)}</span>
              </div>

              {error && <p role="alert" className="text-sm text-[var(--color-danger)] mt-3">{error}</p>}

              <div className="flex flex-col gap-2 mt-4">
                <Button variant="primary" size="lg" className="w-full min-h-[52px]" disabled={cart.lines.length === 0 || locked} onClick={() => { setPadText(''); setStage('cash') }}>
                  <i className="iconoir-cash" aria-hidden /> Efectivo
                </Button>
                <Button variant="secondary" size="lg" className="w-full min-h-[52px] justify-between" disabled>
                  <span><i className="iconoir-credit-card" aria-hidden /> Tarjeta o Mercado Pago</span>
                  <span className="text-xs">Próximamente</span>
                </Button>
                <Button variant="secondary" size="lg" className="w-full min-h-[52px] justify-between" disabled>
                  <span><i className="iconoir-bank" aria-hidden /> Transferencia</span>
                  <span className="text-xs">Próximamente</span>
                </Button>
              </div>
            </div>
          )}
        </Sheet>
      )}
    </div>
  )
}

/** A bottom sheet on a phone, a centred panel on a desktop. No focus trap library: `aria-modal` + a visible close. */
function Sheet({ label, onClose, children }: { label: string; onClose?: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label={label}>
      <div className="card-panel w-full md:max-w-lg max-h-[92dvh] overflow-y-auto overscroll-contain p-4 rounded-b-none md:rounded-b-[var(--r-lg)]">
        {onClose && (
          <div className="flex justify-end -mb-2">
            <Button variant="ghost" className="min-h-[44px] min-w-[44px]" aria-label="Cerrar" onClick={onClose}>
              <i className="iconoir-xmark" aria-hidden />
            </Button>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
