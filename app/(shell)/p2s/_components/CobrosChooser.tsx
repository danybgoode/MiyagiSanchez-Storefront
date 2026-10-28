'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/feedback/Banner'
import { CLABE_LENGTH, MX_BANKS, OTHER_BANK, clabeComplete, initialBankPick, normalizeClabeInput, pickBank } from '@/lib/clabe'
import type { CheckoutPreview } from '@/lib/checkout-options'
import { fetchCheckoutPreview, patchShop } from '@/lib/prompt-to-shop/client'
import { MP_CONNECT_HREF, cashPatch, correosPatch, handDeliveryPatch, speiOffPatch, speiPatch, type ChooserState, type SettingsPatch } from '@/lib/prompt-to-shop/cobros'
import { COBROS_COPY } from '@/lib/prompt-to-shop/copy'
import { trackFunnel } from '@/lib/prompt-to-shop/funnel'

/**
 * The cobros / entregas chooser (epic prompt-to-shop S5.1): plain choices with a mark for each, and under them the
 * buyer's checkout as checkout itself will draw it.
 *
 * The rails are the existing ones, unchanged: Mercado Pago is a link to the existing OAuth start; SPEI, cash, hand
 * delivery and Correos are the exact `PATCH /api/sell/shop` writes the settings pages make (`lib/prompt-to-shop/
 * cobros.ts`), sent from the browser with the merchant's own session. After every write the preview re-asks checkout
 * (`/api/checkout/options`), so it shows what a buyer would really be offered — not what was clicked.
 *
 * «Envío por tu cuenta» (the manual carrier) has no switch: checkout offers it on its own to a US shop and never to a
 * Mexican one, so it is shown only when checkout's answer contains it.
 */
export default function CobrosChooser({
  shopSlug,
  market,
  initial,
  correosAvailable,
  draftId,
  onSaved,
}: {
  shopSlug: string
  market: string
  initial: ChooserState
  /** The platform's Correos switch (`shipping.correos_enabled`), read on the server. */
  correosAvailable: boolean
  /** The kept draft, for the funnel. */
  draftId: string | null
  onSaved?: () => void
}) {
  const [state, setState] = useState(initial)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [preview, setPreview] = useState<CheckoutPreview | 'loading'>('loading')
  const [clabe, setClabe] = useState(initial.clabe)
  const [bank, setBank] = useState(() => initialBankPick(initial.bankName))
  const bankName = bank.name
  const [holder, setHolder] = useState(initial.accountHolder)

  const refreshPreview = useCallback(async () => {
    setPreview('loading')
    setPreview(await fetchCheckoutPreview(shopSlug, market))
  }, [shopSlug, market])

  // The first read: `'loading'` is already the initial state, so the effect only fetches and sets the answer.
  useEffect(() => {
    let cancelled = false
    void fetchCheckoutPreview(shopSlug, market).then((p) => { if (!cancelled) setPreview(p) })
    return () => { cancelled = true }
  }, [shopSlug, market])

  // «Payments connected» is what checkout says, not what was tapped: one payment method a buyer can really use.
  useEffect(() => {
    if (draftId && preview !== 'loading' && preview.kind === 'ready' && preview.payments.length > 0) {
      trackFunnel('p2s_payments_connected', draftId, { methods: preview.payments.map((p) => p.key) })
    }
  }, [draftId, preview])

  async function save(key: string, patch: SettingsPatch, next: Partial<ChooserState>) {
    if (busy) return
    setBusy(key)
    setNotice(null)
    const result = await patchShop(patch)
    setBusy(null)
    if (!result.ok) {
      setNotice({ tone: 'warn', text: result.message })
      return
    }
    setState((s) => ({ ...s, ...next }))
    setNotice(result.synced ? { tone: 'ok', text: COBROS_COPY.saved } : { tone: 'warn', text: COBROS_COPY.notSynced })
    onSaved?.()
    await refreshPreview()
  }

  const speiReady = clabeComplete(clabe)
  const offeredDelivery = preview !== 'loading' && preview.kind === 'ready' ? preview.delivery : []
  const manualCarrier = offeredDelivery.some((d) => d.key === 'manual_carrier')

  return (
    <div className="grid gap-5" data-testid="p2s-cobros">
      <section className="grid gap-2" aria-labelledby="p2s-cobros-pay">
        <h3 id="p2s-cobros-pay" className="t-small" style={{ margin: 0, fontWeight: 700 }}>{COBROS_COPY.payTitle}</h3>

        <Choice
          mark={<span className="t-small" style={{ fontWeight: 800, color: 'var(--fg-inverse)', background: 'var(--provider-mercadopago)', borderRadius: 'var(--r-sm)', padding: '4px 6px', lineHeight: 1 }}>MP</span>}
          name={COBROS_COPY.mpName}
          lead={COBROS_COPY.mpLead}
          on={state.mercadopago}
          testId="p2s-choice-mp"
        >
          {state.mercadopago ? (
            <Link href="/shop/manage/settings/pagos#mercadopago" prefetch={false} className="btn btn-ghost btn-sm">{COBROS_COPY.mpManage}</Link>
          ) : (
            // The existing OAuth start, a plain top-level navigation — unchanged.
            <a href={MP_CONNECT_HREF} className="btn btn-sm" style={{ background: 'var(--provider-mercadopago)', color: 'var(--fg-inverse)' }} data-testid="p2s-mp-connect">
              {COBROS_COPY.mpConnect}
            </a>
          )}
        </Choice>

        <Choice mark={<i className="iconoir-bank" aria-hidden="true" style={{ fontSize: 22 }} />} name={COBROS_COPY.speiName} lead={COBROS_COPY.speiLead} on={state.spei} testId="p2s-choice-spei">
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const patch = speiPatch({ clabe, bankName, accountHolder: holder })
              if (patch) void save('spei', patch, { spei: true, clabe: normalizeClabeInput(clabe), bankName, accountHolder: holder })
            }}
          >
            <label className="grid gap-1 t-small">
              <span style={{ fontWeight: 600 }}>{COBROS_COPY.clabeLabel}</span>
              <input
                className="input"
                inputMode="numeric"
                autoComplete="off"
                value={clabe}
                maxLength={CLABE_LENGTH}
                onChange={(e) => setClabe(normalizeClabeInput(e.target.value))}
                aria-describedby="p2s-clabe-count"
                data-testid="p2s-clabe"
              />
              <span id="p2s-clabe-count" style={{ color: speiReady || !clabe ? 'var(--fg-muted)' : 'var(--warning)' }}>{COBROS_COPY.clabeCount(clabe.length)}</span>
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 t-small">
                <span style={{ fontWeight: 600 }}>{COBROS_COPY.bankLabel}</span>
                <select className="input" value={bank.isOther ? OTHER_BANK : bank.name} onChange={(e) => setBank(pickBank(e.target.value))}>
                  <option value="">{COBROS_COPY.bankPick}</option>
                  {MX_BANKS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
                {bank.isOther ? (
                  <input className="input" value={bank.name} maxLength={80} placeholder={COBROS_COPY.bankOther} onChange={(e) => setBank({ isOther: true, name: e.target.value })} data-testid="p2s-bank-other" />
                ) : null}
              </label>
              <label className="grid gap-1 t-small">
                <span style={{ fontWeight: 600 }}>{COBROS_COPY.holderLabel}</span>
                <input className="input" value={holder} maxLength={120} onChange={(e) => setHolder(e.target.value)} />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={!speiReady || !!busy} data-testid="p2s-spei-save">
                {busy === 'spei' ? COBROS_COPY.saving : COBROS_COPY.speiSave}
              </Button>
              {state.spei ? (
                <Button type="button" variant="ghost" size="sm" disabled={!!busy} onClick={() => void save('spei-off', speiOffPatch(), { spei: false })}>
                  {COBROS_COPY.speiOff}
                </Button>
              ) : null}
            </div>
          </form>
        </Choice>

        <Choice mark={<i className="iconoir-cash" aria-hidden="true" style={{ fontSize: 22 }} />} name={COBROS_COPY.cashName} lead={COBROS_COPY.cashLead} on={state.cash} testId="p2s-choice-cash">
          {/* The header and the button both show the merchant's own switch. Whether a buyer is OFFERED cash also needs
              hand delivery (checkout's rule); the note says so, and the preview below shows the real outcome. */}
          {!state.handDelivery ? <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{COBROS_COPY.cashNeedsHand}</p> : null}
          <Toggle on={state.cash} busy={busy === 'cash'} disabled={!!busy} onToggle={(v) => void save('cash', cashPatch(v), { cash: v })} />
        </Choice>
      </section>

      <section className="grid gap-2" aria-labelledby="p2s-cobros-deliver">
        <h3 id="p2s-cobros-deliver" className="t-small" style={{ margin: 0, fontWeight: 700 }}>{COBROS_COPY.deliverTitle}</h3>

        <Choice mark={<i className="iconoir-community" aria-hidden="true" style={{ fontSize: 22 }} />} name={COBROS_COPY.handName} lead={COBROS_COPY.handLead} on={state.handDelivery} testId="p2s-choice-hand">
          <Toggle on={state.handDelivery} busy={busy === 'hand'} disabled={!!busy} onToggle={(v) => void save('hand', handDeliveryPatch(v), { handDelivery: v })} />
        </Choice>

        <Choice mark={<i className="iconoir-mail" aria-hidden="true" style={{ fontSize: 22 }} />} name={COBROS_COPY.correosName} lead={COBROS_COPY.correosLead} on={state.correos && correosAvailable && state.hasOrigin} testId="p2s-choice-correos">
          {!correosAvailable ? (
            <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{COBROS_COPY.correosUnavailable}</p>
          ) : (
            <>
              {!state.hasOrigin ? (
                <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>
                  {COBROS_COPY.correosNeedsOrigin}{' '}
                  <Link href="/shop/manage/settings/envios#envios" prefetch={false}>{COBROS_COPY.correosOrigin}</Link>
                </p>
              ) : null}
              <Toggle on={state.correos} busy={busy === 'correos'} disabled={!!busy} onToggle={(v) => void save('correos', correosPatch(v), { correos: v })} />
            </>
          )}
        </Choice>

        {manualCarrier ? (
          <Choice mark={<i className="iconoir-delivery-truck" aria-hidden="true" style={{ fontSize: 22 }} />} name={COBROS_COPY.manualCarrierName} lead={COBROS_COPY.manualCarrierLead} on testId="p2s-choice-manual-carrier" />
        ) : null}
      </section>

      <p className="t-small" style={{ margin: 0, minHeight: 20 }} role="status" aria-live="polite">{notice?.tone === 'ok' ? notice.text : null}</p>
      {notice?.tone === 'warn' ? <Banner variant="warning">{notice.text}</Banner> : null}

      <CheckoutPreviewCard preview={preview} />
    </div>
  )
}

function Choice({ mark, name, lead, on, testId, children }: { mark: React.ReactNode; name: string; lead: string; on: boolean; testId: string; children?: React.ReactNode }) {
  return (
    <div className="card-panel grid gap-2" style={{ padding: 'var(--s-3)', borderColor: on ? 'var(--accent)' : undefined }} data-testid={testId} data-on={on}>
      <div className="flex items-start gap-3">
        <div className="flex items-center justify-center" style={{ width: 36, minWidth: 36, height: 36 }}>{mark}</div>
        <div className="grid gap-0.5" style={{ flex: 1, minWidth: 0 }}>
          <div className="flex items-center justify-between gap-2">
            <span style={{ fontWeight: 700 }}>{name}</span>
            <span className="t-small" style={{ color: on ? 'var(--success-strong, var(--success))' : 'var(--fg-muted)' }}>
              <i className={on ? 'iconoir-check-circle' : 'iconoir-circle'} aria-hidden="true" /> {on ? COBROS_COPY.on : COBROS_COPY.off}
            </span>
          </div>
          <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{lead}</p>
        </div>
      </div>
      {children ? <div className="grid gap-2" style={{ paddingLeft: 48 }}>{children}</div> : null}
    </div>
  )
}

function Toggle({ on, busy, disabled, onToggle }: { on: boolean; busy: boolean; disabled: boolean; onToggle: (next: boolean) => void }) {
  return (
    <div>
      <Button type="button" variant={on ? 'ghost' : 'secondary'} size="sm" disabled={disabled} onClick={() => onToggle(!on)}>
        {busy ? COBROS_COPY.saving : on ? COBROS_COPY.turnOff : COBROS_COPY.turnOn}
      </Button>
    </div>
  )
}

/** The buyer's side: exactly the methods checkout answered with, nothing re-derived here. */
function CheckoutPreviewCard({ preview }: { preview: CheckoutPreview | 'loading' }) {
  return (
    <section className="card-panel grid gap-3" style={{ padding: 'var(--s-4)', background: 'var(--bg-sunk)' }} aria-labelledby="p2s-preview-title" data-testid="p2s-checkout-preview">
      <h3 id="p2s-preview-title" className="t-small" style={{ margin: 0, fontWeight: 700 }}>
        <i className="iconoir-credit-card" aria-hidden="true" /> {COBROS_COPY.previewTitle}
      </h3>
      {preview === 'loading' ? (
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{COBROS_COPY.previewLoading}</p>
      ) : preview.kind === 'unavailable' ? (
        <Banner variant="neutral">{COBROS_COPY.previewUnavailable}</Banner>
      ) : (
        <>
          <PreviewList title={COBROS_COPY.previewPay} empty={COBROS_COPY.previewNoPay} items={preview.payments} testId="p2s-preview-pay" />
          <PreviewList title={COBROS_COPY.previewDeliver} empty={COBROS_COPY.previewNoDeliver} items={preview.delivery} testId="p2s-preview-deliver" />
        </>
      )}
    </section>
  )
}

function PreviewList({ title, empty, items, testId }: { title: string; empty: string; items: Array<{ key: string; label: string; note: string }>; testId: string }) {
  return (
    <div className="grid gap-1">
      <span className="t-small" style={{ fontWeight: 600 }}>{title}</span>
      {items.length ? (
        <ul className="grid gap-1" style={{ margin: 0, padding: 0, listStyle: 'none' }} data-testid={testId}>
          {items.map((item) => (
            <li key={item.key} className="t-small" data-method={item.key}>
              <span style={{ fontWeight: 600 }}>{item.label}</span>
              {item.note ? <span style={{ color: 'var(--fg-muted)' }}> · {item.note}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="t-small" style={{ margin: 0, color: 'var(--warning)' }} data-testid={`${testId}-empty`}>{empty}</p>
      )}
    </div>
  )
}
