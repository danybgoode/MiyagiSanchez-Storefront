import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { controlsFor, resolveOwnerPage, viewHref } from '@/lib/prompt-to-shop/access'
import { P2S_LIMITS } from '@/lib/prompt-to-shop/allowance'
import { DEVICE_COOKIE } from '@/lib/prompt-to-shop/handler'
import { readDeps } from '@/lib/prompt-to-shop/read'
import OwnerCanvas from '../_components/OwnerCanvas'

/**
 * The owner's canvas (epic prompt-to-shop S2.4, D15).
 *
 * Reads the draft by id AND the `p2s_device` cookie. Not found, not yours and expired are ONE outcome (`notFound()`
 * → the friendly page in `../not-found.tsx`, status 404): the answer must not tell a stranger whether an id exists.
 *
 * Private by every route available: `force-dynamic` + a cookie read make Next send `private, no-store`, and
 * `next.config.ts` pins the same header (and `X-Robots-Tag: noindex`) on `/p2s/*`, with `robots` below as the
 * in-page twin. A draft is somebody's unfinished shop, not content for a crawler or a CDN to keep.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Tu tienda en armado — Miyagi Sánchez',
  robots: { index: false, follow: false },
}

export default async function OwnerCanvasPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const deviceCookie = (await cookies()).get(DEVICE_COOKIE)?.value
  const resolved = await resolveOwnerPage({ id, deviceCookie }, readDeps)
  if (resolved.kind === 'gone') notFound()

  return (
    <OwnerCanvas
      // A re-run changes `updated_at`; the new key remounts the client state on the freshly read blocks.
      key={resolved.updatedAt}
      draftId={resolved.access.draftId}
      initial={resolved.blocks}
      versionsLeft={Math.max(0, P2S_LIMITS.anonVersions - resolved.versionsUsed)}
      shareHref={viewHref(resolved.viewToken)}
      siteKey={process.env.TURNSTILE_SITE_KEY || null}
      controls={controlsFor(resolved.access)}
    />
  )
}
