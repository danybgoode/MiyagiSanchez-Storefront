'use client'

import type { PackageSku } from '@/lib/promoter-packages'
import { useState } from 'react'
import ProductosStep from './ProductosStep'
import type { SellsToday } from '@/lib/promoter-panel'
import CobraStep from './CobraStep'
import EntregaStep from './EntregaStep'
import NegocioStep from './NegocioStep'
import ReportStep from './ReportStep'
import type { Dictionary } from '@/lib/dictionary'

type Bound = { code: string; name: string | null } | null
type Shop = { shopId: string; slug: string; name: string; currency?: 'MXN' | 'USD'; estado?: string | null; municipio?: string | null }


/**
 * «El panel del promotor» (epic 08 · promoter-panel, D12): bind the PRM- code once, then four steps on one page —
 * 1 El negocio (the lead and the shop, one form) · 2 Sus productos (photos, typed cards, imports) · 3 Cobra (the split,
 * our share, the owner's receipt) · 4 Entrégala (the claim link, and the private preview when it is on).
 */
export default function PromoterCloseClient({
  bound: initialBound,
  transferEnabled,
  previewEnabled,
  activationCrmEnabled,
  packageRates,
  copy,
}: {
  copy: Dictionary['promotorPanel']
  bound: Bound
  transferEnabled: boolean
  previewEnabled: boolean
  activationCrmEnabled: boolean
  /** Each option's commission rate, so the promoter sees what they charge, pass on and keep before paying. */
  packageRates: Partial<Record<PackageSku, number>>
}) {
  const [bound, setBound] = useState<Bound>(initialBound)
  const [shop, setShop] = useState<Shop | null>(null)
  // The lead (merchant_relationships) the promoter is working on; the preview step records in-person consent on it.
  const [relationshipId, setRelationshipId] = useState<string | null>(null)
  // From «El negocio»: step 2's path and the default category for a new product.
  const [choices, setChoices] = useState<{ sellsToday: SellsToday | null; mainCategory: string | null }>({ sellsToday: null, mainCategory: null })

  if (!bound) return <BindStep copy={copy} onBound={setBound} />

  return (
    <div className="max-w-xl mx-auto px-4 py-8 grid gap-6" data-testid="promoter-panel">
      <header className="grid gap-1">
        <h1 className="t-h2" style={{ margin: 0, letterSpacing: 0 }}>{copy.header.title}</h1>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{copy.header.lead}</p>
        <p className="t-small" style={{ margin: 0 }}>
          <span className="font-mono font-semibold">{bound.code}</span>
          {bound.name ? <span> · {bound.name}</span> : null}
        </p>
      </header>

      <PanelStepper copy={copy} current={shop ? 2 : 1} />

      <NegocioStep
        copy={copy}
        promoterCode={bound.code}
        crmEnabled={activationCrmEnabled}
        shop={shop}
        onShop={setShop}
        onRelationship={(id) => setRelationshipId(id)}
        onChoices={setChoices}
      />
      {shop && <ProductosStep copy={copy} shop={shop} sellsToday={choices.sellsToday} mainCategory={choices.mainCategory} />}
      {shop && <CobraStep copy={copy} shop={shop} transferEnabled={transferEnabled} packageRates={packageRates} />}
      {shop && <EntregaStep copy={copy} shop={shop} previewEnabled={previewEnabled} relationshipId={relationshipId} />}
      <ReportStep copy={copy} />
    </div>
  )
}

/** «1 El negocio · 2 Sus productos · 3 Cobra · 4 Entrégala» — where the promoter is (promoter-panel D12). */
function PanelStepper({ copy, current }: { copy: Dictionary['promotorPanel']; current: number }) {
  const labels = [copy.steps.negocio, copy.steps.productos, copy.steps.cobra, copy.steps.entrega]
  return (
    <nav aria-label={copy.steps.of.replace('{n}', String(current))} data-testid="panel-stepper">
      <ol className="grid grid-cols-4 gap-2" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {labels.map((label, i) => {
          const step = i + 1
          const state = step < current ? 'done' : step === current ? 'current' : 'next'
          return (
            <li key={label} aria-current={state === 'current' ? 'step' : undefined} className="grid gap-1 text-center">
              <span
                className="mx-auto grid h-7 w-7 place-items-center rounded-full text-sm font-semibold"
                style={{
                  background: state === 'next' ? 'transparent' : 'var(--accent)',
                  color: state === 'next' ? 'var(--fg-muted)' : 'var(--fg-inverse)',
                  border: state === 'next' ? '1px solid var(--color-border)' : 'none',
                }}
              >
                {state === 'done' ? <i className="iconoir-check" aria-hidden /> : step}
              </span>
              <span className="t-small" style={{ color: state === 'next' ? 'var(--fg-muted)' : 'var(--fg)', fontWeight: state === 'current' ? 600 : 400 }}>{label}</span>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function BindStep({ copy, onBound }: { copy: Dictionary['promotorPanel']; onBound: (b: Bound) => void }) {
  const t = copy.bind
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function bind() {
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/promoter/me/bind', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) { setError(t.error); return }
      onBound(data.promoter)
    } catch { setError(copy.errors.network) }
    finally { setBusy(false) }
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-8 grid gap-6">
      <header className="grid gap-1">
        <h1 className="t-h2" style={{ margin: 0, letterSpacing: 0 }}>{t.title}</h1>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{t.hint}</p>
      </header>
      <div className="card-panel grid gap-3" style={{ padding: 'var(--s-5)' }}>
        <label className="block text-sm font-medium">{t.title}
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t.placeholder}
            autoCapitalize="characters"
            className="mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2 font-mono"
          />
        </label>
        {error && <p className="t-small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>}
        <button type="button" className="btn btn-primary" onClick={bind} disabled={busy || !code.trim()}>
          {busy ? t.busy : t.button}
        </button>
      </div>
    </div>
  )
}
