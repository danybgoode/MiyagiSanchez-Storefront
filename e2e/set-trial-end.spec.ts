/**
 * The smoke-test aid that moves one test shop's trial end (plan-tienda-three-free-months, sprint-3 walkthrough step 2).
 * Pure: argument parsing, the «prueba»/«test» refusal, and what the write would be.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { looksLikeTestShop, parseArgs, planTrialEnd } from '../scripts/set-trial-end'
import { NEGOCIO_TRIAL_KEY } from '../lib/plan'

const trial = { started_at: '2026-11-10T12:00:00.000Z', expires_at: '2027-02-08T12:00:00.000Z', notified_15d_at: '2027-01-24T12:00:00.000Z', notified_end_at: '2027-02-08T13:00:00.000Z' }
const shop = (name: string, slug: string, metadata: unknown = { [NEGOCIO_TRIAL_KEY]: trial }) => ({ id: 'shop_1', name, slug, metadata })

test('arguments: shop and an ISO instant with a zone are required; dry run is the default; unknown flags refuse', () => {
  expect(parseArgs(['--shop', 's', '--trial-end', '2026-11-09T12:00:00Z'])).toEqual({ ok: true, shopId: 's', trialEnd: '2026-11-09T12:00:00.000Z', apply: false, force: false })
  expect(parseArgs(['--shop=s', '--trial-end=2026-11-09T06:00:00-06:00', '--apply', '--force'])).toEqual({ ok: true, shopId: 's', trialEnd: '2026-11-09T12:00:00.000Z', apply: true, force: true })
  expect(parseArgs(['--trial-end', '2026-11-09T12:00:00Z']).ok).toBe(false)
  expect(parseArgs(['--shop', 's']).ok).toBe(false)
  expect(parseArgs(['--shop', 's', '--trial-end', '2026-11-09']).ok).toBe(false)
  expect(parseArgs(['--shop', 's', '--trial-end', '2026-11-09T12:00:00']).ok).toBe(false)
  expect(parseArgs(['--shop', 's', '--trial-end', '2026-11-09T12:00:00Z', '--yes']).ok).toBe(false)
})

test('a shop whose name and slug lack «prueba» or «test» is refused unless --force', () => {
  expect(looksLikeTestShop({ name: 'Tienda de Prueba', slug: 'x' })).toBe(true)
  expect(looksLikeTestShop({ name: 'Mi tienda', slug: 'qa-test-1' })).toBe(true)
  expect(looksLikeTestShop({ name: 'Panadería Lupita', slug: 'panaderia-lupita' })).toBe(false)
  // Whole words only: a real shop that merely CONTAINS the letters is not a test shop.
  expect(looksLikeTestShop({ name: 'Contestar rápido', slug: 'contestar' })).toBe(false)
  expect(looksLikeTestShop({ name: 'La protesta', slug: 'protesta-mx' })).toBe(false)
  expect(looksLikeTestShop({ name: 'Pruebas de sabor', slug: 'pruebasdesabor' })).toBe(false)
  expect(looksLikeTestShop({ name: 'TEST', slug: 'x' })).toBe(true)
  expect(looksLikeTestShop({ name: 'x', slug: 'mi-prueba' })).toBe(true)
  expect(planTrialEnd(shop('Panadería Lupita', 'panaderia-lupita'), '2026-11-09T12:00:00.000Z', false).ok).toBe(false)
  expect(planTrialEnd(shop('Panadería Lupita', 'panaderia-lupita'), '2026-11-09T12:00:00.000Z', true).ok).toBe(true)
})

test('the new end is written, the end notice can fire again, the 15-day stamp is kept, and a start after the end moves', () => {
  const p = planTrialEnd(shop('prueba', 'prueba'), '2026-11-09T12:00:00.000Z', false)
  if (!p.ok) throw new Error(p.error)
  expect(p.after).toEqual({ started_at: '2026-11-09T12:00:00.000Z', expires_at: '2026-11-09T12:00:00.000Z', notified_15d_at: trial.notified_15d_at })
  expect(p.rawTrial).toBe(trial)
})

test('a shop with no trial is refused: there is nothing to move', () => {
  expect(planTrialEnd(shop('prueba', 'prueba', {}), '2026-11-09T12:00:00.000Z', false).ok).toBe(false)
})

test('the write is guarded on the trial exactly as read, and the dry run writes nothing', () => {
  const src = readFileSync('scripts/set-trial-end.ts', 'utf8')
  expect(src).toMatch(/p_guard_mode: 'equals',\s*p_expected: plan\.rawTrial/)
  expect(src.indexOf("if (!args.apply)")).toBeLessThan(src.indexOf("db.rpc('merge_shop_metadata'"))
})
