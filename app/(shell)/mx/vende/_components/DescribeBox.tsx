'use client'

import { useEffect, useId, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/feedback/Banner'
import { MAX_DESCRIPTION_CHARS } from '@/lib/prompt-to-shop/constants'
import { characterCounter, OWNER_COPY } from '@/lib/prompt-to-shop/copy'
import { describeCopy } from '@/lib/prompt-to-shop/copy-en'
import { runIntake } from '@/lib/prompt-to-shop/client'
import { INTAKE_FILE_ACCEPT, INTAKE_PHOTO_ACCEPT } from '@/lib/prompt-to-shop/intake'
import { browserMarketHint, type P2sLocale, type P2sMarketHint } from '@/lib/prompt-to-shop/locale'
import { trackFunnel } from '@/lib/prompt-to-shop/funnel'
import { nextTypewriterStep, TYPEWRITER_START, typewriterText, type TypewriterStep } from '@/lib/prompt-to-shop/typewriter'
import TurnstileWidget from '@/app/(shell)/p2s/_components/TurnstileWidget'

// The taking-shape screen carries the whole canvas (theme, illustrations, stream reader). It is needed only after a
// tap, so it loads as its own chunk instead of weighing on the landing page; `warmShaping` fetches it the moment the
// merchant starts typing, so the tap itself never waits on it.
const loadShaping = () => import('@/app/(shell)/p2s/_components/TakingShape')
const TakingShape = dynamic(loadShaping, { ssr: false })
const warmShaping = () => { void loadShaping() }

/**
 * The placeholder that types out an example, deletes it and types the next. It runs only while the box is empty,
 * starts after hydration (the server renders the static placeholder), and stays still for reduced motion.
 */
function useRotatingPlaceholder(lines: readonly string[], active: boolean): string | null {
  const [step, setStep] = useState<TypewriterStep | null>(null)
  useEffect(() => {
    if (!active || lines.length === 0) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    let current = TYPEWRITER_START
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const next = nextTypewriterStep(lines, current)
      current = next.step
      setStep(current)
      timer = setTimeout(tick, next.delay)
    }
    timer = setTimeout(tick, 600)
    return () => {
      clearTimeout(timer)
      // Forget where the last run stopped: a cleared box starts from the static placeholder, not a half-typed line.
      setStep(null)
    }
  }, [lines, active])
  return active && step ? typewriterText(lines, step) : null
}

/**
 * The describe box — prompt-to-shop's front door (epic S2.2).
 *
 * One label, one textarea (its placeholder types examples out), a rail of tappable examples and one button: the merchant starts by describing, not by
 * filling forms. It lives in the `/mx/vende` hero and at the top of the `/sell` first run.
 *
 * Submitting does NOT navigate first: it swaps this box for the taking-shape screen (S2.3), which owns the request,
 * so the narration starts in the same frame as the tap. The text stays here, so a refusal brings the merchant back
 * to what they wrote.
 */
type Seed = { rows: Array<{ title: string; price?: number; currency?: string; images?: string[] }>; source: string | null; input: 'photo' | 'file' | 'url' }

export default function DescribeBox({
  siteKey,
  manualHref,
  fileHref = '/sell/setup',
  locale = 'es',
  marketHint,
  examples,
}: {
  /** `TURNSTILE_SITE_KEY`, read at request time by the server page. Null = the box cannot verify anyone. */
  siteKey: string | null
  /** «Armar a mano»: where the existing SellWizard entry lives for this surface. */
  manualHref: string
  /** The file/agent import route. */
  fileHref?: string
  /** one-front-door-both-markets D11 — the PAGE's language, never the browser's. */
  locale?: P2sLocale
  /** D12 — the page's market (`/mx/vende/*`, `/us/*`). Undefined = a page of no market: the browser hints after hydration. */
  marketHint?: P2sMarketHint | null
  /** S3.1 — the page's own example chips (food on comida, cars on autos). Absent = the general set. */
  examples?: ReadonlyArray<{ label: string; text: string }>
}) {
  const DESCRIBE_COPY = describeCopy(locale)
  const chips = examples ?? DESCRIBE_COPY.examples
  // D12 — a page of one market states it; a page of no market asks the browser, at the moment of a tap (never at
  // render: the server cannot know, and a hydration-time read would flash the wrong currency).
  const resolveHint = (): P2sMarketHint | null => {
    if (marketHint !== undefined) return marketHint
    try {
      return browserMarketHint({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, languages: navigator.languages?.length ? navigator.languages : [navigator.language] })
    } catch {
      return null
    }
  }
  const [seed, setSeed] = useState<Seed | null>(null)
  const [reading, setReading] = useState(false)
  const [intakeError, setIntakeError] = useState<string | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [link, setLink] = useState('')
  // Each intake spends a Turnstile token; bumping the key makes the widget issue a fresh one for the next request.
  const [turnstileKey, setTurnstileKey] = useState(0)
  const photoInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const fieldId = useId()
  const [text, setText] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [shaping, setShaping] = useState<{ description: string; token: string; hint: P2sMarketHint | null } | null>(null)

  const rotating = useRotatingPlaceholder(DESCRIBE_COPY.rotatingExamples, text.length === 0 && !shaping)
  const trimmed = text.trim()
  const ready = trimmed.length > 0 && text.length <= MAX_DESCRIPTION_CHARS && !!token && !!siteKey && !reading

  async function intake(kind: 'photo' | 'file' | 'link', payload: { file?: File; url?: string }) {
    if (!token || reading) return
    setReading(true)
    setIntakeError(null)
    warmShaping()
    const answer = await runIntake(kind, { ...payload, turnstileToken: token, locale, marketHint: resolveHint() }, DESCRIBE_COPY.failed)
    setToken(null)
    setTurnstileKey((k) => k + 1)
    setReading(false)
    if (!answer.ok) {
      setIntakeError(answer.message)
      return
    }
    setText(answer.description.slice(0, MAX_DESCRIPTION_CHARS))
    setSeed({ rows: answer.seedRows, source: answer.sourceName, input: answer.input })
    setLinkOpen(false)
  }

  if (shaping) {
    return (
      <TakingShape
        description={shaping.description}
        turnstileToken={shaping.token}
        locale={locale}
        marketHint={shaping.hint}
        input={seed?.input ?? 'text'}
        seedRows={seed?.rows}
        onBack={() => {
          // The token was spent by the attempt; the widget below mounts fresh and issues another.
          setToken(null)
          setShaping(null)
        }}
      />
    )
  }

  return (
    <form
      data-testid="p2s-describe-box"
      className="card-panel"
      style={{ padding: 'var(--s-5)', display: 'grid', gap: 'var(--s-3)' }}
      onSubmit={(e) => {
        e.preventDefault()
        if (!ready || !token) return
        // Funnel step 1 (S5.3). There is no draft yet, so it counts once per tab.
        const hint = resolveHint()
        trackFunnel('p2s_describe_submitted', null, { chars: trimmed.length, input: seed?.input ?? 'text', market: hint ?? 'none', locale })
        setShaping({ description: trimmed, token, hint })
      }}
    >
      <label htmlFor={fieldId} className="t-h3" style={{ letterSpacing: 0 }}>
        {DESCRIBE_COPY.label}
      </label>
      <textarea
        id={fieldId}
        className="input"
        rows={3}
        maxLength={MAX_DESCRIPTION_CHARS}
        value={text}
        placeholder={rotating ?? DESCRIBE_COPY.placeholder}
        onFocus={warmShaping}
        onChange={(e) => setText(e.target.value)}
        style={{ resize: 'vertical', minHeight: 84 }}
      />
      <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)', textAlign: 'right' }} aria-live="off">
        {characterCounter(text.length)}
      </p>

      <div>
        <p className="t-small" style={{ margin: '0 0 var(--s-2)', color: 'var(--fg-muted)' }}>{DESCRIBE_COPY.examplesHint}</p>
        <div className="chip-rail" style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
          {chips.map((example) => (
            <button
              key={example.label}
              type="button"
              className="chip"
              data-testid={`p2s-example-${example.label.toLowerCase()}`}
              onClick={() => { warmShaping(); setText(example.text) }}
            >
              {example.label}
            </button>
          ))}
        </div>
        {/* Inside the examples block, not its own grid row: the check is invisible unless Cloudflare needs a tap, and
            an empty row would still take a gap. */}
        {siteKey ? <TurnstileWidget siteKey={siteKey} onToken={setToken} resetKey={turnstileKey} /> : null}
      </div>

      {/* S1.3–S1.5 — start from what the merchant already has. Each choice reads it and fills the box above. */}
      <div data-testid="p2s-intake">
        <p className="t-small" style={{ margin: '0 0 var(--s-2)', color: 'var(--fg-muted)' }}>{DESCRIBE_COPY.startWith}</p>
        <div style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
          <button type="button" className="chip" data-testid="p2s-intake-photo" disabled={!token || reading} onClick={() => photoInput.current?.click()}>
            <i className="iconoir-camera" aria-hidden="true" /> {DESCRIBE_COPY.photo}
          </button>
          <button type="button" className="chip" data-testid="p2s-intake-file" disabled={!token || reading} onClick={() => fileInput.current?.click()}>
            <i className="iconoir-page" aria-hidden="true" /> {DESCRIBE_COPY.file}
          </button>
          <button type="button" className="chip" data-testid="p2s-intake-link" disabled={reading} onClick={() => setLinkOpen((o) => !o)} aria-expanded={linkOpen}>
            <i className="iconoir-link" aria-hidden="true" /> {DESCRIBE_COPY.link}
          </button>
        </div>
        <input ref={photoInput} type="file" accept={INTAKE_PHOTO_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void intake('photo', { file: f }) }} />
        <input ref={fileInput} type="file" accept={INTAKE_FILE_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void intake('file', { file: f }) }} />
        {linkOpen ? (
          <div style={{ display: 'flex', gap: 'var(--s-2)', marginTop: 'var(--s-2)', flexWrap: 'wrap' }}>
            <label htmlFor={`${fieldId}-link`} className="sr-only">{DESCRIBE_COPY.linkLabel}</label>
            <input
              id={`${fieldId}-link`}
              className="input"
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder={DESCRIBE_COPY.linkPlaceholder}
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (link.trim()) void intake('link', { url: link.trim() }) } }}
              style={{ flex: '1 1 220px', minWidth: 0 }}
              data-testid="p2s-intake-link-input"
            />
            <Button type="button" variant="secondary" disabled={!token || reading || !link.trim()} onClick={() => void intake('link', { url: link.trim() })}>
              {DESCRIBE_COPY.linkSubmit}
            </Button>
          </div>
        ) : null}
        {reading ? <p className="t-small" aria-live="polite" style={{ margin: 'var(--s-2) 0 0', color: 'var(--fg-muted)' }}>{DESCRIBE_COPY.reading}</p> : null}
        {intakeError ? <div style={{ marginTop: 'var(--s-2)' }}><Banner variant="warning">{intakeError}</Banner></div> : null}
        {seed && seed.rows.length ? (
          <p className="t-small" data-testid="p2s-intake-seeded" style={{ margin: 'var(--s-2) 0 0', display: 'flex', gap: 'var(--s-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            {seed.input === 'photo' && seed.rows[0]?.images?.[0] ? (
              // eslint-disable-next-line @next/next/no-img-element -- the visitor's own just-uploaded photo, shown once
              <img src={seed.rows[0].images[0]} alt="" width={40} height={40} style={{ objectFit: 'cover', borderRadius: 'var(--r-2)' }} />
            ) : <i className="iconoir-check-circle" aria-hidden="true" style={{ color: 'var(--success)' }} />}
            <span>{seed.input === 'photo' ? DESCRIBE_COPY.seededPhoto : DESCRIBE_COPY.seeded(seed.rows.length, seed.source)}</span>
            <button type="button" className="link-button" onClick={() => setSeed(null)}>{DESCRIBE_COPY.remove}</button>
          </p>
        ) : null}
      </div>

      {siteKey ? null : <Banner variant="warning">{DESCRIBE_COPY.unverifiable}</Banner>}
      {/* The check is invisible, so a disabled button needs a reason on screen (same line as the owner canvas). */}
      {siteKey && !token && trimmed.length > 0 ? (
        <p className="t-small" data-testid="p2s-verifying" style={{ margin: 0, color: 'var(--fg-muted)' }}>{locale === 'en' ? DESCRIBE_COPY.waitVerify : OWNER_COPY.verifyNeeded}</p>
      ) : null}

      <Button type="submit" variant="primary" size="lg" disabled={!ready} data-testid="p2s-describe-submit">
        {DESCRIBE_COPY.submit}
        <i className="iconoir-arrow-right" aria-hidden="true" />
      </Button>

      <p className="t-small" style={{ margin: 0, display: 'flex', flexWrap: 'wrap', gap: 'var(--s-2) var(--s-4)' }}>
        <Link href={fileHref} prefetch={false}>{DESCRIBE_COPY.fileLink}</Link>
        <Link href={manualHref} prefetch={false}>{DESCRIBE_COPY.manualLink}</Link>
      </p>
    </form>
  )
}
