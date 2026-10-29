export type OutputFormat = 'avif' | 'webp' | 'jpeg'

export const TRANSFORM_WIDTHS = [64, 96, 128, 160, 256, 320, 384, 480, 640, 750, 828, 960, 1080, 1200, 1600, 1920] as const
// Union of the shipped route ladder and every width the old default Next
// config emitted. The out-of-ladder edge keys still map to the old snapped
// transform (32/48 → 64; 2048/3840 → 1920), so stale HTML remains valid.
export const LEGACY_KEY_WIDTHS = [32, 48, 64, 96, 128, 160, 256, 320, 384, 480, 640, 750, 828, 960, 1080, 1200, 1600, 1920, 2048, 3840] as const
export const LOADER_DEVICE_WIDTHS = [384, 640, 828, 1200, 1920] as const
export const LOADER_IMAGE_WIDTHS = [64, 96] as const
const LOADER_WIDTHS: readonly number[] = [...LOADER_IMAGE_WIDTHS, ...LOADER_DEVICE_WIDTHS]
export const LEGACY_QUALITIES = [60, 75, 90] as const

/**
 * The formats a versioned (`v=2`) key may pin. WebP is what every screen gets. JPEG exists for the PDF renderer only:
 * Chromium's PDF writer embeds a JPEG as-is but decodes a WebP and stores it losslessly, so a 6-product catalog sheet
 * of WebP photos came out at 12.6 MB and took 24 s to print (share-kit, 2026-10-29).
 */
export const FIXED_FORMATS = ['webp', 'jpeg'] as const
export type FixedFormat = (typeof FIXED_FORMATS)[number]

export type ImageVariant = {
  src: string
  width: number
  quality: number
  fixedFormat: FixedFormat | null
}

export type ImageVariantDecision =
  | { ok: true; variant: ImageVariant }
  | { ok: false; error: string }

function legacyTransformWidth(requested: number): number {
  for (const width of TRANSFORM_WIDTHS) if (width >= requested) return width
  return TRANSFORM_WIDTHS[TRANSFORM_WIDTHS.length - 1]
}

/**
 * Resolve only cache-key-canonical variants. Cloudflare keys the raw query,
 * before this route can normalize a width or quality; accepting aliases would let
 * many edge MISSes trigger the same Sharp encode. The legacy branch preserves
 * every URL the old custom loader actually emitted. The fixed branch accepts
 * only the one versioned shape emitted by the new loader.
 */
export function resolveImageVariant(
  searchParams: URLSearchParams,
  rawQuery = searchParams.toString(),
): ImageVariantDecision {
  const src = searchParams.get('url')
  const rawWidth = searchParams.get('w')
  const rawQuality = searchParams.get('q')
  if (!src || !rawWidth || !rawQuality) return { ok: false, error: 'Parámetros de imagen incompletos.' }

  try {
    const parsedSrc = new URL(src)
    // The live R2/Supabase public-image contract has no queries, fragments or
    // percent escapes. R2 serves an encoded path separator (%2F) as the same
    // object as '/', so accepting any percent spelling would reopen duplicate
    // edge keys for the same fetch and Sharp transform.
    if (
      // WHATWG exposes trailing empty `?` / `#` components as empty strings,
      // so inspect the source spelling too or those aliases survive.
      src.includes('?') ||
      src.includes('#') ||
      src.includes('%') ||
      parsedSrc.username ||
      parsedSrc.password ||
      parsedSrc.toString() !== src
    ) return { ok: false, error: 'URL de imagen no canónica.' }
  } catch {
    return { ok: false, error: 'URL de imagen inválida.' }
  }

  const width = Number(rawWidth)
  const quality = Number(rawQuality)
  const requestedFormat = searchParams.get('f')
  const fixed = requestedFormat !== null

  const fixedFormat = (FIXED_FORMATS as readonly string[]).includes(requestedFormat ?? '') ? (requestedFormat as FixedFormat) : null
  if (fixed && (!fixedFormat || searchParams.get('v') !== '2')) {
    return { ok: false, error: 'Formato de imagen no permitido.' }
  }

  const widths: readonly number[] = fixed ? LOADER_WIDTHS : LEGACY_KEY_WIDTHS
  if (!Number.isInteger(width) || String(width) !== rawWidth || !widths.includes(width)) {
    return { ok: false, error: 'Ancho de imagen no permitido.' }
  }
  if (!Number.isInteger(quality) || String(quality) !== rawQuality || (fixed ? quality !== 75 : !LEGACY_QUALITIES.includes(quality as 60 | 75 | 90))) {
    return { ok: false, error: 'Calidad de imagen no permitida.' }
  }

  const canonical = new URLSearchParams({ url: src, w: rawWidth, q: rawQuality })
  if (fixed && fixedFormat) {
    canonical.set('f', fixedFormat)
    canonical.set('v', '2')
  }
  if (rawQuery !== canonical.toString()) {
    return { ok: false, error: 'Parámetros de imagen no canónicos.' }
  }

  return { ok: true, variant: { src, width: fixed ? width : legacyTransformWidth(width), quality, fixedFormat: fixed ? fixedFormat : null } }
}

export function selectImageFormat(fixedFormat: FixedFormat | null, accept: string): OutputFormat {
  if (fixedFormat) return fixedFormat
  if (accept.includes('image/avif')) return 'avif'
  if (accept.includes('image/webp')) return 'webp'
  return 'jpeg'
}

export function imageVaryHeader(fixedFormat: FixedFormat | null): { Vary: 'Accept' } | Record<string, never> {
  return fixedFormat ? {} : { Vary: 'Accept' }
}
