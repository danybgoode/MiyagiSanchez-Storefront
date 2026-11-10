/**
 * The free months' notices (epic 08 · plans-gratis-negocio S2.3, README D10; plan-tienda-three-free-months S3.2,
 * README D8). Fifteen and five days before the end, then the end; each once; a paying shop gets none; the end
 * notice has a legacy variant (Plan Gratis) and a new-shop variant (paused), the latter only once the pause is claimed.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  decideTrialNotice,
  markNotified,
  noticeVariantFor,
  runTrialNotices,
  type TrialNoticeDeps,
  type TrialNoticeFacts,
  type TrialShop,
} from '../lib/negocio-trial-notices'
import { readNegocioTrial, NEGOCIO_TRIAL_KEY, type PlanLegacyState, type PlanState } from '../lib/plan'

const DAY = 86_400_000
const NOW = new Date('2026-12-08T15:00:00Z')
const trialEnding = (inDays: number) => ({ started_at: new Date(NOW.getTime() - (90 - inDays) * DAY).toISOString(), expires_at: new Date(NOW.getTime() + inDays * DAY).toISOString() })
const trialPlan = (t: { expires_at: string }): PlanState => ({ plan: 'trial', reason: 'trial', endsAt: t.expires_at })
const gratisEnded: PlanState = { plan: 'gratis', reason: 'trial_ended', endsAt: null }
const unpaid: PlanState = { plan: 'unpaid', reason: 'unpaid', endsAt: null }
const negocio: PlanState = { plan: 'negocio', reason: 'subscription', endsAt: null }
const tienda: PlanState = { plan: 'tienda', reason: 'tienda_one_time', endsAt: '2027-11-04T12:00:00.000Z' }
const unavailable: PlanState = { plan: 'gratis', reason: 'unavailable', endsAt: null }

const LEGACY: TrialNoticeFacts = { legacy: 'marked', planPaused: false, pausedAt: null }
const NEW: TrialNoticeFacts = { legacy: 'absent', planPaused: false, pausedAt: null }
const NEW_PAUSED = (pausedAt: string | null = new Date(NOW.getTime() - DAY).toISOString()): TrialNoticeFacts => ({ legacy: 'absent', planPaused: true, pausedAt })

test.describe('the reminders at 15 and at 5 days (D8)', () => {
  for (const facts of [LEGACY, NEW]) {
    test(`${facts.legacy}: 15 days, once; 5 days, once; nothing earlier`, () => {
      const t15 = trialEnding(15)
      expect(decideTrialNotice(t15, trialPlan(t15), NOW, facts)).toBe('fifteen_days')
      expect(decideTrialNotice(markNotified(t15, 'fifteen_days', NOW), trialPlan(t15), NOW, facts)).toBeNull()
      const t5 = trialEnding(5)
      expect(decideTrialNotice(markNotified(t5, 'fifteen_days', NOW), trialPlan(t5), NOW, facts)).toBe('five_days')
      expect(decideTrialNotice(markNotified(t5, 'five_days', NOW), trialPlan(t5), NOW, facts)).toBeNull()
      const early = trialEnding(16)
      expect(decideTrialNotice(early, trialPlan(early), NOW, facts)).toBeNull()
    })
  }

  test('a run that first looks inside five days sends «5 días», never a late «15 días»', () => {
    const t = trialEnding(4)
    expect(decideTrialNotice(t, trialPlan(t), NOW, NEW)).toBe('five_days')
  })

  test('the 15-day stamp is its own field, and survives a read', () => {
    const stamped = markNotified(trialEnding(15), 'fifteen_days', NOW)
    expect(stamped.notified_15d_at).toBe(NOW.toISOString())
    expect(stamped.notified_5d_at).toBeUndefined()
    expect(readNegocioTrial({ [NEGOCIO_TRIAL_KEY]: stamped })?.notified_15d_at).toBe(NOW.toISOString())
  })
})

test.describe('the end notice: two variants by the legacy marker', () => {
  test('which wording: only a known-ABSENT marker is a new shop; an unreadable one gets the legacy wording', () => {
    const cases: Array<[PlanLegacyState, string]> = [['marked', 'legacy'], ['unreadable', 'legacy'], ['absent', 'pause']]
    for (const [legacy, variant] of cases) expect(noticeVariantFor(legacy)).toBe(variant)
  })

  test('legacy, on Plan Gratis: «ya estás en Plan Gratis», once, and never for an end older than a week', () => {
    const ended = trialEnding(-1)
    expect(decideTrialNotice(ended, gratisEnded, NOW, LEGACY)).toBe('ended')
    expect(decideTrialNotice(markNotified(ended, 'ended', NOW), gratisEnded, NOW, LEGACY)).toBeNull()
    expect(decideTrialNotice(trialEnding(-9), gratisEnded, NOW, LEGACY)).toBeNull()
    // An unreadable marker resolves to Plan Gratis in derivePlan and gets the same notice.
    expect(decideTrialNotice(ended, gratisEnded, NOW, { ...LEGACY, legacy: 'unreadable' })).toBe('ended')
  })

  test('a new shop: the end notice goes only once the pause is claimed — never a «paused» that is not true', () => {
    const ended = trialEnding(-1)
    expect(decideTrialNotice(ended, unpaid, NOW, NEW)).toBeNull()
    expect(decideTrialNotice(ended, unpaid, NOW, NEW_PAUSED())).toBe('ended')
    expect(decideTrialNotice(markNotified(ended, 'ended', NOW), unpaid, NOW, NEW_PAUSED())).toBeNull()
  })

  test('a new shop paused late (the timer enabled weeks after the end) is told within a week of the PAUSE', () => {
    const ended = trialEnding(-20)
    expect(decideTrialNotice(ended, unpaid, NOW, NEW_PAUSED(new Date(NOW.getTime() - 2 * DAY).toISOString()))).toBe('ended')
    expect(decideTrialNotice(ended, unpaid, NOW, NEW_PAUSED(new Date(NOW.getTime() - 9 * DAY).toISOString()))).toBeNull()
    // An unreadable paused_at counts from the trial's end.
    expect(decideTrialNotice(ended, unpaid, NOW, NEW_PAUSED('garbage'))).toBeNull()
  })

  test('a legacy shop is never told it is paused, and a new shop is never told it is on Plan Gratis', () => {
    const ended = trialEnding(-1)
    expect(decideTrialNotice(ended, unpaid, NOW, LEGACY)).toBeNull()
    expect(decideTrialNotice(ended, gratisEnded, NOW, NEW_PAUSED())).toBeNull()
  })
})

test('a shop that paid, or whose plan could not be read, gets no notice at all', () => {
  for (const plan of [negocio, tienda, unavailable]) {
    for (const facts of [LEGACY, NEW, NEW_PAUSED()]) {
      expect(decideTrialNotice(trialEnding(3), plan, NOW, facts)).toBeNull()
      expect(decideTrialNotice(trialEnding(-1), plan, NOW, facts)).toBeNull()
    }
  }
})

const shopOf = (id: string, facts: TrialNoticeFacts = NEW): TrialShop => ({ id, slug: id, name: id.toUpperCase(), clerk_user_id: 'u', trial: trialEnding(4), rawTrial: {}, facts })

test('the runner claims before it sends; a lost claim sends nothing; an unreadable plan waits', async () => {
  const sent: string[] = []
  const shops = [shopOf('a'), shopOf('b'), shopOf('c')]
  const deps: TrialNoticeDeps = {
    readShops: async () => shops,
    readPlan: async (s) => (s.id === 'c' ? null : trialPlan(s.trial)),
    claim: async (s) => s.id === 'a',
    send: async (s, n) => { sent.push(`${s.id}:${n}`) },
    now: () => NOW,
  }
  expect(await runTrialNotices(deps)).toEqual({ ok: true, sent: 1, skipped: 1, unavailable: 1, failed: 0 })
  expect(sent).toEqual(['a:five_days'])
})

test('a run that cannot read the shops reports unavailable, never "nobody"', async () => {
  const deps = { readShops: async () => null } as unknown as TrialNoticeDeps
  expect(await runTrialNotices(deps)).toEqual({ ok: false, error: 'unavailable' })
})

test('a send that fails releases its claim, so the next run retries (Codex, #472)', async () => {
  const released: string[] = []
  const deps: TrialNoticeDeps = {
    readShops: async () => [shopOf('a')],
    readPlan: async (s) => trialPlan(s.trial),
    claim: async () => true,
    send: async () => { throw new Error('smtp down') },
    release: async (s, claimed) => { released.push(`${s.id}:${claimed.notified_5d_at ? '5d' : '?'}`) },
    now: () => NOW,
  }
  expect(await runTrialNotices(deps)).toMatchObject({ ok: true, sent: 0, failed: 1 })
  expect(released).toEqual(['a:5d'])
})

test('the runner decides with the facts read with each shop', async () => {
  const sent: string[] = []
  const paused = { ...shopOf('p', NEW_PAUSED()), trial: trialEnding(-1) }
  const notYet = { ...shopOf('q', NEW), trial: trialEnding(-1) }
  const deps: TrialNoticeDeps = {
    readShops: async () => [paused, notYet],
    readPlan: async () => unpaid,
    claim: async () => true,
    send: async (s, n) => { sent.push(`${s.id}:${n}`) },
    now: () => NOW,
  }
  await runTrialNotices(deps)
  expect(sent).toEqual(['p:ended'])
})

test.describe('the email copy', () => {
  const email = readFileSync('lib/email.ts', 'utf8')
  const start = email.indexOf('export async function sendNegocioTrialNotice')
  const body = email.slice(start, email.indexOf('\n}\n', start))
  /** The branches a NEW shop reads: everything outside the two `variant === 'legacy'` blocks. */
  const legacyBlocks = [...body.matchAll(/if \(ctx\.variant === 'legacy'\) \{[\s\S]*?\n {2,4}\}\n/g)].map((m) => m[0])
  const newShopText = legacyBlocks.reduce((acc, b) => acc.replace(b, ''), body)

  test('a new shop is told what happens at the end (a pause, nothing deleted) and is linked to pay', () => {
    expect(newShopText).toContain('Si no eliges ninguno, tu tienda se pausa: no se borra nada')
    expect(newShopText).toContain("h1('Tu tienda está en pausa')")
    expect(newShopText).toContain('No se borró nada.')
    expect(newShopText).toContain('«Tu suscripción»')
    expect(body).toContain('`${SITE}/shop/manage/negocio`')
  })
  test('the legacy shop keeps «Plan Gratis»; a new shop is never promised it', () => {
    expect(legacyBlocks).toHaveLength(2)
    expect(legacyBlocks.join('')).toContain('sigue abierta, ahora en el Plan Gratis')
    expect(legacyBlocks.join('')).toContain('pasa sola al Plan Gratis')
    expect(newShopText).not.toMatch(/Plan Gratis/)
  })
  test('prices come from their modules, never typed', () => {
    expect(body).not.toMatch(/\$\d/)
    expect(body).toContain('yearlyAsMonthly(TIENDA_PRICE_YEARLY_MXN)')
  })
  test('the welcome emails no longer promise a free shop', () => {
    expect(email).not.toContain('Abrir una tienda básica es gratis')
    expect(email).not.toContain('Tener una tienda básica es gratis')
    expect(email).not.toContain('A basic shop is free.')
  })
  test('the server shell passes the variant from the legacy marker and the pause claim', () => {
    const shell = readFileSync('lib/negocio-trial-notices-server.ts', 'utf8')
    expect(shell).toContain('variant: noticeVariantFor(shop.facts.legacy)')
    expect(shell).toContain('legacy: readPlanLegacyState(row.metadata)')
    expect(shell).toContain('planPaused: hasPlanPause(row.metadata)')
  })
})
