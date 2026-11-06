/**
 * Every enabled button shows the pointer (Daniel, 2026-11-05: "the buttons don't seem clickable, they don't change the
 * pointer on hover"). Tailwind v4's preflight resets buttons to `cursor: default`; the fix is one base-layer rule in
 * app/globals.css, so a raw-Tailwind button gets the pointer without opting in, and a disabled one keeps the arrow.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const css = readFileSync('app/globals.css', 'utf8')

test('globals.css gives every enabled button, role=button and file picker the pointer, in the base layer', () => {
  const start = css.indexOf('@layer base {')
  expect(start).toBeGreaterThan(-1)
  // The rule must come before any other layer, so utilities like `cursor-not-allowed` still override it.
  const block = css.slice(start, css.indexOf('}\n}', start) + 3)
  for (const selector of ['button:not(:disabled)', '[role="button"]:not([aria-disabled="true"])', 'input[type="file"]:not(:disabled)::file-selector-button']) {
    expect(block).toContain(selector)
  }
  expect(block).toContain('cursor: pointer;')
  // A disabled button is never given the pointer.
  expect(block).not.toMatch(/^\s*button\s*,|^\s*button\s*\{/m)
})
