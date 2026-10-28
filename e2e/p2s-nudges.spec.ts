import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EVENT_GROUP, EVENT_GROUPS, GROUP_COPY, BUYER_EVENT_GROUPS, type PrefRow } from '../lib/notifications/preferences'
import { COMMUNICATION_CATALOG } from '../lib/notifications/catalog'
import {
  dueDay,
  nextNudgeStep,
  runNudgeCron,
  selectNudges,
  sentNudges,
  withNudge,
  type NudgeCandidate,
  type NudgeCronDeps,
} from '../lib/prompt-to-shop/nudges'
import { getSetupSteps } from '../lib/setup-guide'

// Prompt-to-shop S5.4 — the day 1/3/7 nudges (HIGH risk: it messages merchants on a schedule). The selection is
// pure and the cron order is driven with fakes: authorise → read → decide → CLAIM → send. Every effect lands in one
// trace and the specs assert its ORDER.

const ROOT = process.cwd()
const NOW = new Date('2026-11-10T15:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * 3600_000).toISOString()

const SHOP_ROW = { name: 'Tamales', description: 'Hechos a mano', metadata: { settings: {} }, mp_enabled: true, custom_domain: null, ucp_webhook_url: null }
const STEPS = getSetupSteps({ shop: SHOP_ROW as never, productCount: 0, shareDone: false })

function candidate(over: Partial<NudgeCandidate> = {}): NudgeCandidate {
  return {
    draftId: 'd1',
    shopName: 'Tamales',
    claimedBy: 'user_1',
    claimedAt: ago(1, 2),
    email: null,
    sent: {},
    published: false,
    steps: STEPS,
    prefs: [],
    ...over,
  }
}

const one = (c: NudgeCandidate) => selectNudges(NOW, [c])[0]

test('the milestones are day 1, 3 and 7 after the keep — nothing before day 1, nothing past day 7', () => {
  expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 30].map(dueDay)).toEqual([null, 1, 1, 3, 3, 3, 3, 7, null, null])
  expect(one(candidate({ claimedAt: ago(0, 20) }))).toEqual({ draftId: 'd1', skip: 'too_early' })
  expect(one(candidate({ claimedAt: ago(1, 1) }))).toMatchObject({ send: { day: 1 } })
  expect(one(candidate({ claimedAt: ago(3, 1), sent: { 1: ago(2) } }))).toMatchObject({ send: { day: 3 } })
  expect(one(candidate({ claimedAt: ago(7, 1), sent: { 1: ago(6), 3: ago(4) } }))).toMatchObject({ send: { day: 7 } })
  expect(one(candidate({ claimedAt: ago(8, 1) }))).toEqual({ draftId: 'd1', skip: 'past_day_7' })
})

test('never twice, and never a stale milestone late', () => {
  expect(one(candidate({ claimedAt: ago(1, 5), sent: { 1: ago(0, 3) } }))).toEqual({ draftId: 'd1', skip: 'already_sent' })
  // Day 2: the day-1 nudge already went, nothing new is due.
  expect(one(candidate({ claimedAt: ago(2, 5), sent: { 1: ago(1) } }))).toEqual({ draftId: 'd1', skip: 'already_sent' })
  // Day 3, day 1 never went (a missed run): day 3 goes, day 1 is not sent late.
  expect(one(candidate({ claimedAt: ago(3, 5), sent: {} }))).toMatchObject({ send: { day: 3 } })
  // A later milestone recorded covers an earlier one.
  expect(one(candidate({ claimedAt: ago(4), sent: { 7: ago(0) } }))).toEqual({ draftId: 'd1', skip: 'already_sent' })
})

test('nothing after publish, and nothing when we could not tell', () => {
  expect(one(candidate({ published: true }))).toEqual({ draftId: 'd1', skip: 'published' })
  expect(one(candidate({ published: null }))).toEqual({ draftId: 'd1', skip: 'state_unavailable' })
  expect(one(candidate({ steps: null }))).toEqual({ draftId: 'd1', skip: 'state_unavailable' })
  expect(one(candidate({ steps: [] }))).toEqual({ draftId: 'd1', skip: 'state_unavailable' })
  expect(one(candidate({ prefs: null }))).toEqual({ draftId: 'd1', skip: 'state_unavailable' })
})

test('an unclaimed draft without an email gets none — and S3 never stores one', () => {
  expect(one(candidate({ claimedBy: null, claimedAt: null, email: null }))).toEqual({ draftId: 'd1', skip: 'not_kept' })
  expect(one(candidate({ claimedBy: null, claimedAt: null, email: 'ana@example.mx' }))).toEqual({ draftId: 'd1', skip: 'not_kept' })
  // A timestamp with nobody holding the keep (a released claim) is still not a kept draft.
  expect(one(candidate({ claimedBy: null, claimedAt: ago(1, 2), email: null }))).toEqual({ draftId: 'd1', skip: 'not_kept' })
  // The premise, held in code: «Mándame el enlace» sends the email and keeps no copy of the address.
  const mail = readFileSync(join(ROOT, 'lib/prompt-to-shop/mail-link.ts'), 'utf8')
  const route = readFileSync(join(ROOT, 'app/api/p2s/link/[id]/route.ts'), 'utf8')
  for (const src of [mail, route]) expect(src).not.toMatch(/\.from\(|\.update\(|\.insert\(|\.upsert\(/)
  // …and the cron only ever reads drafts that were kept.
  const server = readFileSync(join(ROOT, 'lib/prompt-to-shop/nudges-server.ts'), 'utf8')
  expect(server).toContain(".not('claimed_by', 'is', null)")
  expect(server).toContain(".not('claimed_seller_id', 'is', null)")
})

test('preference-respecting: every onboarding channel off is skipped before any claim', () => {
  const off: PrefRow[] = [
    { channel: 'email', event_group: 'onboarding', enabled: false },
    { channel: 'push', event_group: 'onboarding', enabled: false },
  ]
  expect(one(candidate({ prefs: off }))).toEqual({ draftId: 'd1', skip: 'opted_out' })
  // Another group switched off does not silence this one; Telegram alone switched on still reaches the merchant.
  expect(one(candidate({ prefs: [{ channel: 'email', event_group: 'orders', enabled: false }] }))).toMatchObject({ send: { day: 1 } })
  expect(one(candidate({ prefs: [...off, { channel: 'telegram', event_group: 'onboarding', enabled: true }] }))).toMatchObject({ send: { day: 1 } })
  // The send goes through the dispatch seam with the onboarding group, which applies the grid per channel.
  const server = readFileSync(join(ROOT, 'lib/prompt-to-shop/nudges-server.ts'), 'utf8')
  expect(server).toContain('dispatchToSeller(clerkUserId, {')
  expect(server).toContain("group: 'onboarding'")
})

test('the message names the ONE next step, from the checklist getSetupSteps builds', () => {
  expect(STEPS.map((s) => s.id)).toEqual(['perfil', 'catalogo', 'pagos', 'envios', 'comparte'])
  // perfil done (name + description) → Fotos is next.
  expect(one(candidate())).toMatchObject({ send: { step: 'catalogo', clerkUserId: 'user_1', shopName: 'Tamales' } })
  const allDone = STEPS.map((s) => ({ ...s, done: true }))
  expect(nextNudgeStep(allDone)).toBe('publicar')
  expect(nextNudgeStep([])).toBeNull()
})

test('the record merges into block_status: S4\'s photo confirms and the block statuses survive', () => {
  const before = { identity: 'ok', words: 'fallback', photo_confirms: { abc: { state: 'created' } }, nudges: { 1: '2026-11-09T15:00:00Z' } }
  expect(withNudge(before, 3, '2026-11-11T15:00:00Z')).toEqual({ ...before, nudges: { 1: '2026-11-09T15:00:00Z', 3: '2026-11-11T15:00:00Z' } })
  expect(withNudge(before, 1, 'x')).toBeNull()
  expect(withNudge(null, 1, 'x')).toEqual({ nudges: { 1: 'x' } })
  expect(sentNudges(before)).toEqual({ 1: '2026-11-09T15:00:00Z' })
  expect(sentNudges({ nudges: [1, 2] })).toEqual({})
})

// ── The cron ─────────────────────────────────────────────────────────────────────────────────────────────────────

function cron(candidates: NudgeCandidate[] | null, claimOk: (id: string) => boolean = () => true) {
  const trace: string[] = []
  const deps: NudgeCronDeps = {
    loadCandidates: async () => { trace.push('load'); return candidates },
    claim: async (id, day) => { trace.push(`claim:${id}:${day}`); return claimOk(id) },
    send: async (n) => { trace.push(`send:${n.draftId}:${n.day}:${n.step}`) },
    now: () => NOW,
  }
  return { trace, deps }
}
const AUTH = { secretHeader: 's3cret', secretQuery: null, cronSecret: 's3cret' }

test('the cron refuses without the secret, before reading anything', async () => {
  for (const input of [
    { secretHeader: null, secretQuery: null, cronSecret: 's3cret' },
    { secretHeader: 'wrong', secretQuery: null, cronSecret: 's3cret' },
    { secretHeader: null, secretQuery: 'wrong', cronSecret: 's3cret' },
    // An unset CRON_SECRET refuses everything, a missing header included.
    { secretHeader: null, secretQuery: null, cronSecret: undefined },
    { secretHeader: '', secretQuery: null, cronSecret: '' },
  ]) {
    const { trace, deps } = cron([candidate()])
    expect(await runNudgeCron(input, deps)).toEqual({ status: 401, body: { ok: false, error: 'unauthorized' } })
    expect(trace).toEqual([])
  }
  // The query form the other cron routes accept is accepted too.
  const { deps } = cron([])
  expect((await runNudgeCron({ secretHeader: null, secretQuery: 's3cret', cronSecret: 's3cret' }, deps)).status).toBe(200)
  // The route hands the header and the env secret to it, exactly.
  const route = readFileSync(join(ROOT, 'app/api/cron/p2s-nudges/route.ts'), 'utf8')
  expect(route).toContain("req.headers.get('x-cron-secret')")
  expect(route).toContain('process.env.CRON_SECRET')
})

test('order: read → decide → claim THEN send; a lost claim sends nothing', async () => {
  const { trace, deps } = cron(
    [candidate({ draftId: 'a' }), candidate({ draftId: 'b', published: true }), candidate({ draftId: 'c' }), candidate({ draftId: 'd', claimedAt: ago(3, 1) })],
    (id) => id !== 'c',
  )
  const r = await runNudgeCron(AUTH, deps)
  expect(trace).toEqual(['load', 'claim:a:1', 'send:a:1:catalogo', 'claim:c:1', 'claim:d:3', 'send:d:3:catalogo'])
  expect(r).toEqual({ status: 200, body: { ok: true, candidates: 4, sent: 2, lost: 1, skipped: { published: 1 } } })
})

test('a run that could not read answers 503, never an empty success', async () => {
  const { trace, deps } = cron(null)
  expect(await runNudgeCron(AUTH, deps)).toEqual({ status: 503, body: { ok: false, error: 'unavailable' } })
  expect(trace).toEqual(['load'])
})

test('onboarding is a seller group, wired and described; the reminder is in the catalog under it', () => {
  expect(EVENT_GROUPS).toContain('onboarding')
  expect(BUYER_EVENT_GROUPS as readonly string[]).not.toContain('onboarding')
  expect(EVENT_GROUP.p2s_nudge).toBe('onboarding')
  expect(GROUP_COPY.onboarding.label.length).toBeGreaterThan(0)
  const entry = COMMUNICATION_CATALOG.find((c) => c.key === 'shop.p2s_nudge')
  expect(entry).toMatchObject({ sender: 'sendP2sNudge', group: 'onboarding', to: 'seller', origin: 'lib/prompt-to-shop/nudges-server.ts' })
})
