'use client'

import { useId, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/feedback/Banner'
import { MAX_DESCRIPTION_CHARS } from '@/lib/prompt-to-shop/constants'
import { characterCounter, DESCRIBE_COPY } from '@/lib/prompt-to-shop/copy'
import TurnstileWidget from '@/app/(shell)/p2s/_components/TurnstileWidget'

// The taking-shape screen carries the whole canvas (theme, illustrations, stream reader). It is needed only after a
// tap, so it loads as its own chunk instead of weighing on the landing page; `warmShaping` fetches it the moment the
// merchant starts typing, so the tap itself never waits on it.
const loadShaping = () => import('@/app/(shell)/p2s/_components/TakingShape')
const TakingShape = dynamic(loadShaping, { ssr: false })
const warmShaping = () => { void loadShaping() }

/**
 * The describe box — prompt-to-shop's front door (epic S2.2).
 *
 * One label, one textarea, three tappable examples and one button: the merchant starts by describing, not by
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
        if (ready && token) setShaping({ description: trimmed, token })
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
        placeholder={DESCRIBE_COPY.placeholder}
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
      </div>

      {siteKey ? (
        <TurnstileWidget siteKey={siteKey} onToken={setToken} />
      ) : (
        <Banner variant="warning">{DESCRIBE_COPY.unverifiable}</Banner>
      )}

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
