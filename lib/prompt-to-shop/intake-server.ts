/**
 * The intake routes' real I/O (epic one-front-door-both-markets D6–D8). Every decision is in `intake-handler.ts`.
 *
 * Outbound fetches of a stranger's URL go through `pinnedFetch` (DNS pinned, private addresses refused) with
 * redirects followed BY HAND, each hop re-pinned, at most `INTAKE_MAX_REDIRECTS` — a plain `fetch` would follow a
 * redirect to 169.254.169.254 without asking.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'
import { db } from '@/lib/supabase'
import { checkRateLimit } from '@/lib/ratelimit'
import { uploadToR2, isR2Configured } from '@/lib/r2'
import { pinnedFetch } from '@/lib/ssrf-fetch'
import { CATALOG_CATEGORY_KEYS, buildExtractionPrompt } from '@/lib/catalog-import'
import { budgetPeriod } from './allowance'
import { verifyTurnstile } from './turnstile'
import { screenText } from './screen'
import { screenDeps } from './screen-server'
import { callModelBody, MODEL_CONFIGURED } from './server'
import { ANON_INTAKE, readCappedBody, zipDeclaredUncompressedSize, XLSX_MAX_UNCOMPRESSED, SEED_ROWS_MAX, INTAKE_FETCH_TIMEOUT_MS, INTAKE_MAX_REDIRECTS, INTAKE_PAGE_MAX_BYTES, nextHop, resolveAnonIntakeBudget } from './intake'
import type { IntakeDeps } from './intake-handler'

const VISION_TIMEOUT_MS = 25_000

async function readCapped(res: { headers: { get: (k: string) => string | null }; body: unknown }, max: number): Promise<Uint8Array | null> {
  return readCappedBody(res.body as ReadableStream<Uint8Array> | null, res.headers.get('content-length'), max)
}

/** GET a public URL through the pinned fetch, following at most N redirects by hand. Null on anything but a 200. */
async function pinnedGet(url: string, accept: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  let current = url
  for (let hop = 0; hop <= INTAKE_MAX_REDIRECTS; hop++) {
    const res = await pinnedFetch(new URL(current), {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: accept, 'User-Agent': 'MiyagiSanchezShopBuilder/1.0 (+https://miyagisanchez.com)' },
      signal: AbortSignal.timeout(INTAKE_FETCH_TIMEOUT_MS),
    })
    if (res.status >= 300 && res.status < 400) {
      const next = nextHop(current, res.headers.get('location'))
      await res.body?.cancel().catch(() => {})
      if (!next) return null
      current = next
      continue
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {})
      return null
    }
    const bytes = await readCapped(res, INTAKE_PAGE_MAX_BYTES)
    return bytes ? { bytes, type: res.headers.get('content-type') ?? '' } : null
  }
  return null
}

async function spendAllowance(subject: string, kind: string, period: string, cap: number): Promise<number | null> {
  const { data, error } = await db.rpc('spend_ai_allowance', { p_subject: subject, p_kind: kind, p_period: period, p_cap: cap })
  if (error) throw new Error(error.message)
  return data === null ? null : (data as number)
}

export function intakeDeps(ip: string): IntakeDeps & { base64: (b: Uint8Array) => string; categories: readonly string[]; extractionPrompt: string } {
  const period = budgetPeriod(new Date())
  return {
    verifyTurnstile: (token) => verifyTurnstile({ secret: process.env.TURNSTILE_SECRET_KEY, token, ip }),
    burstAllowed: async (deviceId) => {
      const [byIp, byDevice] = await Promise.all([checkRateLimit('p2s_intake_ip', ip), checkRateLimit('p2s_intake_device', deviceId)])
      return byIp.allowed && byDevice.allowed
    },
    spendDevice: (deviceId) => spendAllowance(ANON_INTAKE.deviceSubject(deviceId), ANON_INTAKE.kind, 'all', ANON_INTAKE.perDevice),
    spendDay: () => spendAllowance(ANON_INTAKE.budgetSubject, ANON_INTAKE.budgetKind, period, resolveAnonIntakeBudget(process.env.P2S_ANON_INTAKE_DAILY_BUDGET)),
    refundDevice: async (deviceId) => {
      const { error } = await db.from('ai_allowance').update({ count: 0, updated_at: new Date().toISOString() })
        .eq('subject', ANON_INTAKE.deviceSubject(deviceId)).eq('kind', ANON_INTAKE.kind).eq('period', 'all')
      if (error) console.error('[p2s-intake] refund failed', error.message)
    },
    modelConfigured: MODEL_CONFIGURED,
    callModel: async (body) => {
      const r = await callModelBody(body, VISION_TIMEOUT_MS)
      console.info('[p2s-intake]', JSON.stringify({ step: 'model', ok: r.ok, prompt_tokens: r.promptTokens ?? null, output_tokens: r.outputTokens ?? null }))
      return r.ok ? r.text ?? null : null
    },
    storePhoto: async (deviceId, bytes, mime) => {
      if (!isR2Configured()) return null
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : mime === 'image/avif' ? 'avif' : 'jpg'
      const copy = new Uint8Array(bytes.byteLength); copy.set(bytes)
      return uploadToR2(copy.buffer, `p2s/${deviceId}/${randomUUID()}.${ext}`, mime)
    },
    xlsxToCsv: (bytes) => {
      const declared = zipDeclaredUncompressedSize(bytes)
      if (declared === null || declared > XLSX_MAX_UNCOMPRESSED) return null
      try {
        // Bounded parse: the first sheet only, at most the rows a draft can carry (plus a header), no formulas,
        // styles or macros — so a sheet that lies about its size still cannot make us read a million rows.
        const wb = XLSX.read(bytes, { type: 'array', sheets: 0, sheetRows: SEED_ROWS_MAX * 2 + 1, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false })
        const first = wb.SheetNames[0]
        return first ? XLSX.utils.sheet_to_csv(wb.Sheets[first]) : null
      } catch {
        return null
      }
    },
    fetchJson: async (url) => {
      const got = await pinnedGet(url, 'application/json')
      if (!got) return null
      try { return JSON.parse(new TextDecoder().decode(got.bytes)) } catch { return null }
    },
    fetchHtml: async (url) => {
      const got = await pinnedGet(url, 'text/html,application/xhtml+xml')
      if (!got || (got.type && !/html|xml|text\/plain/i.test(got.type))) return null
      return new TextDecoder().decode(got.bytes)
    },
    base64: (b) => Buffer.from(b).toString('base64'),
    categories: CATALOG_CATEGORY_KEYS,
    extractionPrompt: buildExtractionPrompt(),
    log: (line) => console.info('[p2s-intake]', JSON.stringify(line)),
    screen: (text) => screenText(text, screenDeps()),
  }
}
