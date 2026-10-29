/**
 * Self-hosted image resize/format proxy (09-platform-infra/hyper-performant-website
 * S1.1 spike-lite decision — see sprint-1.md for the full write-up).
 *
 * `next/image`'s built-in `/_next/image` optimizer is a dead end in this
 * container (confirmed open upstream `output: 'standalone'` regression,
 * vercel/next.js#82610 — see lib/image-loader.ts's header comment for the
 * paper trail). Cloudflare Images / zone-level Image Resizing would work but
 * need a dashboard/paid-product mutation this agent can't apply. So: a small
 * `sharp`-based route (sharp is already a proven working dependency in this
 * exact container — the Dockerfile explicitly reinstalls it in the runner
 * stage) that resizes + re-encodes on request, called via next/image's
 * CUSTOM loader (lib/image-loader.ts) — never through the broken route.
 *
 *   GET /api/img?url=<https URL>&w=<allowed width>&q=<60|75|90>
 *
 * Security: `url` must be `https:` and its hostname must be in the allow-list
 * derived from R2_PUBLIC_URL (+ NEXT_PUBLIC_SUPABASE_URL, the storage
 * fallback per lib/r2.ts's isR2Configured() comment) — an open proxy that
 * fetches ANY caller-supplied URL is an SSRF hole, so this is intentionally
 * NOT `hostname: '**'` like next.config.ts's now-unused (custom-loader mode
 * ignores it) remotePatterns.
 *
 * Width and quality must already be canonical members of small fixed ladders
 * (not arbitrary caller-chosen aliases). Cloudflare keys the raw query before
 * this route runs, so snapping here would still permit many MISSes to trigger
 * the same Sharp encode. Canonical rejection bounds both work and cache keys.
 *
 * Legacy URLs without a fixed `f` keep the shipped Accept negotiation
 * (avif > webp > jpeg passthrough). New loader URLs select WebP explicitly in
 * their cache key, so the legacy branch must not be reordered to achieve the
 * new behavior.
 */
import { NextRequest, NextResponse } from 'next/server'
import { imageVaryHeader, resolveImageVariant, selectImageFormat } from '@/lib/image-variant'
import { encodeImage } from '@/lib/image-encode'

export const runtime = 'nodejs'

const FETCH_TIMEOUT_MS = 10_000
// Guard against a runaway origin response inflating memory before sharp gets to shrink it.
const MAX_SOURCE_BYTES = 25 * 1024 * 1024

function allowedHosts(): Set<string> {
  const hosts = new Set<string>()
  for (const raw of [process.env.R2_PUBLIC_URL, process.env.NEXT_PUBLIC_SUPABASE_URL]) {
    if (!raw) continue
    try { hosts.add(new URL(raw).hostname) } catch { /* ignore malformed env */ }
  }
  return hosts
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  // Pass the raw query spelling too: URLSearchParams normalizes percent
  // escapes, while Cloudflare keys the bytes it received before this route.
  const decision = resolveImageVariant(searchParams, req.nextUrl.search.slice(1))
  if (!decision.ok) return NextResponse.json({ error: decision.error }, { status: 400 })
  const { src, width, quality, fixedFormat } = decision.variant

  let parsed: URL
  try {
    parsed = new URL(src)
  } catch {
    return NextResponse.json({ error: 'url inválida.' }, { status: 400 })
  }

  const hosts = allowedHosts()
  if (parsed.protocol !== 'https:' || hosts.size === 0 || !hosts.has(parsed.hostname)) {
    return NextResponse.json({ error: 'host de origen no permitido.' }, { status: 400 })
  }

  let upstream: Response
  try {
    // redirect: 'error' — the hostname allow-list above only validated the
    // INITIAL url. Without this, Node would transparently follow up to 20
    // redirects and never re-check the Location host, so a 3xx response from
    // an allow-listed origin (the Supabase project host especially — it's a
    // generic multi-tenant domain, not one we control end-to-end) could pivot
    // this server-side fetch anywhere. Our own R2/Supabase image URLs never
    // legitimately redirect, so erroring out is correct, not just safe.
    upstream = await fetch(parsed.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' })
  } catch {
    return NextResponse.json({ error: 'no se pudo descargar la imagen de origen.' }, { status: 502 })
  }
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: 'imagen de origen no disponible.' }, { status: 502 })
  }
  const upstreamType = upstream.headers.get('content-type') ?? ''
  if (!upstreamType.startsWith('image/')) {
    return NextResponse.json({ error: 'el recurso de origen no es una imagen.' }, { status: 415 })
  }
  const upstreamLen = Number(upstream.headers.get('content-length') ?? '0')
  if (upstreamLen > MAX_SOURCE_BYTES) {
    return NextResponse.json({ error: 'imagen de origen demasiado grande.' }, { status: 413 })
  }

  // Stream with a running byte counter instead of `await upstream.arrayBuffer()`
  // — content-length is advisory (absent on a chunked response, or simply
  // wrong), and arrayBuffer() would buffer the ENTIRE body into memory before
  // any size check ran. Cancel the read the moment the running total crosses
  // the cap, so a chunked large image — even from an allowed origin — can't
  // spike memory regardless of what header it claimed.
  const reader = upstream.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_SOURCE_BYTES) {
        await reader.cancel('source too large').catch(() => {})
        return NextResponse.json({ error: 'imagen de origen demasiado grande.' }, { status: 413 })
      }
      chunks.push(value)
    }
  } catch {
    return NextResponse.json({ error: 'no se pudo descargar la imagen de origen.' }, { status: 502 })
  }
  const srcBuf = Buffer.concat(chunks)

  const format = selectImageFormat(fixedFormat, req.headers.get('accept') ?? '')

  let outBuf: Buffer
  let outType: string
  try {
    const encoded = await encodeImage(srcBuf, { width, quality, format })
    outBuf = encoded.body
    outType = encoded.contentType
  } catch (err) {
    console.error('[api/img] sharp transform failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'no se pudo procesar la imagen.' }, { status: 500 })
  }

  return new NextResponse(new Uint8Array(outBuf), {
    status: 200,
    headers: {
      'Content-Type': outType,
      // Long-lived + immutable: the URL fully encodes (source url, width, quality),
      // so a different image is a different URL. Matches the bucket-level
      // Cache-Control this sprint also sets on new R2 uploads (lib/r2.ts).
      'Cache-Control': 'public, max-age=31536000, immutable',
      // A fixed `f` is part of the URL cache key, so Cloudflare cannot replay
      // a cached AVIF to a WebP client even though its current rule ignores
      // Vary. Existing no-`f` URLs keep Vary and their old Accept negotiation.
      ...imageVaryHeader(fixedFormat),
    },
  })
}
