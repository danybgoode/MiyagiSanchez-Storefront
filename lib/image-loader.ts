/**
 * next/image CUSTOM loader (09-platform-infra/hyper-performant-website S1.1).
 *
 * WHY a custom loader instead of Next's built-in `/_next/image` optimizer:
 * this app runs `output: 'standalone'` on Cloud Run (frontend-vercel-to-cloudrun
 * epic). That build mode has a confirmed, still-open upstream Next.js regression
 * (vercel next.js repo, issue 82610 — search "output: standalone /_next/image")
 * where every `/_next/image` request 500s/400s — verified directly against this
 * Dockerfile (see its S1.2 commit message: "Dropped the '/_next/image optimized
 * request' acceptance check... confirmed open upstream output:standalone
 * regression"). The built-in optimizer is therefore a dead end here regardless
 * of how `images.formats`/`remotePatterns` are configured.
 *
 * A CUSTOM loader sidesteps that route entirely — `next/image` just calls this
 * function per candidate width and uses whatever URL it returns directly as
 * `src`/`srcset`; no `/_next/image` hop involved. We point it at our own
 * `/api/img` route (app/api/img/route.ts), a small `sharp`-based resize/format
 * proxy that already runs fine in this container (sharp is explicitly
 * reinstalled in the Dockerfile's runner stage for the same standalone-tracing
 * reason, and is proven working there).
 *
 * Registered in next.config.ts via `images.loader = 'custom'` + `loaderFile`.
 */
import type { ImageLoaderProps } from 'next/image'

export default function r2ImageLoader({ src, width }: ImageLoaderProps): string {
  const params = new URLSearchParams({
    url: src,
    w: String(width),
    // D5 emits exactly one quality from next/image. The route still accepts
    // canonical members of its [60, 75, 90] compatibility ladder for old URLs;
    // letting callers vary loader quality would needlessly multiply cold
    // origin encodes and Cloudflare cache keys.
    q: '75',
    // D5: format must be in the URL because the live Cloudflare rule does not
    // honour Vary: Accept for this cache path.
    f: 'webp',
    // The unversioned f=webp key was requested while the old route was still
    // live; that route ignored f and Cloudflare cached negotiated AVIF under
    // it. A versioned immutable key makes that object unreachable after deploy.
    v: '2',
  })
  return `/api/img?${params.toString()}`
}

/**
 * A JPEG variant for the print pages the PDF renderer loads (share-kit). Same route and cache rules as the loader;
 * only the pinned format differs, because Chromium embeds a JPEG in a PDF as-is (`lib/image-variant.ts`).
 */
export function printImageUrl(src: string, width: number): string {
  return `/api/img?${new URLSearchParams({ url: src, w: String(width), q: '75', f: 'jpeg', v: '2' }).toString()}`
}
