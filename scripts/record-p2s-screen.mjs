#!/usr/bin/env node
/**
 * Records Jev's answers for the screen's labelled set (epic one-front-door-both-markets D3).
 *
 * The spec `e2e/p2s-screen.spec.ts` never calls the live model: it replays THESE recorded answers through
 * `decideScreen` and asserts each case's expected verdict, so the thresholds are pinned against real model output
 * without a network call in CI. Re-run this when `SCREEN_QUESTIONS` changes (the file stores the questions it was
 * recorded with, and the spec fails when they differ — a recording of other questions proves nothing).
 *
 *   TYPESAFE_API_KEY=… node scripts/record-p2s-screen.mjs
 *
 * Fails loudly (exit 1) without a key or on any failed call: a partial recording would read as a full one.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const key = process.env.TYPESAFE_API_KEY
if (!key) {
  console.error('record-p2s-screen: TYPESAFE_API_KEY is not set — nothing recorded')
  process.exit(1)
}

// The questions are read from the TS source by text so this script needs no TS toolchain.
const src = readFileSync(join(root, 'lib/prompt-to-shop/screen.ts'), 'utf8')
const block = src.slice(src.indexOf('export const SCREEN_QUESTIONS = '), src.indexOf('} as const', src.indexOf('export const SCREEN_QUESTIONS = ')) + 1)
const questions = Function(`return (${block.replace('export const SCREEN_QUESTIONS = ', '')})`)()

const cases = JSON.parse(readFileSync(join(root, 'e2e/fixtures/p2s-screen-cases.json'), 'utf8'))
const out = []
for (const c of cases) {
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state: { merchant_description: c.text }, questions }),
  })
  if (!res.ok) {
    console.error(`record-p2s-screen: HTTP ${res.status} on «${c.text.slice(0, 40)}» — aborting, nothing written`)
    process.exit(1)
  }
  const json = await res.json()
  out.push({ ...c, response: { model: json.model, answers: json.answers } })
  process.stdout.write('.')
}
writeFileSync(
  join(root, 'e2e/fixtures/p2s-screen-recorded.json'),
  JSON.stringify({ recorded_at: new Date().toISOString().slice(0, 10), questions, cases: out }, null, 2) + '\n',
)
console.log(`\nrecorded ${out.length} cases`)
