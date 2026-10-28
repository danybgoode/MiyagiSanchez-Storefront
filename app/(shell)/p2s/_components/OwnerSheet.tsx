'use client'

import { useEffect, useRef } from 'react'
import { CHECKLIST_COPY } from '@/lib/prompt-to-shop/copy'

/**
 * A bottom sheet over the kept-shop canvas (epic prompt-to-shop S4.1). Every checklist item opens one of these on
 * the canvas — never a separate form page. Same shape as the keep sheet: Escape and the backdrop close it, focus
 * goes to the close button, and the page under it stops scrolling while it is open.
 */
export default function OwnerSheet({
  title,
  lead,
  onClose,
  children,
  testId,
}: {
  title: string
  lead?: string
  onClose: () => void
  children: React.ReactNode
  testId?: string
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" data-testid={testId}>
      <button
        type="button"
        aria-label={CHECKLIST_COPY.close}
        className="absolute inset-0"
        style={{ background: 'rgba(0,0,0,0.45)', border: 0 }}
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="p2s-owner-sheet-title"
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
            <h2 id="p2s-owner-sheet-title" className="t-h3" style={{ margin: 0, letterSpacing: 0 }}>{title}</h2>
            {lead ? <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>{lead}</p> : null}
          </div>
          <button ref={closeRef} type="button" className="btn btn-ghost btn-sm" aria-label={CHECKLIST_COPY.close} onClick={onClose}>
            <i className="iconoir-xmark" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
