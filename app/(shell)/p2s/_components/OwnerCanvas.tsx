'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/feedback/Banner'
import { versionsLeftCopy } from '@/lib/prompt-to-shop/allowance'
import { patchDraft } from '@/lib/prompt-to-shop/client'
import { DESCRIBE_COPY, OWNER_COPY } from '@/lib/prompt-to-shop/copy'
import { trackFunnel } from '@/lib/prompt-to-shop/funnel'
import { draftView, type DraftBlocks } from '@/lib/prompt-to-shop/view'
import type { CanvasControl } from '@/lib/prompt-to-shop/access'
import KeepSheet from './KeepSheet'
import ShopCanvas from './ShopCanvas'
import TakingShape from './TakingShape'
import TurnstileWidget from './TurnstileWidget'

/**
 * The owner's preview (epic S2.4): the shop, with the few things a merchant can change inline.
 *
 * Which controls exist is decided by the SERVER (`controls`, from `controlsFor(access)`), and this component renders
 * exactly that list — it has no controls of its own to fall back on. Every edit autosaves through
 * `PATCH /api/p2s/drafts/[id]`; saves are chained one after another because each PATCH is optimistic on the row's
 * `updated_at`, and two in flight would make the second one fail against the first.
 */

type SaveState = 'idle' | 'saving' | 'saved' | 'error'
const DEBOUNCE_MS = 700

export default function OwnerCanvas({
  draftId,
  initial,
  versionsLeft: initialVersionsLeft,
  shareHref,
  siteKey,
  controls,
  signedIn,
}: {
  draftId: string
  initial: DraftBlocks
  versionsLeft: number
  /** Path of the view-only link, built on the server. */
  shareHref: string
  siteKey: string | null
  controls: CanvasControl[]
  /** From the server's `auth()`: a signed-in owner keeps the draft with one tap, no sheet (S3.1). */
  signedIn: boolean
}) {
  const router = useRouter()
  const [blocks, setBlocks] = useState(initial)
  const [name, setName] = useState(initial.identity?.name ?? '')
  const [save, setSave] = useState<{ state: SaveState; message?: string }>({ state: 'idle' })
  const [versionsLeft, setVersionsLeft] = useState(initialVersionsLeft)
  const [token, setToken] = useState<string | null>(null)
  const [tone, setTone] = useState('')
  const [rerun, setRerun] = useState<{ token: string; tone: string } | null>(null)
  const [resetKey, setResetKey] = useState(0)
  const [copied, setCopied] = useState<'idle' | 'copied' | 'manual'>('idle')
  const chain = useRef<Promise<void>>(Promise.resolve())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedName = useRef(initial.identity?.name ?? '')

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // Funnel step 2 (S5.3): the owner saw their whole shop — every block landed. Once per draft.
  const allLanded = !!(initial.identity && initial.words && initial.catalog)
  useEffect(() => { if (allLanded) trackFunnel('p2s_preview_rendered', draftId) }, [allLanded, draftId])

  const can = (c: CanvasControl) => controls.includes(c)

  function persist(body: { name?: string; accent_color?: string }) {
    setSave({ state: 'saving' })
    chain.current = chain.current.then(async () => {
      const result = await patchDraft(draftId, body)
      if (result.ok) {
        savedName.current = result.identity.name
        setBlocks((prev) => ({ ...prev, identity: result.identity }))
        setSave({ state: 'saved' })
      } else {
        setSave({ state: 'error', message: result.message })
      }
    })
  }

  function flushName(value: string) {
    if (timer.current) clearTimeout(timer.current)
    const trimmed = value.trim()
    // An empty name is not saved: validateIdentity would refuse it, and the field simply keeps what was last stored.
    if (!trimmed || trimmed === savedName.current) return
    persist({ name: trimmed })
  }

  function onNameChange(value: string) {
    setName(value)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => flushName(value), DEBOUNCE_MS)
  }

  async function copyShare() {
    const url = `${window.location.origin}${shareHref}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied('copied')
    } catch {
      setCopied('manual')
    }
  }

  // The preview shows the name as it is typed; storage catches up on the debounce.
  const view = draftView(draftId, blocks.identity && name.trim() ? { ...blocks, identity: { ...blocks.identity, name: name.trim() } } : blocks)
  const outOfVersions = versionsLeft <= 0

  if (rerun) {
    return (
      <TakingShape
        draftId={draftId}
        turnstileToken={rerun.token}
        tone={rerun.tone || undefined}
        onBack={() => {
          setRerun(null)
          setToken(null)
          setResetKey((k) => k + 1)
          // A re-run that got past the spend has already cleared the draft's blocks server-side (startVersion), so the
          // blocks held here are no longer what a reload would show. Re-read the truth instead of restoring them.
          router.refresh()
        }}
        onDone={({ versionsLeft: left }) => {
          setVersionsLeft(left)
          // TakingShape stays mounted, showing the new shop, until the server page re-reads the draft and its `key`
          // (updated_at) remounts this component on the new blocks. Unmounting it here would flash the OLD shop for
          // the length of the round-trip, and an edit in that window would 409 against a draft it no longer matches.
          router.refresh()
        }}
      />
    )
  }

  const toolbar = controls.length ? (
    <div
      className="max-w-6xl mx-auto px-4 pt-3 grid gap-3"
      data-testid="p2s-toolbar"
    >
      <div className="card-panel grid gap-3" style={{ padding: 'var(--s-4)' }}>
        {can('rename') ? (
          <div className="grid gap-1">
            <label htmlFor="p2s-name" className="t-small" style={{ fontWeight: 600 }}>{OWNER_COPY.nameLabel}</label>
            <input
              id="p2s-name"
              className="input"
              value={name}
              maxLength={60}
              onChange={(e) => onNameChange(e.target.value)}
              onBlur={(e) => flushName(e.target.value)}
              data-testid="p2s-name-input"
            />
          </div>
        ) : null}

        {can('accent') && view.accentAlternates.length ? (
          <div className="grid gap-1">
            <span className="t-small" style={{ fontWeight: 600 }}>{OWNER_COPY.accentLabel}</span>
            <div className="flex gap-2" role="group" aria-label={OWNER_COPY.accentLabel}>
              {view.accentAlternates.map((hex, i) => {
                const current = hex.toLowerCase() === view.accent.toLowerCase()
                return (
                  <button
                    key={hex}
                    type="button"
                    aria-label={OWNER_COPY.accentOption(i + 1)}
                    aria-pressed={current}
                    onClick={() => { if (!current) persist({ accent_color: hex }) }}
                    data-testid="p2s-accent-swatch"
                    className="h-11 w-11 rounded-full"
                    style={{
                      background: hex,
                      border: current ? '3px solid var(--fg)' : '1px solid var(--border)',
                      outlineOffset: 2,
                    }}
                  />
                )
              })}
            </div>
          </div>
        ) : null}

        <p className="t-small" style={{ margin: 0, minHeight: 20 }} role="status" aria-live="polite" data-testid="p2s-save-status">
          {save.state === 'saving' ? OWNER_COPY.saving : save.state === 'saved' ? OWNER_COPY.saved : null}
        </p>
        {save.state === 'error' ? <Banner variant="warning">{save.message}</Banner> : null}

        {can('version') ? (
          <div className="grid gap-2" style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--s-3)' }}>
            <p className="t-small" style={{ margin: 0, fontWeight: 600 }} data-testid="p2s-versions-left">{versionsLeftCopy(versionsLeft)}</p>
            {!outOfVersions ? (
              <>
                <div className="flex items-center gap-2">
                  <label htmlFor="p2s-tone" className="t-small">{OWNER_COPY.toneLabel}</label>
                  <select id="p2s-tone" className="input" style={{ width: 'auto' }} value={tone} onChange={(e) => setTone(e.target.value)}>
                    <option value="">{OWNER_COPY.toneSame}</option>
                    {OWNER_COPY.tones.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                {siteKey ? <TurnstileWidget siteKey={siteKey} onToken={setToken} resetKey={resetKey} /> : null}
                {!token && siteKey ? <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{OWNER_COPY.verifyNeeded}</p> : null}
                {/* No site key means verification can never happen: say so, as the describe box does, rather than leave a
                    button that is disabled for no visible reason. */}
                {siteKey ? null : <Banner variant="warning">{DESCRIBE_COPY.unverifiable}</Banner>}
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!token}
                    onClick={() => {
                      if (!token) return
                      // Funnel step 3 (S5.3): the first «Otra versión» on this draft.
                      trackFunnel('p2s_version_requested', draftId, { tone: tone || null })
                      setRerun({ token, tone })
                    }}
                    data-testid="p2s-another-version"
                  >
                    {OWNER_COPY.anotherVersion}
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {can('share') ? (
          <div className="grid gap-1" style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--s-3)' }}>
            <div>
              <Button type="button" variant="ghost" onClick={copyShare} data-testid="p2s-share">
                <i className="iconoir-share-android" aria-hidden="true" /> {OWNER_COPY.share}
              </Button>
            </div>
            <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }} role="status" aria-live="polite">
              {copied === 'copied' ? OWNER_COPY.shareCopied : OWNER_COPY.shareHint}
            </p>
            {copied === 'manual' ? (
              <label className="t-small grid gap-1">
                {OWNER_COPY.shareManual}
                <input className="input" readOnly value={`${typeof window === 'undefined' ? '' : window.location.origin}${shareHref}`} onFocus={(e) => e.currentTarget.select()} />
              </label>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  ) : null

  const landed = !view.pending.identity && !view.pending.words && !view.pending.catalog
  return (
    <>
      <ShopCanvas view={view} mode="owner" toolbar={toolbar} />
      {can('keep') ? <KeepSheet draftId={draftId} shopName={view.name} signedIn={signedIn} ready={landed} /> : null}
    </>
  )
}
