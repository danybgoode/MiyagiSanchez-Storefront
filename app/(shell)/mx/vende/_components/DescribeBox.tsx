'use client'

import { useEffect, useId, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/feedback/Banner'
import { MAX_DESCRIPTION_CHARS } from '@/lib/prompt-to-shop/constants'
import { characterCounter, DESCRIBE_COPY, OWNER_COPY } from '@/lib/prompt-to-shop/copy'
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
export default function DescribeBox({
  siteKey,
  manualHref,
  fileHref = '/sell/setup',
}: {
  /** `TURNSTILE_SITE_KEY`, read at request time by the server page. Null = the box cannot verify anyone. */
  siteKey: string | null
  /** «Armar a mano»: where the existing SellWizard entry lives for this surface. */
  manualHref: string
  /** The file/agent import route. */
  fileHref?: string
}) {
  const fieldId = useId()
  const [text, setText] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [shaping, setShaping] = useState<{ description: string; token: string } | null>(null)

  const rotating = useRotatingPlaceholder(DESCRIBE_COPY.rotatingExamples, text.length === 0 && !shaping)
  const trimmed = text.trim()
  const ready = trimmed.length > 0 && text.length <= MAX_DESCRIPTION_CHARS && !!token && !!siteKey

  if (shaping) {
    return (
      <TakingShape
        description={shaping.description}
        turnstileToken={shaping.token}
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
        trackFunnel('p2s_describe_submitted', null, { chars: trimmed.length })
        setShaping({ description: trimmed, token })
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
          {DESCRIBE_COPY.examples.map((example) => (
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
        {siteKey ? <TurnstileWidget siteKey={siteKey} onToken={setToken} /> : null}
      </div>

      {siteKey ? null : <Banner variant="warning">{DESCRIBE_COPY.unverifiable}</Banner>}
      {/* The check is invisible, so a disabled button needs a reason on screen (same line as the owner canvas). */}
      {siteKey && !token && trimmed.length > 0 ? (
        <p className="t-small" data-testid="p2s-verifying" style={{ margin: 0, color: 'var(--fg-muted)' }}>{OWNER_COPY.verifyNeeded}</p>
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
