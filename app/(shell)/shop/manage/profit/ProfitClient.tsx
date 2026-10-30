'use client'

import { SellerBreadcrumb } from '../SellerBreadcrumb'
import {
  totalsByCurrency,
  formatPct,
  classifyMarginKillers,
  classifyUnderpriced,
  type OrderMarginRow,
  type SkuMarginRow,
  type PendingPiece,
} from '@/lib/profit'
import PricingCard from './PricingCard'
import { orderSourceLabel, summarizeBySource } from '@/lib/in-person/order-source'
import { useSellerFormat } from '@/app/components/SellerFormatProvider'

/**
 * Profit dashboard v1 (profit-analyzer S1 · US-3) — presentational only; all
 * math lives in the pure `lib/profit.ts` seam the server page already ran.
 * Partial rows render honestly ("envío pendiente" etc.), never as $0-complete.
 * ML-fee column is entitlement-gated (`showMlFees`, ml_sync SKU).
 *
 * Sprint 2 adds: per-SKU target-margin + Apply (`PricingCard`, US-5) and
 * margin-insight call-outs (US-6) below the per-SKU table.
 */

const PENDING_LABEL: Record<PendingPiece, string> = {
  cogs: 'costo pendiente',
  shipping: 'envío pendiente',
  ml_fee: 'comisión ML pendiente',
}

function MarginCell({ cents, pct, currency }: { cents: number; pct: number | null; currency?: string }) {
  const fmt = useSellerFormat()
  const negative = cents < 0
  return (
    <span className={negative ? 'text-red-600 font-semibold' : 'text-green-700 font-semibold'}>
      {fmt.money(cents, currency)}
      <span className="text-xs font-normal text-[var(--color-muted)]"> · {formatPct(pct)}</span>
    </span>
  )
}

export default function ProfitClient({
  orderRows,
  skuRows,
  showMlFees,
  loadFailed,
}: {
  orderRows: OrderMarginRow[]
  skuRows: SkuMarginRow[]
  showMlFees: boolean
  loadFailed: boolean
}) {
  const fmt = useSellerFormat()
  // `lib/profit.ts`'s `formatCents` picks its locale FROM the money (mxn→es-MX,
  // usd→en-US). That was the best available proxy for "the language this seller
  // reads" before the portal had an ES/EN switch; now the seller states it, so the
  // proxy is replaced by the real thing. The currency still comes from the row.
  const formatCents = (cents: number, currency?: string) => fmt.money(cents, currency)
  const fmtDate = (iso: string | null) =>
    iso ? fmt.date(iso, { day: 'numeric', month: 'short' }) : '—'
  const marginKillers = classifyMarginKillers(skuRows)
  const underpriced = classifyUnderpriced(skuRows)
  // Only SKUs with an addressable variant + a positive realized unit price
  // can drive the Apply control (PricingCard itself no-ops otherwise too —
  // this filter just avoids rendering an empty/broken card).
  const pricingRows = skuRows.filter((r) => r.variant_id && r.units > 0 && r.revenue_cents > 0)

  // ONE SET OF TOTALS PER CURRENCY (S4.3 / D16). Summing pesos and dollars produces a
  // number that is not money, and does it silently — the figure still renders and
  // still looks plausible. A Mexico-only seller sees exactly one group, so the page is
  // unchanged for everyone on the platform today.
  const currencyTotals = totalsByCurrency(orderRows)
  // `$` is the symbol for BOTH markets — es-MX renders MXN as `$1,250` and en-US
  // renders USD as `$12.50`. So splitting the aggregation is not enough on its own:
  // two rows would both read `$` and a seller could not tell which market they came
  // from. When more than one currency is present, every row names its own. Found by
  // the Codex pass on frontend PR 360.
  //
  // Derived PER TABLE, from that table's own rows. Deriving both from `orderRows`
  // meant a seller whose SKU rows spanned two currencies while their order rows did
  // not would see two differently-denominated rows for one product with no label —
  // the exact ambiguity this is here to remove. Found by the Antigravity pass on the
  // same PR.
  const manyCurrencies = (rows: ReadonlyArray<{ currency_code: string }>) =>
    new Set(rows.map((r) => r.currency_code)).size > 1
  const showOrderCurrency = manyCurrencies(orderRows)
  const showSkuCurrency = manyCurrencies(skuRows)

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
      <SellerBreadcrumb />

      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-[var(--color-text)]">Ganancias</h1>
        <p className="text-[var(--color-muted)] text-sm mt-1">
          Lo que ganas de verdad en cada venta — ingresos menos comisiones, envío y tu costo,
          congelados al momento de la venta.
        </p>
      </div>

      {loadFailed && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-[var(--r-md)] px-4 py-3 text-sm">
          No se pudieron cargar tus datos de ganancias. Recarga la página para intentarlo de nuevo.
        </div>
      )}

      {/* KPI cards — one row per currency (S4.3 / D16) */}
      {currencyTotals.map((totals) => (
        <div key={totals.currency_code} className="space-y-2">
          {currencyTotals.length > 1 && (
            <p className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wide">
              {totals.currency_code.toUpperCase()}
            </p>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="border border-[var(--color-border)] rounded-[var(--r-md)] p-4">
              <p className="text-xs text-[var(--color-muted)] font-medium">Ingresos</p>
              <p className="text-xl font-bold text-[var(--color-text)] mt-1">{formatCents(totals.revenue, totals.currency_code)}</p>
              <p className="text-xs text-[var(--color-muted)] mt-0.5">{totals.orders} ventas</p>
            </div>
            {showMlFees && (
              <div className="border border-[var(--color-border)] rounded-[var(--r-md)] p-4">
                <p className="text-xs text-[var(--color-muted)] font-medium">Comisiones ML</p>
                <p className="text-xl font-bold text-[var(--color-text)] mt-1">{formatCents(totals.fees, totals.currency_code)}</p>
                <p className="text-xs text-[var(--color-muted)] mt-0.5">cobradas por Mercado Libre</p>
              </div>
            )}
            <div className="border border-[var(--color-border)] rounded-[var(--r-md)] p-4">
              <p className="text-xs text-[var(--color-muted)] font-medium">Costos + envío</p>
              <p className="text-xl font-bold text-[var(--color-text)] mt-1">{formatCents(totals.cogs + totals.shipping, totals.currency_code)}</p>
              <p className="text-xs text-[var(--color-muted)] mt-0.5">tu costo {formatCents(totals.cogs, totals.currency_code)} · envío {formatCents(totals.shipping, totals.currency_code)}</p>
            </div>
            <div className="border border-[var(--color-border)] rounded-[var(--r-md)] p-4">
              <p className="text-xs text-[var(--color-muted)] font-medium">Ganancia</p>
              <p className={`text-xl font-bold mt-1 ${totals.margin < 0 ? 'text-red-600' : 'text-[var(--color-accent)]'}`}>
                {formatCents(totals.margin, totals.currency_code)}
              </p>
              <p className="text-xs text-[var(--color-muted)] mt-0.5">margen {formatPct(totals.margin_pct)}</p>
            </div>
          </div>
        </div>
      ))}

      {/* Split by where the sale came from (in-person-sales S2.3, D17) — only when there is more than one. */}
      {(() => {
        const bySource = summarizeBySource(orderRows)
        if (new Set(bySource.map((b) => b.source)).size < 2) return null
        return (
          <div>
            <h2 className="text-lg font-semibold text-[var(--color-text)] mb-2">Por origen</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {bySource.map((b) => (
                <div key={`${b.source}-${b.currency_code}`} className="border border-[var(--color-border)] rounded-[var(--r-md)] p-4">
                  <p className="text-xs text-[var(--color-muted)] font-medium">{b.label}{showOrderCurrency ? ` · ${b.currency_code.toUpperCase()}` : ''}</p>
                  <p className="text-xl font-bold text-[var(--color-text)] mt-1">{formatCents(b.revenue_cents, b.currency_code)}</p>
                  <p className="text-xs text-[var(--color-muted)] mt-0.5">{b.orders} ventas · ganancia {formatCents(b.margin_cents, b.currency_code)}</p>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Per-order table */}
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text)] mb-2">Por pedido</h2>
        {orderRows.length === 0 ? (
          <div className="border border-dashed border-[var(--color-border)] rounded-[var(--r-md)] px-4 py-8 text-center">
            <p className="text-sm text-[var(--color-muted)]">
              Aún no hay ventas registradas en el libro de ganancias. Registra el costo unitario de
              tus anuncios — cada venta nueva quedará aquí con su margen real.
            </p>
          </div>
        ) : (
          <div className="border border-[var(--color-border)] rounded-[var(--r-md)] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[var(--color-background)] text-left">
                    <th className="px-3 py-2 font-medium text-[var(--color-muted)] text-xs">Pedido</th>
                    {showOrderCurrency && <th className="px-3 py-2 font-medium text-[var(--color-muted)] text-xs">Moneda</th>}
                    <th className="px-3 py-2 font-medium text-[var(--color-muted)] text-xs">Ingreso</th>
                    {showMlFees && <th className="px-3 py-2 font-medium text-[var(--color-muted)] text-xs">Comisión</th>}
                    <th className="px-3 py-2 font-medium text-[var(--color-muted)] text-xs">Envío</th>
                    <th className="px-3 py-2 font-medium text-[var(--color-muted)] text-xs">Costo</th>
                    <th className="px-3 py-2 font-medium text-[var(--color-muted)] text-xs">Ganancia</th>
                  </tr>
                </thead>
                <tbody>
                  {orderRows.map((r) => (
                    <tr key={r.order_id} className="border-t border-[var(--color-border)]">
                      <td className="px-3 py-2">
                        <p className="text-[var(--color-text)] font-medium truncate max-w-[16rem]">
                          {r.display_id != null ? `#${r.display_id} · ` : ''}{r.title}
                        </p>
                        <p className="text-xs text-[var(--color-muted)]">
                          {fmtDate(r.created_at)}
                          {r.source && r.source !== 'native' ? ` · ${orderSourceLabel(r.source)}` : ''}
                        </p>
                        {r.pending.length > 0 && (
                          <p className="text-xs text-amber-700 mt-0.5">
                            {r.pending.map((p) => PENDING_LABEL[p]).join(' · ')}
                          </p>
                        )}
                      </td>
                      {showOrderCurrency && <td className="px-3 py-2 text-[var(--color-muted)] text-xs font-semibold">{r.currency_code.toUpperCase()}</td>}
                      <td className="px-3 py-2 text-[var(--color-text)]">{formatCents(r.revenue_cents, r.currency_code)}</td>
                      {showMlFees && <td className="px-3 py-2 text-[var(--color-text)]">{formatCents(r.fees_cents, r.currency_code)}</td>}
                      <td className="px-3 py-2 text-[var(--color-text)]">{formatCents(r.shipping_cents, r.currency_code)}</td>
                      <td className="px-3 py-2 text-[var(--color-text)]">{formatCents(r.cogs_cents, r.currency_code)}</td>
                      <td className="px-3 py-2"><MarginCell cents={r.margin_cents} pct={r.margin_pct} currency={r.currency_code} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Per-SKU table */}
      {skuRows.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text)] mb-1">Por producto</h2>
          <p className="text-xs text-[var(--color-muted)] mb-2">
            Sin envío (el envío es un costo por pedido, no por producto).
          </p>
          <div className="border border-[var(--color-border)] rounded-[var(--r-md)] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[var(--color-background)] text-left">
                    <th className="px-3 py-2 font-medium text-[var(--color-muted)] text-xs">Producto</th>
                    <th className="px-3 py-2 font-medium text-[var(--color-muted)] text-xs">Unidades</th>
                    {showSkuCurrency && <th className="px-3 py-2 font-medium text-[var(--color-muted)] text-xs">Moneda</th>}
                    <th className="px-3 py-2 font-medium text-[var(--color-muted)] text-xs">Ingreso</th>
                    {showMlFees && <th className="px-3 py-2 font-medium text-[var(--color-muted)] text-xs">Comisión</th>}
                    <th className="px-3 py-2 font-medium text-[var(--color-muted)] text-xs">Costo</th>
                    <th className="px-3 py-2 font-medium text-[var(--color-muted)] text-xs">Ganancia</th>
                  </tr>
                </thead>
                <tbody>
                  {skuRows.map((r) => (
                    // The key includes the currency: one SKU sold in two markets is two
                    // rows now, and a product_id-only key would collide and drop one.
                    <tr key={`${r.product_id}::${r.variant_id ?? ''}::${r.currency_code}`} className="border-t border-[var(--color-border)]">
                      <td className="px-3 py-2 text-[var(--color-text)] font-medium truncate max-w-[16rem]">{r.title}</td>
                      <td className="px-3 py-2 text-[var(--color-text)]">{r.units}</td>
                      {showSkuCurrency && <td className="px-3 py-2 text-[var(--color-muted)] text-xs font-semibold">{r.currency_code.toUpperCase()}</td>}
                      <td className="px-3 py-2 text-[var(--color-text)]">{formatCents(r.revenue_cents, r.currency_code)}</td>
                      {showMlFees && <td className="px-3 py-2 text-[var(--color-text)]">{formatCents(r.fees_cents, r.currency_code)}</td>}
                      <td className="px-3 py-2 text-[var(--color-text)]">{formatCents(r.cogs_cents, r.currency_code)}</td>
                      <td className="px-3 py-2"><MarginCell cents={r.margin_cents} pct={r.margin_pct} currency={r.currency_code} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Margin insights (US-6) — pure ledger classifiers, no live ML call. */}
      {(marginKillers.length > 0 || underpriced.length > 0) && (
        <div className="space-y-3">
          {marginKillers.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-[var(--r-md)] px-4 py-3">
              <p className="text-sm font-semibold text-red-800">Perdiendo margen</p>
              <p className="text-xs text-red-700 mt-0.5">
                {marginKillers.map((r) => r.title).join(' · ')} — el margen real está por debajo del 5%.
                Ajusta el precio abajo.
              </p>
            </div>
          )}
          {underpriced.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-[var(--r-md)] px-4 py-3">
              <p className="text-sm font-semibold text-amber-800">Con espacio para subir precio</p>
              <p className="text-xs text-amber-700 mt-0.5">
                {underpriced.map((r) => r.title).join(' · ')} — ya tienen buen margen y podrían venderse
                más caros. Ajusta el precio abajo.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Target-margin + one-click Apply (US-5) — one card per addressable SKU. */}
      {pricingRows.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text)] mb-2">Ajusta tus precios</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {pricingRows.map((r) => (
              <PricingCard key={r.variant_id ?? r.product_id} row={r} />
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-[var(--color-muted)]">
        Los montos se congelan al momento de cada venta: cambiar tu costo unitario después no
        reescribe el historial. Las piezas pendientes (envío, comisión) se completan solas cuando
        llegan — por ejemplo, al comprar la guía de envío.
      </p>
    </div>
  )
}
