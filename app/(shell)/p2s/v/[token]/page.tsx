import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { controlsFor, resolveViewerPage } from '@/lib/prompt-to-shop/access'
import { readDeps } from '@/lib/prompt-to-shop/read'
import { draftView } from '@/lib/prompt-to-shop/view'
import ShopCanvas from '../../_components/ShopCanvas'

/**
 * The view-only link (epic prompt-to-shop S2.5, D15).
 *
 * Reads the draft by its share token and NOTHING else — no cookie, no device. The canvas is rendered in `viewer`
 * mode with no toolbar, so there is no rename, no colour picker, no «Otra versión» and no keep button to render:
 * `controlsFor` gives a viewer an empty list, and this page imports no editing component at all. Same private /
 * noindex treatment as the owner route (and `next.config.ts` pins the headers on `/p2s/*`).
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Vista previa de una tienda',
  robots: { index: false, follow: false },
}

export default async function ViewerCanvasPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const resolved = await resolveViewerPage({ token }, readDeps)
  if (resolved.kind === 'gone') notFound()

  // A viewer has no controls — asserted here, not assumed, so a future change to `controlsFor` cannot hand one over.
  if (controlsFor(resolved.access).length > 0) notFound()

  // The shop's id is not the viewer's business: the placeholder id keeps the real one out of the page.
  return <ShopCanvas view={draftView('vista-previa', resolved.blocks)} mode="viewer" />
}
