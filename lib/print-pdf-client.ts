/**
 * Shared client for the PDF renderer (US-5b; since share-kit S2.1 a container
 * beside the app on the Oracle VM at `PRINT_PDF_URL=http://print-pdf:8080`):
 * headless Chromium loads one of our print pages and streams back a
 * print-ready PDF. Every `/api/.../pdf` route proxies through this one
 * function so the env-var / error-shape contract never drifts between
 * callers (the edition PDF, the rate card, the shop catalog).
 *
 * The renderer itself refuses any URL off its allow-list (403), and answers
 * 503 `busy` when its one-at-a-time queue is full — both surface here as a
 * failed render, never a hang: the call is bounded by RENDER_CLIENT_TIMEOUT_MS.
 */
import 'server-only'

export interface RenderPrintPdfResult {
  ok: boolean
  /** HTTP status the caller should surface (503 = not configured, 502 = render failed). */
  status?: number
  buffer?: ArrayBuffer
  error?: string
}

/** Just above the renderer's own 45 s budget, and inside the 60 s the calling routes allow. */
const RENDER_CLIENT_TIMEOUT_MS = 55_000

export async function renderPrintPdf(printUrl: string): Promise<RenderPrintPdfResult> {
  const service = process.env.PRINT_PDF_URL
  const secret = process.env.PRINT_PDF_SECRET
  if (!service || !secret) {
    return { ok: false, status: 503, error: 'Servicio PDF no configurado (PRINT_PDF_URL / PRINT_PDF_SECRET).' }
  }

  let r: Response
  try {
    r = await fetch(`${service.replace(/\/$/, '')}/pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
      body: JSON.stringify({ url: printUrl }),
      signal: AbortSignal.timeout(RENDER_CLIENT_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch (e) {
    return { ok: false, status: 502, error: `No se pudo contactar el servicio PDF (${(e as Error).name})` }
  }
  if (!r.ok) {
    // The status only: a renderer body is never relayed, because some print URLs carry a secret (verifier, PR 448).
    return { ok: false, status: 502, error: `Render falló (${r.status})` }
  }

  return { ok: true, buffer: await r.arrayBuffer() }
}
