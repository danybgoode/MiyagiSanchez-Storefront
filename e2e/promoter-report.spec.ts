import { expect, test } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { FEEDBACK_AUTHOR_KINDS, promoterFeedbackRow, validatePromoterReport } from '../lib/feedback'

// merchant-features-surfaced-by-promoter-kit S3.2 (D9) — a promoter's «Reportar» becomes a platform_feedback row.
const ROOT = path.resolve(import.meta.dirname, '..')
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8')

test.describe('promoter field reports (D9)', () => {
  test('only feature and bug are accepted, with the same message bounds as send_feedback', () => {
    expect(validatePromoterReport({ category: 'feature', message: '  Quiere cobrar con tarjeta  ' })).toEqual({
      ok: true, category: 'feature', message: 'Quiere cobrar con tarjeta',
    })
    expect(validatePromoterReport({ category: 'bug', message: 'no carga la foto' }).ok).toBe(true)
    expect(validatePromoterReport({ category: 'mcp-tool', message: 'algo largo aquí' }).ok).toBe(false)
    expect(validatePromoterReport({ category: 'feature', message: 'abc' }).ok).toBe(false)
    expect(validatePromoterReport({ category: 'feature', message: 'x'.repeat(2001) }).ok).toBe(false)
    expect(validatePromoterReport(null).ok).toBe(false)
  })

  test('the row is authored by the promoter, labelled with name and code', () => {
    const report = { category: 'bug' as const, message: 'no carga la foto' }
    expect(promoterFeedbackRow({ id: 'p-1', code: 'PRM-ANA', name: 'Ana' }, report)).toEqual({
      author_kind: 'promoter', author_id: 'p-1', author_label: 'Ana (PRM-ANA)', category: 'bug', tool_name: null, message: 'no carga la foto',
    })
    expect(promoterFeedbackRow({ id: 'p-2', code: 'PRM-X', name: null }, report).author_label).toBe('PRM-X')
    expect(FEEDBACK_AUTHOR_KINDS).toContain('promoter')
  })

  test('the route takes the author from the session, reads the insert back and answers ok only on a row', () => {
    const route = read('app/api/promoter/report/route.ts')
    expect(route).toContain('getPromoterByClerkId(user.id)')
    expect(route).toContain(".insert(row).select('id')")
    expect(route).toContain('!data?.length')
    // nothing the body says can name the author
    expect(route).not.toMatch(/body\??\.(author|promoter)/)
    expect(route).toContain("isEnabled('promoter.enabled')")
  })

  test('the panel carries the form, and /admin/feedback labels a promoter row', () => {
    expect(read('app/(shell)/promotor/cerrar/PromoterCloseClient.tsx')).toContain('<ReportStep')
    expect(read('app/(shell)/promotor/cerrar/ReportStep.tsx')).toContain("'/api/promoter/report'")
    expect(read('app/(shell)/admin/feedback/page.tsx')).toContain("promoter: 'Promotor'")
    for (const l of ['es', 'en']) {
      const copy = JSON.parse(read(`locales/${l}.json`)).promotorPanel.report
      expect(copy.done, l).toBeTruthy()
    }
    expect(JSON.parse(read('locales/es.json')).promotorPanel.report.done).toBe('Gracias, lo recibimos.')
  })

  test('a migration widens the author_kind CHECK to include promoter and keeps the other three', () => {
    const file = readdirSync(path.join(ROOT, 'supabase/migrations')).find((f) => f.includes('platform_feedback_promoter'))
    expect(file).toBeTruthy()
    const sql = read(`supabase/migrations/${file}`)
    expect(sql).toContain('platform_feedback_author_kind_check')
    expect(sql).toContain("CHECK (author_kind IN ('seller', 'partner', 'agent', 'promoter'))")
  })

  test('a Telegram rejection after the insert never turns a saved report into an error', () => {
    const route = read('app/api/promoter/report/route.ts')
    const at = route.indexOf('await tg.feedbackFiled')
    expect(at).toBeGreaterThan(-1)
    expect(route.lastIndexOf('try {', at)).toBeGreaterThan(route.indexOf(".insert(row)"))
    const after = route.slice(at)
    expect(after.indexOf('} catch')).toBeGreaterThan(-1)
    expect(after.slice(0, after.indexOf("ok: true"))).not.toMatch(/throw/)
    expect(after).toContain("NextResponse.json({ ok: true })")
  })

  test('reports are rate-limited per promoter, before the body is read, with a plain 429', () => {
    const route = read('app/api/promoter/report/route.ts')
    expect(route).toMatch(/checkRateLimit\('relationship', `promoter-report:\$\{promoter\.id\}`\)/)
    expect(route).toContain('status: 429')
    expect(route).toContain('Has enviado muchos reportes')
    expect(route.indexOf('checkRateLimit(')).toBeLessThan(route.indexOf('req.json()'))
    expect(route.indexOf('checkRateLimit(')).toBeGreaterThan(route.indexOf('getPromoterByClerkId'))
  })

  test('the Telegram alert for a promoter report has its own title, the others keep theirs', () => {
    const tgSrc = read('lib/telegram.ts')
    expect(tgSrc).toContain("authorKind === 'promoter' ? 'Reporte de promotor' : 'Feedback de agente'")
    expect(tgSrc).toContain('<b>${title}</b>')
  })
})
