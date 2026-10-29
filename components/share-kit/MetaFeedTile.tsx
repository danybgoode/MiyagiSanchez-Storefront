'use client'

import { useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { pushAnalyticsEvent } from '@/lib/analytics-events'
import { SHARE_KIT_COPY as COPY } from '@/lib/share-kit/copy'

/**
 * The «Instagram y WhatsApp» tile (share-kit S3.2, D18): the shop's Meta feed URL to copy, a four-step Commerce
 * Manager guide, and how many products the feed leaves out. Comparte renders it only for a claimed Mexico shop.
 * Each copy fires `share_meta_feed_copied` once.
 */
export default function MetaFeedTile({
  feedUrl,
  excludedCount,
  onCopyResult,
}: {
  feedUrl: string
  excludedCount: number
  onCopyResult?: (ok: boolean) => void
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    pushAnalyticsEvent('share_meta_feed_copied', {})
    try {
      await navigator.clipboard.writeText(feedUrl)
      setCopied(true)
      onCopyResult?.(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      onCopyResult?.(false)
    }
  }

  return (
    <Card variant="panel" className="p-5" data-testid="share-meta-feed-tile">
      <h3 className="font-semibold flex items-center gap-2">
        <i className="iconoir-instagram" aria-hidden="true" /> {COPY.feedTitle}
      </h3>
      <p className="text-sm text-[var(--color-muted)] mt-1">{COPY.feedLead}</p>
      <p className="inline-block mt-3 text-xs font-mono bg-[var(--color-surface-alt)] border border-[var(--color-border)] rounded-[var(--r-pill)] px-3 py-1 break-all">
        {feedUrl}
      </p>
      <div className="mt-3">
        <Button type="button" onClick={copy} data-testid="share-meta-feed-copy">
          {copied ? <><i className="iconoir-check" aria-hidden="true" /> {COPY.copied}</> : <><i className="iconoir-copy" aria-hidden="true" /> {COPY.copy}</>}
        </Button>
      </div>
      <ol className="list-decimal pl-5 mt-4 grid gap-1 text-sm">
        {COPY.feedSteps.map((step) => <li key={step}>{step}</li>)}
      </ol>
      {excludedCount > 0 ? (
        <p className="text-sm text-[var(--color-muted)] mt-3 flex items-center gap-2" data-testid="share-meta-feed-excluded">
          <i className="iconoir-warning-circle" aria-hidden="true" /> {COPY.feedExcluded(excludedCount)}
        </p>
      ) : null}
    </Card>
  )
}
