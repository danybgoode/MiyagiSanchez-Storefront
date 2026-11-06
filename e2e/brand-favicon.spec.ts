/**
 * The tab, bookmark and search-result icon is the Miyagi Sánchez mark, never Vercel's (Daniel, 2026-11-05: "the
 * favicon is the vercel one instead of our brand, please fix it for good").
 *
 * Why it kept coming back: `app/favicon.ico` was Create Next App's default (the Vercel triangle) from the first commit
 * and was never replaced. Next.js lists it FIRST among the page's icons (as 256×256), and browsers and Google request
 * `/favicon.ico` before anything else, so it beat our `icon.svg` everywhere it mattered. It is now the brand mark at
 * 16, 32 and 48 px, rendered from `app/icon.svg`.
 */
import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** sha256 of the Create Next App default favicon.ico (the Vercel triangle) this file shipped with until 2026-11-05. */
const VERCEL_DEFAULT_SHA256 = '2b8ad2d33455a8f736fc3a8ebf8f0bdea8848ad4c0db48a2833bd0f9cd775932'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('app/favicon.ico is the brand mark: a real ICO with 16, 32 and 48 px images, and not the Vercel default', () => {
  const ico = readFileSync('app/favicon.ico')
  expect(createHash('sha256').update(ico).digest('hex')).not.toBe(VERCEL_DEFAULT_SHA256)
  // ICONDIR: reserved 0, type 1 (icon), then the image count.
  expect(ico.readUInt16LE(0)).toBe(0)
  expect(ico.readUInt16LE(2)).toBe(1)
  const count = ico.readUInt16LE(4)
  const sizes: number[] = []
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16
    sizes.push(ico.readUInt8(entry) || 256)
    const length = ico.readUInt32LE(entry + 8)
    const offset = ico.readUInt32LE(entry + 12)
    expect(offset + length).toBeLessThanOrEqual(ico.length)
    expect(ico.subarray(offset, offset + 8).equals(PNG_SIGNATURE)).toBe(true)
  }
  expect(sizes).toEqual([16, 32, 48])
})

test('no page links an apple-touch icon file that does not exist', () => {
  // `/apple-icon.png` was never a file (404); the generated route is `/apple-icon` (app/apple-icon.tsx).
  const doc = readFileSync('app/components/MarketDocument.tsx', 'utf8')
  expect(doc).not.toContain('/apple-icon.png')
  expect(doc).toContain('href="/apple-icon"')
})
