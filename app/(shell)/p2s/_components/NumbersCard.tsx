'use client'

import type { ExampleRow } from '@/lib/prompt-to-shop/blocks'
import type { NumbersBlock } from '@/lib/prompt-to-shop/numbers'
import { useBuilderCopy, useP2sLocale } from './P2sLocale'

/**
 * «Tus números» on the owner's canvas (business-infrastructure S2.2). The draft's ESTIMATES, read-only, each marked
 * «estimado»: the canvas is anonymous (a device cookie), so the numbers are edited after the keep, on the signed-in
 * plan page — one write path, behind real auth (epic README, deviation recorded at S2).
 *
 * Owner-only: the shared preview never reads the `numbers` column (`read.ts` SHARED_COLUMNS), so a link someone was
 * sent cannot show the merchant's costs.
 */
const money = (n: number, locale: string) => `$${Math.round(n).toLocaleString(locale === 'en' ? 'en-US' : 'es-MX')}`

export default function NumbersCard({ numbers, catalog }: { numbers: NumbersBlock | null | undefined; catalog: ExampleRow[] | null }) {
  const { NUMBERS: NUMBERS_COPY } = useBuilderCopy()
  const locale = useP2sLocale()
  const pesos = (n: number) => money(n, locale)
  if (numbers === undefined) return null
  const empty = !numbers || numbers.offers.length === 0
  return (
    <section className="card-panel grid gap-2" style={{ padding: 'var(--s-4)' }} data-testid="p2s-numbers" aria-labelledby="p2s-numbers-title">
      <div className="grid gap-0.5">
        <h2 id="p2s-numbers-title" className="t-h4" style={{ margin: 0, letterSpacing: 0 }}>{NUMBERS_COPY.title}</h2>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{NUMBERS_COPY.privateNote}</p>
      </div>
      {empty ? (
        <p className="t-small" style={{ margin: 0 }} data-testid="p2s-numbers-empty">{NUMBERS_COPY.missing}</p>
      ) : (
        <>
          <ul className="grid gap-1" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {numbers.offers.map((o) => {
              const price = catalog?.find((r) => r.title === o.title)?.price ?? null
              return (
                <li key={o.title} className="t-small" data-testid="p2s-numbers-offer">
                  <strong>{o.title}</strong>
                  {': '}
                  {NUMBERS_COPY.offerLine(pesos(o.unit_cost), price != null ? pesos(price) : null, price != null ? pesos(price - o.unit_cost) : null, o.minutes_per_unit)}
                  {' '}
                  <span className="badge" style={{ fontSize: 11 }}>{NUMBERS_COPY.estimated}</span>
                </li>
              )
            })}
          </ul>
          {numbers.capacity ? (
            <p className="t-small" style={{ margin: 0 }}>
              {NUMBERS_COPY.capacity(numbers.capacity.resource, numbers.capacity.hours_per_month)}{' '}
              <span className="badge" style={{ fontSize: 11 }}>{NUMBERS_COPY.estimated}</span>
            </p>
          ) : null}
          {numbers.fixed_costs.length ? (
            <p className="t-small" style={{ margin: 0 }}>
              {NUMBERS_COPY.fixed(numbers.fixed_costs.map((f) => `${f.label} ${pesos(f.monthly)}`).join(' · '))}{' '}
              <span className="badge" style={{ fontSize: 11 }}>{NUMBERS_COPY.estimated}</span>
            </p>
          ) : null}
        </>
      )}
      <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{NUMBERS_COPY.later}</p>
    </section>
  )
}
