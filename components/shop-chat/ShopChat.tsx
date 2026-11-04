'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import BodyPortal from '@/components/ui/BodyPortal'
import TurnstileWidget from '@/app/(shell)/p2s/_components/TurnstileWidget'

/**
 * The shop's chat (business-infrastructure S4) — bonsai-chat's widget, re-aimed at one shop: a launcher, then a panel
 * on `document.body` (above the header and tab bar), a human check once, and the conversation. The server decides
 * everything (`/api/shop-chat/<slug>`); this keeps the thread and the conversation token.
 *
 * `answered: false` means the shop's own information does not say: the panel offers to leave the question (S5 wires
 * the handoff; until then it points to the shop's contact).
 */

type Turn = { role: 'user' | 'assistant'; text: string; answered?: boolean }

const COPY = {
  launcher: 'Pregúntale a la tienda',
  title: (shop: string) => `Pregúntale a ${shop}`,
  lead: 'Responde con la información de la tienda. Si no sabe algo, te lo dice.',
  placeholder: 'Escribe tu pregunta…',
  send: 'Enviar',
  sending: 'Pensando…',
  close: 'Cerrar',
  verify: 'Un momento: verificamos que eres una persona.',
  failed: 'No pudimos responder ahora. Inténtalo de nuevo.',
  leaveTitle: 'Déjale tu pregunta a la tienda',
  leaveEmail: 'Tu correo, para que te responda',
  leaveSend: 'Enviar pregunta',
  leaveSending: 'Enviando…',
}

export default function ShopChat({ slug, shopName, siteKey, bottomOffset = 84 }: {
  slug: string
  shopName: string
  siteKey: string | null
  /** Pixels above the bottom edge: clear of the tab bar on shop pages, of the sticky buy bar on product pages. */
  bottomOffset?: number
}) {
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [turnstile, setTurnstile] = useState<string | null>(null)
  const [resetKey, setResetKey] = useState(0)
  const chatToken = useRef<string | null>(null)
  // Rendering decides on STATE (a ref read during render is not reactive); the token itself stays in the ref.
  const [verified, setVerified] = useState(false)
  // The handoff (S5): after a «no sé», the buyer may leave their last question and an email.
  const [leave, setLeave] = useState<{ kind: 'idle' | 'sending' } | { kind: 'done' | 'error'; message: string }>({ kind: 'idle' })
  const [email, setEmail] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)

  // Escape closes; focus goes to the question on open and back to the launcher on close (like every sheet here).
  useEffect(() => {
    if (!open) return
    input.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    const launcher = launcherRef.current
    return () => {
      document.removeEventListener('keydown', onKey)
      launcher?.focus()
    }
  }, [open])

  if (!siteKey) return null

  const last = turns[turns.length - 1]
  const lastQuestion = [...turns].reverse().find((t) => t.role === 'user')?.text ?? ''
  const offerLeave = verified && last?.role === 'assistant' && last.answered === false && leave.kind !== 'done'

  async function leaveQuestion(e: FormEvent) {
    e.preventDefault()
    if (!email.trim() || !lastQuestion || leave.kind === 'sending') return
    setLeave({ kind: 'sending' })
    try {
      const res = await fetch(`/api/shop-chat/${encodeURIComponent(slug)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), question: lastQuestion, transcript: turns.slice(-12), chat_token: chatToken.current }),
      })
      const body = (await res.json().catch(() => null)) as { message?: string } | null
      setLeave({ kind: res.ok ? 'done' : 'error', message: body?.message ?? COPY.failed })
    } catch {
      setLeave({ kind: 'error', message: COPY.failed })
    }
  }

  async function ask(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim().slice(0, 600)
    if (!text || busy) return
    if (!chatToken.current && !turnstile) { setError(COPY.verify); return }
    const next: Turn[] = [...turns, { role: 'user', text }]
    setTurns(next)
    setDraft('')
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/shop-chat/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: next.slice(-12).map(({ role, text: t }) => ({ role, text: t })),
          ...(chatToken.current ? { chat_token: chatToken.current } : { turnstile_token: turnstile }),
        }),
      })
      const body = (await res.json().catch(() => null)) as { answer?: string; answered?: boolean; chat_token?: string; error?: string; code?: string } | null
      if (!res.ok || !body?.answer) {
        // Take the unanswered question back out of the thread and into the box: two user turns in a row would make
        // the model refuse the whole conversation (PR #469 review).
        setTurns(turns)
        setDraft(text)
        // A Turnstile token is single-use: any failure before a conversation token exists needs a fresh challenge.
        if (body?.code === 'verify') { chatToken.current = null; setVerified(false) }
        if (!chatToken.current) { setTurnstile(null); setResetKey((k) => k + 1) }
        setError(body?.error ?? COPY.failed)
        return
      }
      if (body.chat_token) { chatToken.current = body.chat_token; setVerified(true) }
      setTurns([...next, { role: 'assistant', text: body.answer, answered: body.answered }])
      requestAnimationFrame(() => list.current?.scrollTo({ top: list.current.scrollHeight }))
    } catch {
      setTurns(turns)
      setDraft(text)
      if (!chatToken.current) { setTurnstile(null); setResetKey((k) => k + 1) }
      setError(COPY.failed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        className="btn btn-primary"
        onClick={() => setOpen(true)}
        data-testid="shop-chat-launcher"
        style={{ position: 'fixed', right: 16, bottom: `calc(${bottomOffset}px + env(safe-area-inset-bottom))`, zIndex: 'var(--z-overlay)', borderRadius: 999, boxShadow: '0 6px 20px rgba(0,0,0,.18)' }}
      >
        <i className="iconoir-chat-bubble" aria-hidden="true" /> {COPY.launcher}
      </button>
      {open ? (
        <BodyPortal>
          <div className="fixed inset-0 flex items-end sm:items-center justify-center sm:justify-end" style={{ zIndex: 'var(--z-overlay)' }} data-testid="shop-chat">
            <button type="button" aria-label={COPY.close} className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.35)', border: 0 }} onClick={() => setOpen(false)} tabIndex={-1} />
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="shop-chat-title"
              className="relative w-full sm:max-w-sm grid gap-3"
              style={{ background: 'var(--bg)', borderRadius: 'var(--r-lg, 16px)', padding: 'var(--s-4, 16px)', margin: 'var(--s-3, 12px)', maxHeight: '85vh', gridTemplateRows: 'auto 1fr auto' }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="grid gap-0.5">
                  <h2 id="shop-chat-title" className="t-h4" style={{ margin: 0 }}>{COPY.title(shopName)}</h2>
                  <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{COPY.lead}</p>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" aria-label={COPY.close} onClick={() => setOpen(false)}>
                  <i className="iconoir-xmark" aria-hidden="true" />
                </button>
              </div>
              <div ref={list} className="grid gap-2 overflow-y-auto" style={{ minHeight: 120, alignContent: 'start' }} aria-live="polite" data-testid="shop-chat-thread">
                {turns.map((t, i) => (
                  <p
                    key={i}
                    className="t-small"
                    data-role={t.role}
                    data-answered={t.answered === undefined ? undefined : String(t.answered)}
                    style={{
                      margin: 0, padding: '8px 12px', borderRadius: 12, maxWidth: '85%', whiteSpace: 'pre-wrap',
                      justifySelf: t.role === 'user' ? 'end' : 'start',
                      background: t.role === 'user' ? 'var(--accent-soft)' : 'var(--bg-subtle, var(--border))',
                    }}
                  >
                    {t.text}
                  </p>
                ))}
                {busy ? <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{COPY.sending}</p> : null}
                {offerLeave ? (
                  <form className="grid gap-2" onSubmit={leaveQuestion} data-testid="shop-chat-leave" style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--s-2, 8px)' }}>
                    <p className="t-small" style={{ margin: 0, fontWeight: 600 }}>{COPY.leaveTitle}</p>
                    <input className="input" type="email" inputMode="email" autoComplete="email" required maxLength={254} placeholder={COPY.leaveEmail} aria-label={COPY.leaveEmail} value={email} onChange={(e) => setEmail(e.target.value)} />
                    <div><button type="submit" className="btn btn-secondary btn-sm" disabled={leave.kind === 'sending'}>{leave.kind === 'sending' ? COPY.leaveSending : COPY.leaveSend}</button></div>
                  </form>
                ) : null}
                {leave.kind === 'done' || leave.kind === 'error' ? <p className="t-small" role="status" style={{ margin: 0 }}>{leave.message}</p> : null}
              </div>
              <form className="grid gap-2" onSubmit={ask}>
                {!verified ? <TurnstileWidget siteKey={siteKey} onToken={setTurnstile} resetKey={resetKey} /> : null}
                <div className="flex gap-2">
                  <input ref={input} className="input" style={{ flex: 1, minWidth: 0 }} value={draft} maxLength={600} placeholder={COPY.placeholder} onChange={(e) => setDraft(e.target.value)} aria-label={COPY.placeholder} data-testid="shop-chat-input" />
                  <button type="submit" className="btn btn-primary" disabled={busy || !draft.trim()} data-testid="shop-chat-send">{COPY.send}</button>
                </div>
                {error ? <p className="t-small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p> : null}
              </form>
            </div>
          </div>
        </BodyPortal>
      ) : null}
    </>
  )
}
