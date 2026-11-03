import Link from 'next/link'
import type { Move, Plan } from '@/lib/business-plan/engine'
import type { Explanation } from '@/lib/business-plan/explain-server'
import { PLAN_COPY, SUMMARY_COPY } from '@/lib/business-plan/copy'

/**
 * «Tu plan» — the numbers the engine computed and the moves it picked (business-infrastructure S3.1–S3.3). Every
 * figure here comes from `computePlan`; the words come from `explanationFor` (template or guarded model text). Each
 * move is a link to the page that does it: nothing changes until the merchant confirms there (D9).
 */
const pesos = (cents: number) => `$${Math.round(cents / 100).toLocaleString('es-MX')}`

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="grid gap-0.5" data-testid={testId}>
      <span className="t-small" style={{ color: 'var(--fg-muted)' }}>{label}</span>
      <strong className="t-h4" style={{ margin: 0 }}>{value}</strong>
    </div>
  )
}

function MoveRow({ move }: { move: Move }) {
  const { title, action } = SUMMARY_COPY.move(move, pesos)
  return (
    <li className="flex items-center justify-between gap-3" style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--s-2)' }} data-testid="plan-move" data-kind={move.kind}>
      <span className="t-small">{title}</span>
      <Link href={move.href} prefetch={false} className="btn btn-secondary btn-sm" style={{ flexShrink: 0 }}>{action}</Link>
    </li>
  )
}

export default function PlanSummary({ plan, explanation }: { plan: Plan; explanation: Explanation }) {
  const c = plan.constraint
  return (
    <section className="card-panel grid gap-3" style={{ padding: 'var(--s-4)' }} data-testid="plan-summary" data-constraint={c.kind}>
      <h2 className="t-h4" style={{ margin: 0 }}>{SUMMARY_COPY.title}</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {plan.needed_units != null ? <Stat label={SUMMARY_COPY.needed} value={String(plan.needed_units)} testId="plan-needed" /> : null}
        {plan.breakeven_units != null ? <Stat label={SUMMARY_COPY.breakeven} value={String(plan.breakeven_units)} testId="plan-breakeven" /> : null}
        {plan.capacity_units != null ? <Stat label={SUMMARY_COPY.capacity} value={String(plan.capacity_units)} testId="plan-capacity-units" /> : null}
        {plan.current_units != null ? <Stat label={SUMMARY_COPY.current} value={String(plan.current_units)} testId="plan-current" /> : null}
        {plan.current_profit_cents != null ? <Stat label={SUMMARY_COPY.profitNow} value={pesos(plan.current_profit_cents)} testId="plan-profit-now" /> : null}
      </div>
      <p className="t-small" style={{ margin: 0, fontWeight: 600 }} data-testid="plan-constraint">{SUMMARY_COPY.constraint(c, PLAN_COPY.gap)}</p>
      <p style={{ margin: 0 }} data-testid="plan-explanation" data-source={explanation.source}>{explanation.text}</p>
      {plan.moves.length ? (
        <div className="grid gap-1">
          <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{SUMMARY_COPY.movesLead}</p>
          <ul className="grid gap-2" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {plan.moves.map((m) => <MoveRow key={`${m.kind}:${'offer' in m ? m.offer : ''}`} move={m} />)}
          </ul>
        </div>
      ) : null}
      <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{SUMMARY_COPY.disclaimer}</p>
    </section>
  )
}
