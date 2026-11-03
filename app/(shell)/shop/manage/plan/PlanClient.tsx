'use client'

import { useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/feedback/Banner'
import type { BusinessInputs, Gap, Source, Valued } from '@/lib/business-plan/model'
import type { OfferField, PlanEdit } from '@/lib/business-plan/edit'
import { PLAN_COPY } from '@/lib/business-plan/copy'

/**
 * The model's inputs, editable (business-infrastructure S2.3). Every number shows its source; the merchant's own
 * entry makes it «tuyo». Only the fields they touched are sent (`PlanEdit`), conditional on the `updated_at` the page
 * read, so a second tab cannot be overwritten silently. Money is typed in pesos and shown in pesos.
 */

const FIELDS: OfferField[] = ['price', 'cost', 'minutes', 'units']
const fieldValue = (o: BusinessInputs['offers'][number], f: OfferField): Valued<number> | undefined =>
  f === 'price' ? o.price_cents : f === 'cost' ? o.unit_cost_cents : f === 'minutes' ? o.minutes_per_unit : o.units_per_month
const isMoney = (f: OfferField) => f === 'price' || f === 'cost'
const shown = (v: Valued<number> | undefined, money: boolean) => (v ? String(money ? v.value / 100 : v.value) : '')

function SourceTag({ source }: { source: Source | undefined }) {
  if (!source) return null
  return (
    <span className="badge" style={{ fontSize: 11 }} title={PLAN_COPY.sourceHint[source]} data-source={source}>
      {PLAN_COPY.source[source]}
    </span>
  )
}

function NumberField({ label, value, onChange, testId, suffix }: { label: string; value: string; onChange: (v: string) => void; testId: string; suffix?: ReactNode }) {
  return (
    <label className="grid gap-0.5 t-small">
      <span style={{ color: 'var(--fg-muted)' }}>{label}</span>
      <span className="flex items-center gap-1">
        <input className="input" inputMode="decimal" style={{ width: '100%', minWidth: 0 }} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} />
        {suffix}
      </span>
    </label>
  )
}

/** '' clears the merchant's value (the gap is named again); anything else must be a number ≥ 0. */
const parse = (raw: string): number | null | undefined => {
  const t = raw.trim().replace(/[$,\s]/g, '')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export default function PlanClient({ inputs, updatedAt, gaps, children }: { inputs: BusinessInputs; updatedAt: string; gaps: Gap[]; children?: ReactNode }) {
  const router = useRouter()
  const [offerEdits, setOfferEdits] = useState<Record<string, string>>({})
  const [goal, setGoal] = useState<string | null>(null)
  const [capacity, setCapacity] = useState<{ resource: string; hours: string } | null>(null)
  const [fixed, setFixed] = useState<Array<{ label: string; monthly: string; source?: Source }> | null>(null)
  // The precondition for the NEXT save: the server's answer to the last one, not the page's first read (a quick second
  // save would otherwise be a false «changed in another tab», PR #467 review).
  const [currentUpdatedAt, setCurrentUpdatedAt] = useState(updatedAt)
  const visibleOffers = inputs.offers.filter((o) => !o.retired)
  const [state, setState] = useState<{ kind: 'idle' | 'saving' | 'saved' } | { kind: 'error'; message: string }>({ kind: 'idle' })

  const editKey = (key: string, f: OfferField) => `${key}|${f}`
  const dirty = Object.keys(offerEdits).length > 0 || goal !== null || capacity !== null || fixed !== null

  const capView = capacity ?? { resource: inputs.capacity?.resource.value ?? '', hours: inputs.capacity?.hours_per_month ? String(inputs.capacity.hours_per_month.value) : '' }
  // Each row carries its own source, so removing a row cannot shift another row's label (PR #467 review).
  const fixedView = fixed ?? inputs.fixed_costs.map((f) => ({ label: f.label, monthly: String(f.monthly_cents.value / 100), source: f.monthly_cents.source as Source | undefined }))
  const invalid = () => setState({ kind: 'error', message: PLAN_COPY.invalidInput })

  async function save() {
    const edit: PlanEdit = { updated_at: currentUpdatedAt }
    const offers: NonNullable<PlanEdit['offers']> = []
    for (const [k, raw] of Object.entries(offerEdits)) {
      const [key, field] = k.split('|') as [string, OfferField]
      const value = parse(raw)
      if (value === undefined) return invalid()
      offers.push({ key, field, value })
    }
    if (offers.length) edit.offers = offers
    if (goal !== null) {
      const g = parse(goal)
      if (g === undefined) return invalid()
      edit.goal = g
    }
    if (capacity !== null) {
      const hours = parse(capacity.hours)
      if (hours === undefined) return invalid()
      // Hours with no resource would be silently dropped by a "clear capacity": refuse it instead (PR #467 review).
      if (!capacity.resource.trim() && hours !== null) return setState({ kind: 'error', message: PLAN_COPY.resourceNeeded })
      edit.capacity = capacity.resource.trim() ? { resource: capacity.resource.trim(), hours_per_month: hours } : null
    }
    if (fixed !== null) {
      const list = []
      for (const f of fixed) {
        if (!f.label.trim() && !f.monthly.trim()) continue
        const m = parse(f.monthly)
        if (m === undefined || m === null || !f.label.trim()) return invalid()
        list.push({ label: f.label.trim(), monthly: m })
      }
      edit.fixed_costs = list
    }
    setState({ kind: 'saving' })
    try {
      const res = await fetch('/api/shop/business-model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edit) })
      const body = (await res.json().catch(() => null)) as { error?: string; updated_at?: string } | null
      if (!res.ok) return setState({ kind: 'error', message: body?.error ?? PLAN_COPY.saveFailed })
      if (body?.updated_at) setCurrentUpdatedAt(body.updated_at)
      setOfferEdits({}); setGoal(null); setCapacity(null); setFixed(null)
      setState({ kind: 'saved' })
      router.refresh()
    } catch {
      setState({ kind: 'error', message: PLAN_COPY.saveFailed })
    }
  }

  return (
    <div className="grid gap-4">
      <section className="card-panel grid gap-2" style={{ padding: 'var(--s-4)' }} data-testid="plan-goal">
        <h2 className="t-h4" style={{ margin: 0 }}>{PLAN_COPY.goalTitle}</h2>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{PLAN_COPY.goalHint}</p>
        <div className="flex items-end gap-2" style={{ maxWidth: 280 }}>
          <NumberField
            label="$"
            value={goal ?? (inputs.goal_cents ? String(inputs.goal_cents.value / 100) : '')}
            onChange={setGoal}
            testId="plan-goal-input"
          />
          <SourceTag source={inputs.goal_cents?.source} />
        </div>
      </section>

      {children}

      <section className="card-panel grid gap-3" style={{ padding: 'var(--s-4)' }} data-testid="plan-offers">
        <h2 className="t-h4" style={{ margin: 0 }}>{PLAN_COPY.offersTitle}</h2>
        {visibleOffers.length === 0 ? <p className="t-small" style={{ margin: 0 }}>{PLAN_COPY.offersEmpty}</p> : null}
        {visibleOffers.map((o) => (
          <div key={o.key} className="grid gap-2" style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--s-3)' }} data-testid="plan-offer">
            <strong className="t-small">{o.title}</strong>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {FIELDS.map((f) => {
                const v = fieldValue(o, f)
                return (
                  <NumberField
                    key={f}
                    label={PLAN_COPY.cols[f]}
                    value={offerEdits[editKey(o.key, f)] ?? shown(v, isMoney(f))}
                    onChange={(raw) => setOfferEdits((prev) => ({ ...prev, [editKey(o.key, f)]: raw }))}
                    testId={`plan-${f}-${o.key}`}
                    suffix={<SourceTag source={v?.source} />}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </section>

      <section className="card-panel grid gap-2" style={{ padding: 'var(--s-4)' }} data-testid="plan-capacity">
        <h2 className="t-h4" style={{ margin: 0 }}>{PLAN_COPY.capacityTitle} <SourceTag source={inputs.capacity?.resource.source} /></h2>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{PLAN_COPY.capacityHint}</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-0.5 t-small">
            <span style={{ color: 'var(--fg-muted)' }}>{PLAN_COPY.resourceLabel}</span>
            <input className="input" value={capView.resource} maxLength={80} onChange={(e) => setCapacity({ ...capView, resource: e.target.value })} data-testid="plan-resource" />
          </label>
          <NumberField label={PLAN_COPY.hoursLabel} value={capView.hours} onChange={(h) => setCapacity({ ...capView, hours: h })} testId="plan-hours" />
        </div>
      </section>

      <section className="card-panel grid gap-2" style={{ padding: 'var(--s-4)' }} data-testid="plan-fixed">
        <h2 className="t-h4" style={{ margin: 0 }}>{PLAN_COPY.fixedTitle}</h2>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{PLAN_COPY.fixedHint}</p>
        {fixedView.map((f, i) => (
          <div key={i} className="flex items-end gap-2">
            <label className="grid gap-0.5 t-small" style={{ flex: 2 }}>
              <input className="input" value={f.label} placeholder={PLAN_COPY.labelPlaceholder} maxLength={80} onChange={(e) => setFixed(fixedView.map((x, j) => (j === i ? { ...x, label: e.target.value, source: undefined } : x)))} />
            </label>
            <div style={{ flex: 1 }}>
              <NumberField label="$" value={f.monthly} onChange={(m) => setFixed(fixedView.map((x, j) => (j === i ? { ...x, monthly: m, source: undefined } : x)))} testId={`plan-fixed-monthly-${i}`} />
            </div>
            <SourceTag source={f.source} />
            <Button type="button" variant="ghost" size="sm" onClick={() => setFixed(fixedView.filter((_, j) => j !== i))}>{PLAN_COPY.removeFixed}</Button>
          </div>
        ))}
        {fixedView.length < 12 ? (
          <div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setFixed([...fixedView, { label: '', monthly: '' }])}>{PLAN_COPY.addFixed}</Button>
          </div>
        ) : null}
      </section>

      {gaps.length ? (
        <section className="grid gap-1" data-testid="plan-gaps">
          <p className="t-small" style={{ margin: 0, fontWeight: 600 }}>{PLAN_COPY.gapsTitle}</p>
          <ul className="t-small" style={{ margin: 0, paddingLeft: '1.2em' }}>
            {gaps.slice(0, 8).map((g, i) => <li key={i}>{PLAN_COPY.gap(g)}</li>)}
          </ul>
        </section>
      ) : null}

      <div className="flex items-center gap-3" style={{ position: 'sticky', bottom: 0, background: 'var(--bg)', paddingBlock: 'var(--s-3)' }}>
        <Button type="button" variant="primary" disabled={!dirty || state.kind === 'saving'} onClick={() => void save()} data-testid="plan-save">
          {state.kind === 'saving' ? PLAN_COPY.saving : PLAN_COPY.save}
        </Button>
        <span className="t-small" role="status" aria-live="polite">{state.kind === 'saved' ? PLAN_COPY.saved : null}</span>
      </div>
      {state.kind === 'error' ? <Banner variant="warning">{state.message}</Banner> : null}
    </div>
  )
}
