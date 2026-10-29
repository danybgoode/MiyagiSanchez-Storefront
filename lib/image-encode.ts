import sharp from 'sharp'
import type { OutputFormat } from './image-variant'

/**
 * The `/api/img` encode step, outside the route so a spec can run it on real pixels (relative imports, no next/*).
 *
 * JPEG has no alpha channel: sharp writes a transparent pixel as black, so a transparent PNG logo or a cut-out
 * product photo printed on a black square in the catalog PDF (verifier, PR 450). JPEG output is flattened onto white
 * first, the paper colour of every print page and the page colour a JPEG fallback is shown on.
 */
export async function encodeImage(
  source: Buffer,
  { width, quality, format }: { width: number; quality: number; format: OutputFormat },
): Promise<{ body: Buffer; contentType: string }> {
  // rotate() applies EXIF orientation before resizing; withoutEnlargement never upscales a source smaller than the
  // requested width (no manufactured detail).
  const pipeline = sharp(source).rotate().resize({ width, withoutEnlargement: true })
  if (format === 'avif') return { body: await pipeline.avif({ quality }).toBuffer(), contentType: 'image/avif' }
  if (format === 'webp') return { body: await pipeline.webp({ quality }).toBuffer(), contentType: 'image/webp' }
  return {
    body: await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer(),
    contentType: 'image/jpeg',
  }
}
