'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/feedback/Banner'
import LazySignUp from '@/app/components/clerk-lazy/LazySignUp'
import { mailDraftLink } from '@/lib/prompt-to-shop/client'
import { KEEP_COPY } from '@/lib/prompt-to-shop/copy'

/**
 * «Quedármela» (epic prompt-to-shop S3.1) — screen 4: the keep action, and the sign-up sheet over the canvas.
 *
 * Signed in, the action is a plain link to `/sell/armar?draft=<id>` (no sheet: there is nobody to sign up). Signed
 * out, it opens a bottom sheet with Clerk's own `<SignUp>` (Google and email, whatever the Clerk instance offers),
 * routed by HASH so the page under it stays the canvas. After sign-up Clerk lands on `/sell/armar?draft=<id>` through
 * `fallbackRedirectUrl` / `signInFallbackRedirectUrl` — FALLBACK, never force (a `redirect_url` still wins), and not
 * `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL`, which does not exist in Clerk v7.
 *
 * Hash routing has one consequence handled here: a Google sign-up leaves the page and comes back to it with a
 * `#/sso-callback` hash that only a MOUNTED `<SignUp>` can finish. So a Clerk hash on load opens the sheet.
 *
 * «Mándame el enlace» is the not-now path: it mails this phone's links (`/api/p2s/link/[id]`).
 */

export default function KeepSheet({
  draftId,
  shopName,
  signedIn,
  ready,
}: {
  draftId: string
  shopName: string | null
  signedIn: boolean
  /** False while a block is still landing: a draft without a name and colours cannot become a shop yet. */
  ready: boolean
}) {
  const keepHref = `/sell/armar?draft=${draftId}`
  const [open, setOpen] = useState(false)
  const [mailOpen, setMailOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [mail, setMail] = useState<{ state: 'idle' | 'sending' | 'sent' | 'error'; message?: string }>({ state: 'idle' })
  const closeRef = useRef<HTMLButtonElement | null>(null)

  // Back from Google (or mid email-code step): finish the Clerk flow in the sheet it started in.
  useEffect(() => {
    if (!signedIn && window.location.hash.startsWith('#/')) setOpen(true)
  }, [signedIn])

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open])

  async function sendLink(e: FormEvent) {
    e.preventDefault()
    if (!email.trim() || mail.state === 'sending') return
    setMail({ state: 'sending' })
    const result = await mailDraftLink(draftId, email.trim())
    setMail({ state: result.ok ? 'sent' : 'error', message: result.message })
  }

  const mailForm = (
    <div className="grid gap-2" data-testid="p2s-mail-link">
      {mailOpen ? (
        <form className="grid gap-2" onSubmit={sendLink}>
          <label htmlFor="p2s-mail" className="t-small" style={{ fontWeight: 600 }}>{KEEP_COPY.emailLabel}</label>
          <input
            id="p2s-mail"
            className="input"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder={KEEP_COPY.emailPlaceholder}
            value={email}
            maxLength={254}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{KEEP_COPY.mailHint}</p>
          <div>
            <Button type="submit" variant="secondary" disabled={mail.state === 'sending'}>
              {mail.state === 'sending' ? KEEP_COPY.sending : KEEP_COPY.send}
            </Button>
          </div>
          <p className="t-small" style={{ margin: 0, minHeight: 20 }} role="status" aria-live="polite">
            {mail.state === 'sent' ? mail.message : null}
          </p>
          {mail.state === 'error' ? <Banner variant="warning">{mail.message}</Banner> : null}
        </form>
      ) : (
        <div>
          <Button type="button" variant="ghost" onClick={() => setMailOpen(true)}>{KEEP_COPY.later}</Button>
        </div>
      )}
    </div>
  )

  return (
    <>
      <div
        className="sticky bottom-0 z-30"
        style={{ background: 'var(--bg-elevated, var(--bg))', borderTop: '1px solid var(--border)', paddingBottom: 'env(safe-area-inset-bottom)' }}
        data-testid="p2s-keep-bar"
      >
        <div className="max-w-6xl mx-auto px-4 py-3 grid gap-1">
          {!ready ? (
            <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{KEEP_COPY.waitShaping}</p>
          ) : null}
          {signedIn && ready ? (
            <Link href={keepHref} prefetch={false} className="btn btn-primary btn-lg" style={{ width: '100%' }} data-testid="p2s-keep">
              {KEEP_COPY.keep}
            </Link>
          ) : (
            <Button type="button" variant="primary" size="lg" disabled={!ready} onClick={() => setOpen(true)} style={{ width: '100%' }} data-testid="p2s-keep">
              {KEEP_COPY.keep}
            </Button>
          )}
        </div>
      </div>

      {open && !signedIn ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center" data-testid="p2s-keep-sheet">
          <button
            type="button"
            aria-label={KEEP_COPY.close}
            className="absolute inset-0"
            style={{ background: 'rgba(0,0,0,0.45)', border: 0 }}
            onClick={() => setOpen(false)}
            tabIndex={-1}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="p2s-keep-title"
            className="relative w-full max-w-lg grid gap-4 overflow-y-auto"
            style={{
              background: 'var(--bg)',
              borderTopLeftRadius: 'var(--r-lg, 16px)',
              borderTopRightRadius: 'var(--r-lg, 16px)',
              padding: 'var(--s-5, 20px)',
              paddingBottom: 'calc(var(--s-5, 20px) + env(safe-area-inset-bottom))',
              maxHeight: '92vh',
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="grid gap-1">
                <h2 id="p2s-keep-title" className="t-h3" style={{ margin: 0, letterSpacing: 0 }}>{KEEP_COPY.sheetTitle(shopName)}</h2>
                <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{KEEP_COPY.sheetLead}</p>
              </div>
              <button ref={closeRef} type="button" className="btn btn-ghost btn-sm" aria-label={KEEP_COPY.close} onClick={() => setOpen(false)}>
                <i className="iconoir-xmark" aria-hidden="true" />
              </button>
            </div>
            <div className="flex justify-center">
              <LazySignUp
                routing="hash"
                fallbackRedirectUrl={keepHref}
                signInFallbackRedirectUrl={keepHref}
                signInUrl={`/sign-in?redirect_url=${encodeURIComponent(keepHref)}`}
              />
            </div>
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--s-3, 12px)' }}>{mailForm}</div>
          </div>
        </div>
      ) : null}
    </>
  )
}
