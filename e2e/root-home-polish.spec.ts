import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_DESCRIPTION_CHARS } from '../lib/prompt-to-shop/blocks'
import { DESCRIBE_COPY } from '../lib/prompt-to-shop/copy'
import { nextTypewriterStep, TYPEWRITER_START, typewriterText, type TypewriterStep } from '../lib/prompt-to-shop/typewriter'
import { buildAnchorPageConfig } from '../app/(shell)/mx/vende/_components/page-config'

// root-shop-builder-home follow-up (product owner, 10-29): the describe box types its examples out, the domain proof
// point no longer leads with a free link, the bot check stays out of sight, and the AI section ends where its content
// does. Pure and source checks; the moving placeholder itself is a phone walkthrough step.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

test('the typewriter types a line, holds it, deletes it, then types the next — and wraps to the first', () => {
  const lines = ['ab', 'xyz'] as const
  let step: TypewriterStep = TYPEWRITER_START
  const shown: string[] = []
  for (let i = 0; i < 40 && shown.length < 14; i++) {
    const next = nextTypewriterStep(lines, step)
    step = next.step
    expect(next.delay).toBeGreaterThan(0)
    const text = typewriterText(lines, step)
    if (shown.at(-1) !== text) shown.push(text)
  }
  expect(shown).toEqual(['a', 'ab', 'a', '', 'x', 'xy', 'xyz', 'xy', 'x', '', 'a', 'ab', 'a', ''])
})

test('a full line is held long enough to read', () => {
  const full: TypewriterStep = { line: 0, chars: 3, phase: 'typing' }
  const hold = nextTypewriterStep(['abc'], full)
  expect(hold.step.phase).toBe('holding')
  expect(hold.delay).toBeGreaterThanOrEqual(1500)
})

test('every rotating example is a sendable description, and they are not the buttons\' text', () => {
  expect(DESCRIBE_COPY.rotatingExamples.length).toBeGreaterThanOrEqual(6)
  const buttons = new Set<string>(DESCRIBE_COPY.examples.map((e) => e.text))
  for (const line of DESCRIBE_COPY.rotatingExamples) {
    expect(line.length, line).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS)
    expect(buttons.has(line), line).toBe(false)
  }
})

test('the box animates its placeholder only while empty, and respects reduced motion', () => {
  const box = read('app/(shell)/mx/vende/_components/DescribeBox.tsx')
  expect(box).toContain('useRotatingPlaceholder(DESCRIBE_COPY.rotatingExamples, text.length === 0')
  expect(box).toContain('placeholder={rotating ?? DESCRIBE_COPY.placeholder}')
  expect(box).toContain('prefers-reduced-motion: reduce')
})

test('the domain proof point no longer promises a free link', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const copy = JSON.parse(read('locales/es.json')).sellerAcquisition as any
  const anchor = buildAnchorPageConfig(copy, {})
  const domain = anchor.proofPoints.find((p) => /dirección/.test(p.title))
  expect(domain, 'the address proof point is gone').toBeTruthy()
  expect(domain!.body).not.toMatch(/link gratis/i)
  expect(domain!.body).toMatch(/subdominio \(\$[\d,]+ MXN al año\)/)
})

test('the bot check renders only when Cloudflare needs a tap, and reserves no empty band', () => {
  const widget = read('app/(shell)/p2s/_components/TurnstileWidget.tsx')
  expect(widget).toContain("appearance: 'interaction-only'")
  expect(widget).not.toMatch(/min-h-\[65px\]/)
})

test('the AI section renders no empty eyebrow badge or note band', () => {
  const sections = read('app/(shell)/mx/vende/_components/SellerAcquisitionSections.tsx')
  const body = sections.slice(sections.indexOf('function AiChannelSection'), sections.indexOf('function SectionIntro'))
  expect(body.length).toBeGreaterThan(100)
  expect(body).toContain('{aiChannel.eyebrow ? (')
  expect(body).toContain('{aiChannel.note ? (')
})
