'use client'

/**
 * «1 · El negocio» (epic 08 · promoter-panel S2.1/S2.2, decisions D5/D6). One form for the lead AND the shop, so a
 * promoter types the merchant's data once (it used to be two forms: «Datos del comercio» then «Abrir la tienda»).
 *
 * - «Guardar para después» saves the lead (`/api/promoter/relationship`) only.
 * - «Abrir su tienda» saves the lead, creates the shop (`/api/promoter/shop/setup`), then saves the lead again WITH THE
 *   ID IT JUST GOT and the shop id — the existing link path. (Reading the id from state there sent the old, empty one
 *   and created a second lead: pr-reviewer, #481.)
 * - Closed sets are dropdowns from the platform's own lists (D6): `BUSINESS_SHAPES`, the catalog categories, where they
 *   sell today (`SELLS_TODAY`, merged into `current_channels` without touching other values), `PREFERRED_CHANNELS` and
 *   the qualification CHECK values. Free text only for the names, the notes and the optional contact fields.
 * - The shop's country (México by default) and an optional description stay, folded under «Más datos»: a US promoter's
 *   shop must be a USD shop, and a seller's market can't change later (#409).
 * - With the CRM flag off (`crmEnabled` false), the form opens the shop only, and WhatsApp isn't required.
 *
 * Every visible string comes from `promotorPanel.negocio` in the locales (D11).
 */
import { useEffect, useRef, useState } from 'react'
import type { Dictionary } from '@/lib/dictionary'
import { BUSINESS_SHAPES } from '@/lib/business-shape'
import { CATEGORIES } from '@/lib/types'
import { ESTADO_NAMES } from '@/lib/mx-locations'
import { PREFERRED_CHANNELS } from '@/lib/preferred-channels'
import { SELLS_TODAY, isSellsToday, mergeCurrentChannels, whatsappForDisplay, whatsappForSave, whatsappIsValid, type SellsToday } from '@/lib/promoter-panel'

export type PanelShop = { shopId: string; slug: string; name: string; currency?: 'MXN' | 'USD'; estado?: string | null; municipio?: string | null }

type Copy = Dictionary['promotorPanel']
type Recent = { id: string; businessName: string }

/** `merchant_relationships_qualification_check`, in the order a promoter reads them. */
const INTEREST = ['unknown', 'strong', 'medium', 'weak', 'disqualified'] as const

const recentKey = (code: string) => `promoter-panel:recent:${code}`
const activeKey = (code: string) => `promoter-panel:active:${code}`
// The keys the old «Datos del comercio» form used, read once so a promoter keeps their place after the deploy.
const legacyRecentKey = (code: string) => `fm_relationships:${code}`
const legacyActiveKey = (code: string) => `fm_relationship_active:${code}`

function readRecent(code: string): Recent[] {
  try {
    const raw = localStorage.getItem(recentKey(code)) ?? localStorage.getItem(legacyRecentKey(code))
    const list = raw ? (JSON.parse(raw) as Recent[]) : []
    return Array.isArray(list) ? list.filter((r) => r && typeof r.id === 'string').slice(0, 12) : []
  } catch { return [] }
}

function remember(code: string, entry: Recent): Recent[] {
  const next = [entry, ...readRecent(code).filter((r) => r.id !== entry.id)].slice(0, 12)
  try { localStorage.setItem(recentKey(code), JSON.stringify(next)) } catch { /* a cache only */ }
  return next
}

function setActivePointer(code: string, id: string | null) {
  try {
    if (id) localStorage.setItem(activeKey(code), id)
    else { localStorage.removeItem(activeKey(code)); localStorage.removeItem(legacyActiveKey(code)) }
  } catch { /* a cache only */ }
}

const digits = (v: string) => v.replace(/\D/g, '')

export default function NegocioStep({
  copy,
  promoterCode,
  crmEnabled,
  shop,
  onShop,
  onRelationship,
  onChoices,
}: {
  copy: Copy
  promoterCode: string
  crmEnabled: boolean
  shop: PanelShop | null
  onShop: (shop: PanelShop | null) => void
  onRelationship: (id: string | null, sellsToday: SellsToday | null) => void
  /** Where they sell today and the main category — step 2 picks its path and its default category from them. */
  onChoices?: (choices: { sellsToday: SellsToday | null; mainCategory: string | null }) => void
}) {
  const t = copy.negocio
  const [loaded, setLoaded] = useState(!crmEnabled)
  const [relationshipId, setRelationshipId] = useState<string | null>(null)
  const [recent, setRecent] = useState<Recent[]>([])
  const [businessName, setBusinessName] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [whatsapp, setWhatsapp] = useState('')
  const [market, setMarket] = useState<'mx' | 'us'>('mx')
  const [description, setDescription] = useState('')
  const [cp, setCp] = useState('')
  const [colonias, setColonias] = useState<string[]>([])
  const [colonia, setColonia] = useState('')
  const [estado, setEstado] = useState('')
  const [municipio, setMunicipio] = useState('')
  const [manualLocation, setManualLocation] = useState(false)
  const [cpBusy, setCpBusy] = useState(false)
  const [shape, setShape] = useState('')
  const [mainCategory, setMainCategory] = useState('')
  const [sellsToday, setSellsToday] = useState<SellsToday | ''>('')
  // Values already on the lead that aren't ours (e.g. a founding-merchant application's free text): kept on save.
  const otherChannels = useRef<string[]>([])
  const [channel, setChannel] = useState('')
  const [interest, setInterest] = useState<string>('unknown')
  const [notes, setNotes] = useState('')
  const [objections, setObjections] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [instagram, setInstagram] = useState('')
  const [busy, setBusy] = useState<'open' | 'save' | 'load' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // `id: null` = another promoter's record: the 409 says only that it exists.
  const [dupe, setDupe] = useState<{ id: string | null; name: string } | null>(null)
  const [suggestions, setSuggestions] = useState<Recent[]>([])
  // Which button hit the duplicate, so «No, es otro» repeats THAT action with confirmNew.
  const [lastAction, setLastAction] = useState<'open' | 'save'>('save')

  type Loaded = {
    id: string; businessName: string; contactName: string | null; phone: string | null; email: string | null
    whatsapp: string | null; instagramHandle: string | null; estado: string | null; municipio: string | null
    category: string | null; currentChannels: string[]; preferredChannel: string | null; qualification: string | null
    fitNote: string | null; objections: string | null
  }

  function choices(next: { sellsToday?: SellsToday | ''; mainCategory?: string }) {
    const s = next.sellsToday !== undefined ? next.sellsToday : sellsToday
    const c = next.mainCategory !== undefined ? next.mainCategory : mainCategory
    onChoices?.({ sellsToday: s || null, mainCategory: c || null })
  }

  function clearUi() {
    setMessage(null); setWarning(null); setError(null); setDupe(null); setSuggestions([])
  }

  /** Every per-record field, reset in ONE place before a record loads or a new one starts (no leftovers between them). */
  function resetFields() {
    setRelationshipId(null); setBusinessName(''); setOwnerName(''); setWhatsapp(''); setMarket('mx'); setDescription('')
    setCp(''); setColonias([]); setColonia(''); setEstado(''); setMunicipio(''); setManualLocation(false)
    setShape(''); setMainCategory(''); setSellsToday(''); otherChannels.current = []; setChannel('')
    setInterest('unknown'); setNotes(''); setObjections(''); setEmail(''); setPhone(''); setInstagram('')
  }

  function fill(rel: Loaded, linked: PanelShop | null) {
    clearUi()
    resetFields()
    setRelationshipId(rel.id)
    setBusinessName(rel.businessName)
    setOwnerName(rel.contactName ?? '')
    setWhatsapp(whatsappForDisplay(rel.whatsapp))
    setPhone(rel.phone ?? '')
    setEmail(rel.email ?? '')
    setInstagram(rel.instagramHandle ?? '')
    setEstado(rel.estado ?? '')
    setMunicipio(rel.municipio ?? '')
    if (rel.estado || rel.municipio) setManualLocation(true)
    setShape((BUSINESS_SHAPES as readonly string[]).includes(rel.category ?? '') ? (rel.category as string) : '')
    const ours = rel.currentChannels.find(isSellsToday) ?? ''
    otherChannels.current = rel.currentChannels.filter((c) => !isSellsToday(c))
    setSellsToday(ours)
    setChannel(rel.preferredChannel ?? '')
    setInterest(rel.qualification ?? 'unknown')
    setNotes(rel.fitNote ?? '')
    setObjections(rel.objections ?? '')
    setRecent(remember(promoterCode, { id: rel.id, businessName: rel.businessName }))
    setActivePointer(promoterCode, rel.id)
    onRelationship(rel.id, ours || null)
    onChoices?.({ sellsToday: ours || null, mainCategory: null })
    onShop(linked)
  }

  function startNew() {
    clearUi()
    resetFields()
    setActivePointer(promoterCode, null)
    onRelationship(null, null)
    onChoices?.({ sellsToday: null, mainCategory: null })
    onShop(null)
  }

  async function load(id: string) {
    clearUi()
    setBusy('load')
    try {
      const res = await fetch(`/api/promoter/relationship/${encodeURIComponent(id)}`)
      const data = await res.json().catch(() => ({}))
      if (res.status === 403) { setError(t.notYours); return }
      if (!res.ok || !data.ok) { setError(copy.errors.network); return }
      fill(data.relationship as Loaded, (data.shop as PanelShop | null) ?? null)
    } catch { setError(copy.errors.network) }
    finally { setBusy(null) }
  }

  // Resume where the promoter left off on this phone (the server record is the truth; this is only a pointer). The
  // form stays disabled until it lands, so nothing typed is overwritten.
  useEffect(() => {
    if (!crmEnabled) return
    let cancelled = false
    const list = readRecent(promoterCode)
    let active: string | null = null
    try { active = localStorage.getItem(activeKey(promoterCode)) ?? localStorage.getItem(legacyActiveKey(promoterCode)) } catch { /* no cache */ }
    Promise.resolve().then(() => { if (!cancelled) setRecent(list) })
    if (!active) {
      Promise.resolve().then(() => { if (!cancelled) setLoaded(true) })
      return () => { cancelled = true }
    }
    fetch(`/api/promoter/relationship/${encodeURIComponent(active)}`)
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (cancelled) return
        if (ok && data.ok) fill(data.relationship as Loaded, (data.shop as PanelShop | null) ?? null)
        else setActivePointer(promoterCode, null) // stale or not theirs: forget it
      })
      .catch(() => { /* a fresh capture is still possible */ })
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
    // `fill` reads props that are stable for the panel's life; resuming once per promoter is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promoterCode, crmEnabled])

  async function lookupCp() {
    if (digits(cp).length !== 5) return
    setCpBusy(true); setError(null)
    try {
      const res = await fetch('/api/checkout/postal-lookup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cp: digits(cp) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error ?? copy.errors.network); return }
      setEstado(data.stateName ?? '')
      setMunicipio(data.alcaldia ?? '')
      const list: string[] = Array.isArray(data.colonias) ? data.colonias : []
      setColonias(list)
      setColonia(list.length === 1 ? list[0] : '')
    } catch { setError(copy.errors.network) }
    finally { setCpBusy(false) }
  }

  /** Save the lead; returns its id, or null when it stopped (a duplicate to confirm, or an error already shown). */
  async function saveLead(opts: { confirmNew?: boolean; shopId?: string; id?: string | null } = {}): Promise<string | null> {
    const id = opts.id !== undefined ? opts.id : relationshipId
    const res = await fetch('/api/promoter/relationship', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relationshipId: id ?? undefined,
        confirmNew: opts.confirmNew || undefined,
        businessName: businessName.trim(),
        contactName: ownerName.trim(),
        whatsapp: whatsappForSave(whatsapp),
        phone: phone.trim(),
        email: email.trim(),
        instagramHandle: instagram.trim(),
        estado,
        municipio,
        category: shape || undefined,
        // Our answer replaces only our own value; anything else already on the lead stays (pr-reviewer, #481).
        currentChannels: mergeCurrentChannels(otherChannels.current, sellsToday || null),
        preferredChannel: channel || undefined,
        qualification: interest,
        fitNote: notes.trim(),
        objections,
        shopId: opts.shopId ?? shop?.shopId ?? undefined,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.status === 409 && data.elsewhere) {
      setDupe({ id: null, name: '' })
      return null
    }
    if (res.status === 409 && data.relationshipId) {
      // The 409 carries the id and why it matched, not the name: show it when we know it.
      const match = recent.find((r) => r.id === data.relationshipId)?.businessName ?? ''
      setDupe({ id: data.relationshipId, name: match })
      return null
    }
    if (!res.ok || !data.ok) { setError(data.error ?? copy.errors.network); return null }
    const savedId = data.relationship.id as string
    setRelationshipId(savedId)
    setRecent(remember(promoterCode, { id: savedId, businessName: data.relationship.businessName }))
    setActivePointer(promoterCode, savedId)
    onRelationship(savedId, sellsToday || null)
    // Never report a bare success when the audit row didn't land (B4 of the activation epic).
    if (data.auditRecorded === false) setWarning(t.auditWarning)
    const similar = Array.isArray(data.suggestions) ? (data.suggestions as Recent[]).filter((s) => s.id !== savedId) : []
    setSuggestions(similar)
    return savedId
  }

  function validate(): boolean {
    if (businessName.trim().length < 2) { setError(t.nameRequired); return false }
    if (crmEnabled && !whatsappIsValid(whatsapp)) { setError(t.whatsappInvalid); return false }
    return true
  }

  async function save(confirmNew = false) {
    clearUi()
    if (!validate()) return
    setLastAction('save')
    setBusy('save')
    try {
      if (await saveLead({ confirmNew })) setMessage(t.saved)
    } catch { setError(copy.errors.network) }
    finally { setBusy(null) }
  }

  async function open(confirmNew = false) {
    clearUi()
    if (!validate()) return
    setLastAction('open')
    setBusy('open')
    try {
      let leadId: string | null = null
      if (crmEnabled) {
        leadId = await saveLead({ confirmNew })
        if (!leadId) return
      }
      const res = await fetch('/api/promoter/shop/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: businessName.trim(),
          description: description.trim() || undefined,
          operating_market: market,
          cp: market === 'mx' ? digits(cp) || undefined : undefined,
          estado: estado || undefined,
          municipio: municipio || undefined,
          colonia: market === 'mx' ? colonia || undefined : undefined,
          merchant_email: email.trim() || undefined,
          main_category: mainCategory || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) { setError(data.error ?? copy.errors.network); return }
      const created: PanelShop = {
        shopId: data.shopId, slug: data.slug, name: data.name, currency: market === 'us' ? 'USD' : 'MXN',
        estado: data.estado ?? null, municipio: data.municipio ?? null,
      }
      onShop(created)
      if (crmEnabled && leadId) {
        // The id just returned, never the render's stale state (pr-reviewer, #481).
        const linked = await saveLead({ shopId: created.shopId, id: leadId }).catch(() => null)
        if (!linked) setError(t.linkError)
      }
      setMessage(t.created.replace('{nombre}', created.name))
    } catch { setError(copy.errors.network) }
    finally { setBusy(null) }
  }

  const field = 'mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2'
  const label = 'block text-sm font-medium'
  const locked = busy !== null || !loaded

  return (
    <section className="card-panel grid gap-4" style={{ padding: 'var(--s-5)' }} data-testid="panel-negocio" aria-busy={!loaded}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="t-h4" style={{ margin: 0, letterSpacing: 0 }}>1 · {copy.steps.negocio}</h2>
          <p className="t-small" style={{ margin: 'var(--s-1) 0 0', color: 'var(--fg-muted)' }}>{t.lead}</p>
        </div>
        {crmEnabled && (relationshipId || recent.length > 0) ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={startNew} disabled={locked}>{t.newOne}</button>
        ) : null}
      </div>

      {crmEnabled && recent.length > 0 ? (
        <div className="grid gap-2">
          <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{t.recent}</p>
          <div className="flex flex-wrap gap-2">
            {recent.map((r) => (
              <button key={r.id} type="button" className={r.id === relationshipId ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} onClick={() => load(r.id)} disabled={locked}>
                {r.businessName}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <fieldset disabled={locked} className="grid gap-4" style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <label className={label}>{t.name}
          <input className={field} value={businessName} onChange={(e) => setBusinessName(e.target.value)} autoComplete="organization" />
        </label>
        <label className={label}>{t.owner}
          <input className={field} value={ownerName} onChange={(e) => setOwnerName(e.target.value)} autoComplete="name" />
        </label>
        <label className={label}>{t.whatsapp}
          <input className={field} value={whatsapp} onChange={(e) => setWhatsapp(e.target.value.replace(/[^\d+\s]/g, '').slice(0, 18))} inputMode="tel" autoComplete="tel" placeholder="55 1234 5678" />
          <span className="t-small" style={{ color: 'var(--fg-muted)' }}>{t.whatsappHint}</span>
        </label>

        {market === 'mx' && !manualLocation ? (
          <div className="grid gap-2">
            <label className={label}>{t.cp}
              <div className="mt-1 flex gap-2">
                <input className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2" value={cp} onChange={(e) => setCp(digits(e.target.value).slice(0, 5))} onBlur={lookupCp} inputMode="numeric" autoComplete="postal-code" />
                <button type="button" className="btn btn-secondary" onClick={lookupCp} disabled={cpBusy || digits(cp).length !== 5}>{cpBusy ? t.cpBusy : t.cpButton}</button>
              </div>
            </label>
            {colonias.length > 0 ? (
              <label className={label}>{t.colonia}
                <select className={field} value={colonia} onChange={(e) => setColonia(e.target.value)}>
                  <option value="">{t.choose}</option>
                  {colonias.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            ) : null}
            {estado ? <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{[municipio, estado].filter(Boolean).join(', ')}</p> : null}
            <button type="button" className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }} onClick={() => setManualLocation(true)}>{t.cpManual}</button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={label}>{t.estado}
              {market === 'mx' ? (
                <select className={field} value={estado} onChange={(e) => setEstado(e.target.value)}>
                  <option value="">{t.choose}</option>
                  {ESTADO_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              ) : (
                <input className={field} value={estado} onChange={(e) => setEstado(e.target.value)} />
              )}
            </label>
            <label className={label}>{t.municipio}
              <input className={field} value={municipio} onChange={(e) => setMunicipio(e.target.value)} />
            </label>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>{t.sells}
            <select className={field} value={shape} onChange={(e) => setShape(e.target.value)} data-testid="panel-shape">
              <option value="">{t.choose}</option>
              {BUSINESS_SHAPES.map((s) => <option key={s} value={s}>{t.shapes[s]}</option>)}
            </select>
          </label>
          <label className={label}>{t.category}
            <select className={field} value={mainCategory} onChange={(e) => { setMainCategory(e.target.value); choices({ mainCategory: e.target.value }) }} data-testid="panel-category">
              <option value="">{t.choose}</option>
              {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
        </div>

        <label className={label}>{t.sellsToday}
          <select className={field} value={sellsToday} onChange={(e) => { const v = isSellsToday(e.target.value) ? e.target.value : ''; setSellsToday(v); choices({ sellsToday: v }) }} data-testid="panel-sells-today">
            <option value="">{t.choose}</option>
            {SELLS_TODAY.map((s) => <option key={s} value={s}>{t.sellsTodayOptions[s]}</option>)}
          </select>
        </label>

        {crmEnabled ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={label}>{t.channel}
              <select className={field} value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="">{t.choose}</option>
                {PREFERRED_CHANNELS.map((c) => <option key={c} value={c}>{t.channels[c]}</option>)}
              </select>
            </label>
            <label className={label}>{t.interest}
              <select className={field} value={interest} onChange={(e) => setInterest(e.target.value)}>
                {INTEREST.map((q) => <option key={q} value={q}>{t.interestOptions[q]}</option>)}
              </select>
            </label>
          </div>
        ) : null}

        {crmEnabled ? (
          <label className={label}>{t.notes}
            <textarea className={field} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t.notesPlaceholder} />
          </label>
        ) : null}

        <details>
          <summary className="t-small" style={{ cursor: 'pointer', fontWeight: 600 }}>{t.more}</summary>
          <div className="mt-3 grid gap-3">
            <label className={label}>{t.email}
              <input className={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
              <span className="t-small" style={{ color: 'var(--fg-muted)' }}>{t.emailHint}</span>
            </label>
            {crmEnabled ? (
              <>
                <label className={label}>{t.phone}
                  <input className={field} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
                </label>
                <label className={label}>{t.instagram}
                  <input className={field} value={instagram} onChange={(e) => setInstagram(e.target.value)} placeholder="@" />
                </label>
              </>
            ) : null}
            {!shop ? (
              <>
                <label className={label}>{t.market}
                  <select className={field} value={market} onChange={(e) => { const m = e.target.value === 'us' ? 'us' : 'mx'; setMarket(m); if (m === 'us') setManualLocation(true) }} data-testid="panel-market">
                    <option value="mx">{t.marketMx}</option>
                    <option value="us">{t.marketUs}</option>
                  </select>
                </label>
                <label className={label}>{t.description}
                  <textarea className={field} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
                </label>
              </>
            ) : null}
          </div>
        </details>
      </fieldset>

      {dupe ? (
        <div className="grid gap-2 rounded-lg border border-[var(--color-border)] p-3" role="alert">
          <p className="t-small" style={{ margin: 0 }}>{dupe.id === null ? t.dupeElsewhere : dupe.name ? t.dupe.replace('{nombre}', dupe.name) : t.dupeNoName}</p>
          <div className="flex flex-wrap gap-2">
            {dupe.id !== null ? <button type="button" className="btn btn-primary btn-sm" onClick={() => load(dupe.id as string)} disabled={busy !== null}>{t.dupeYes}</button> : null}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => (lastAction === 'open' ? open(true) : save(true))} disabled={busy !== null}>{t.dupeNo}</button>
          </div>
        </div>
      ) : null}

      {suggestions.length > 0 ? (
        <div className="grid gap-2">
          <p className="t-small" style={{ margin: 0 }}>{t.suggestions}</p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button key={s.id} type="button" className="btn btn-secondary btn-sm" onClick={() => load(s.id)} disabled={busy !== null}>{s.businessName}</button>
            ))}
          </div>
        </div>
      ) : null}

      {message ? <p className="t-small" role="status" style={{ margin: 0, color: 'var(--success)' }}>{message}</p> : null}
      {warning ? <p className="t-small" role="status" style={{ margin: 0, color: 'var(--warning, var(--danger))' }}>{warning}</p> : null}
      {error ? <p className="t-small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p> : null}

      <div className="grid gap-2 sm:flex sm:flex-wrap">
        {shop ? (
          <a className="btn btn-primary" href="#panel-productos">{t.continue}</a>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => open()} disabled={locked} data-testid="panel-open-shop">
            {busy === 'open' ? t.opening : t.open}
          </button>
        )}
        {crmEnabled ? (
          <button type="button" className="btn btn-secondary" onClick={() => save()} disabled={locked} data-testid="panel-save-lead">
            {busy === 'save' ? t.saving : t.save}
          </button>
        ) : null}
      </div>
    </section>
  )
}
