/**
 * A month of AI use per shop (epic 08 · plan-tienda-three-free-months S1.4, README D15).
 *
 * The report sets the plan allowances, so three things are pinned: it adds up what the ledger holds (and drops
 * nothing it cannot classify), it attributes each row the way the app records it (chat per shop slug, photos per
 * owner), and it NEVER prints a number for a cost nobody measured.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  CHAT_MONTH_SUBJECT_PREFIX,
  COST_NOT_LOGGED,
  PHOTO_SUBJECT_PREFIX,
  USAGE_KINDS,
  buildUsageReport,
  formatCost,
  formatUsageReport,
  parseArgs,
  type ShopRow,
  type UsageRow,
} from '../scripts/ai-usage-report'
import { userSubject } from '../lib/prompt-to-shop/allowance'

const MONTH = '2026-10'
const shop = (slug: string, owner: string | null, created_at = '2026-08-01T00:00:00+00:00'): ShopRow => ({ id: `id-${slug}`, slug, name: slug, clerk_user_id: owner, created_at })
const chat = (slug: string, used: unknown, period = MONTH): UsageRow => ({ subject: `${CHAT_MONTH_SUBJECT_PREFIX}${slug}`, kind: 'chat_month', period, used })
const photo = (owner: string, used: unknown, period = MONTH): UsageRow => ({ subject: userSubject(owner), kind: 'photo', period, used })

const shops = [shop('tamales-rosa', 'u_rosa'), shop('tacos-beto', 'u_beto'), shop('sin-uso', 'u_nadie'), shop('importada', null)]

test.describe('the subjects are the app\'s own', () => {
  test('the chat prefix is the one the handler spends against, and the photo prefix comes from userSubject', () => {
    expect(readFileSync('lib/shop-chat/handler.ts', 'utf8')).toContain('`' + CHAT_MONTH_SUBJECT_PREFIX + '${slug}`')
    expect(PHOTO_SUBJECT_PREFIX).toBe('user:')
    expect(userSubject('abc')).toBe(`${PHOTO_SUBJECT_PREFIX}abc`)
    expect(readFileSync('lib/shop-chat/server.ts', 'utf8')).toContain("p_kind: 'chat_month'")
    expect(readFileSync('lib/prompt-to-shop/photo-server.ts', 'utf8')).toContain("p_kind: 'photo'")
    expect([...USAGE_KINDS]).toEqual(['chat_month', 'photo'])
  })
})

test.describe('buildUsageReport', () => {
  test('per shop and in total: chat by slug, photos by owner, most used first', () => {
    const r = buildUsageReport(MONTH, [chat('tamales-rosa', 12), photo('u_rosa', 3), chat('tacos-beto', 40), photo('u_beto', 0)], shops)
    expect(r.lines.map((l) => [l.label, l.chat, l.photos])).toEqual([['tacos-beto', 40, 0], ['tamales-rosa', 12, 3]])
    expect(r.totals).toEqual({ chat: 52, photos: 3, costMxn: null })
    expect(r.shopsRead).toBe(4)
    expect(r.shopsWithoutUse).toBe(2)
    expect(r.unrecognised).toEqual([])
  })

  test('another month, or another kind of ledger row, is not counted', () => {
    const r = buildUsageReport(MONTH, [
      chat('tamales-rosa', 5), chat('tamales-rosa', 900, '2026-09'), photo('u_rosa', 50, '2026-11'),
      { subject: 'global', kind: 'daily_budget', period: MONTH, used: 700 },
      { subject: 'device:x', kind: 'version', period: MONTH, used: 3 },
    ], shops)
    expect(r.totals).toEqual({ chat: 5, photos: 0, costMxn: null })
    expect(r.lines).toHaveLength(1)
  })

  test('the slug match ignores case, and prints the shop\'s own slug', () => {
    const r = buildUsageReport(MONTH, [chat('Tamales-Rosa', 4)], shops)
    expect(r.lines.map((l) => l.label)).toEqual(['tamales-rosa'])
  })

  test('photos are per owner: an owner with several shops is shown on the oldest one, and the line says so', () => {
    const two = [shop('nueva', 'u_dos', '2026-09-01T00:00:00+00:00'), shop('vieja', 'u_dos', '2026-03-01T00:00:00+00:00')]
    const r = buildUsageReport(MONTH, [photo('u_dos', 7)], two)
    expect(r.lines).toEqual([{ label: 'vieja', chat: 0, photos: 7, costMxn: null, notes: ['las fotos se cuentan por dueño: incluye las de sus 2 tiendas'] }])
    expect(r.shopsWithoutUse).toBe(1)
  })

  test('use that matches no shop is LISTED with what it is, never dropped — the total always equals the ledger', () => {
    const r = buildUsageReport(MONTH, [
      chat('renombrada', 9), photo('u_fantasma', 2),
      { subject: 'shop_chat:shop:otro-formato', kind: 'chat_month', period: MONTH, used: 6 },
      { subject: 'photo_analysis:user:u_x', kind: 'photo', period: MONTH, used: 1 },
    ], shops)
    expect(r.lines.map((l) => [l.label, l.chat, l.photos, l.notes])).toEqual([
      ['renombrada', 9, 0, ['no hay una tienda con ese slug (¿se renombró o se borró?)']],
      ['user:u_fantasma', 0, 2, ['el dueño no tiene tienda']],
    ])
    expect(r.unrecognised).toEqual([
      { subject: 'shop_chat:shop:otro-formato', kind: 'chat_month', used: 6 },
      { subject: 'photo_analysis:user:u_x', kind: 'photo', used: 1 },
    ])
    expect(r.totals).toEqual({ chat: 15, photos: 3, costMxn: null })
    const listed = r.lines.reduce((n, l) => n + l.chat + l.photos, 0) + r.unrecognised.reduce((n, u) => n + u.used, 0)
    expect(listed).toBe(r.totals.chat + r.totals.photos)
  })

  test('a count that is not a whole number ≥ 0 refuses the report — it never adds up garbage', () => {
    for (const bad of [null, undefined, '12', 1.5, -1, [{ count: 3 }]]) {
      expect(() => buildUsageReport(MONTH, [chat('tamales-rosa', bad)], shops)).toThrow('no usable count')
    }
  })

  test('no cost is ever attached: it is not logged', () => {
    const r = buildUsageReport(MONTH, [chat('tamales-rosa', 12), photo('u_rosa', 3)], shops)
    expect(r.lines.every((l) => l.costMxn === null)).toBe(true)
    expect(r.totals.costMxn).toBeNull()
  })
})

test.describe('the printed report', () => {
  test('a table of shops with answers, photos and «no registrado» — never a zero for a cost that was not logged', () => {
    const out = formatUsageReport(buildUsageReport(MONTH, [chat('tamales-rosa', 12), photo('u_rosa', 3), chat('tacos-beto', 40)], shops))
    expect(out[0]).toBe('[ai:usage-report] 2026-10 (mes de Ciudad de México) — solo lectura')
    expect(out[1].trim().split(/\s{2,}/)).toEqual(['Tienda', 'Respuestas del chat', 'Fotos', 'Costo'])
    expect(out[2].trim().split(/\s{2,}/)).toEqual(['tacos-beto', '40', '0', 'no registrado'])
    expect(out[3].trim().split(/\s{2,}/)).toEqual(['tamales-rosa', '12', '3', 'no registrado'])
    expect(out[4].trim().split(/\s{2,}/)).toEqual(['TOTAL', '52', '3', 'no registrado'])
    const text = out.join('\n')
    expect(text).toContain('2 de 4 tiendas no usaron chat ni fotos en 2026-10.')
    expect(text).toContain('Costo «no registrado»')
    expect(text).not.toMatch(/\$\s?0/)
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('NaN')
  })

  test('formatCost: null is «no registrado», a measured cost is pesos — an unmeasured cost is never "$0.00"', () => {
    expect(formatCost(null)).toBe(COST_NOT_LOGGED)
    expect(COST_NOT_LOGGED).toBe('no registrado')
    expect(formatCost(12.5)).toBe('$12.50')
  })

  test('notes and unclassified rows are printed', () => {
    const out = formatUsageReport(buildUsageReport(MONTH, [chat('renombrada', 9), { subject: 'x', kind: 'photo', period: MONTH, used: 4 }], shops)).join('\n')
    expect(out).toContain('* renombrada: no hay una tienda con ese slug')
    expect(out).toContain('(sin clasificar) x')
    expect(out).toContain('1 fila(s) sin clasificar')
  })

  test('a month with no use says so in words, after a read that worked — never an empty table', () => {
    const out = formatUsageReport(buildUsageReport(MONTH, [], shops))
    expect(out).toHaveLength(3)
    expect(out[1]).toContain('Sin uso registrado en 2026-10: la lectura funcionó')
    expect(out[1]).toContain('4 tiendas leídas')
    expect(out[2]).toBe('  Costo: no registrado.')
  })
})

test.describe('the script shell', () => {
  const src = readFileSync('scripts/ai-usage-report.ts', 'utf8')

  test('--month YYYY-MM is required and validated; --dry-run is accepted; anything else is fatal', () => {
    expect(parseArgs(['--month', '2026-10'])).toEqual({ ok: true, month: '2026-10' })
    expect(parseArgs(['--month=2026-01', '--dry-run'])).toEqual({ ok: true, month: '2026-01' })
    expect(parseArgs(['--dry-run', '--month', '2026-12'])).toEqual({ ok: true, month: '2026-12' })
    for (const bad of [[], ['--dry-run'], ['--month'], ['--month', '2026-13'], ['--month', '2026-00'], ['--month', '2026-1'], ['--month', 'octubre'], ['--month', '2026-10-01'], ['--mes', '2026-10'], ['--month', '2026-10', '--apply']]) {
      expect({ bad, ok: parseArgs(bad).ok }).toEqual({ bad, ok: false })
    }
  })

  test('it is read-only: no write and no RPC anywhere in the file', () => {
    expect(src).not.toMatch(/\.(rpc|update|upsert|insert|delete)\(/)
    expect(src.match(/\.from\('/g)).toHaveLength(2)
  })

  test('both tables are read through the paged reader, the ledger filtered to the month and the two kinds', () => {
    expect(src.match(/readAllPages</g)).toHaveLength(2)
    expect(src.match(/\.range\(from, to\)/g)).toHaveLength(2)
    expect(src).toContain(".eq('period', parsed.month)")
    expect(src).toContain(".in('kind', [...USAGE_KINDS])")
    expect(src).toContain("select('subject, kind, period, used:count')")
    expect(src).toContain("process.argv[1]?.endsWith('ai-usage-report.ts')")
  })
})
