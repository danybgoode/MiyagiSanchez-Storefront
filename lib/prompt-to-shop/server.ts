/**
 * Prompt-to-shop — the real I/O behind `DraftsDeps` (Supabase, Gemini, Turnstile, Upstash).
 *
 * Thin on purpose: every decision lives in `handler.ts` / `planner.ts` and is spec-covered there. What is here is
 * the part a spec cannot reach without the network, so it holds no branching beyond "did the write land".
 * Writes are conditional on the draft id AND the device id and `.select()` the row back: supabase-js reports no
 * error for an UPDATE that matched nothing, so "no error" is not "saved".
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { db } from '@/lib/supabase'
import { checkRateLimit } from '@/lib/ratelimit'
import { budgetPeriod, resolveDailyBudget } from './allowance'
import type { DraftRef, DraftsDeps } from './handler'
import type { ModelRequest, ModelResult } from './planner'
import { verifyTurnstile } from './turnstile'

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash'
/** One block must not hold the narration hostage: a hung call becomes a failed attempt, then a fallback. */
const MODEL_TIMEOUT_MS = 12_000

async function callGemini(req: ModelRequest): Promise<ModelResult> {
  const key = process.env.GEMINI_API_KEY ?? ''
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { ok: false, error: `${res.status} ${detail.slice(0, 200)}` }
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    }
    return {
      ok: true,
      text: data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '',
      promptTokens: data.usageMetadata?.promptTokenCount,
      outputTokens: data.usageMetadata?.candidatesTokenCount,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.name : 'fetch failed' }
  }
}

const DRAFT_COLUMNS = 'id, description'

export function draftsDeps(ip: string): DraftsDeps {
  // One budget day per request: a refund just after Mexico City midnight must give back the day it was spent on.
  const period = budgetPeriod(new Date())
  return {
    verifyTurnstile: (token) => verifyTurnstile({ secret: process.env.TURNSTILE_SECRET_KEY, token, ip }),
    burstAllowed: async (deviceId) => {
      const [byIp, byDevice] = await Promise.all([
        checkRateLimit('p2s_generate_ip', ip),
        checkRateLimit('p2s_generate_device', deviceId),
      ])
      return byIp.allowed && byDevice.allowed
    },
    spend: async ({ subject, versionCap }) => {
      const { data, error } = await db.rpc('spend_p2s_generation', {
        p_device: subject,
        p_version_cap: versionCap,
        p_budget_period: period,
        p_budget_cap: resolveDailyBudget(process.env.P2S_DAILY_BUDGET),
      })
      return { data, error }
    },
    findOwnedDraft: async (draftId, deviceId) => {
      const { data, error } = await db
        .from('shop_drafts')
        .select(DRAFT_COLUMNS)
        .eq('id', draftId)
        .eq('device_id', deviceId)
        .is('claimed_by', null)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle()
      return error || !data ? null : (data as DraftRef)
    },
    createDraft: async (deviceId, description, versionsUsed) => {
      const { data, error } = await db
        .from('shop_drafts')
        .insert({ device_id: deviceId, description, versions_used: versionsUsed })
        .select(DRAFT_COLUMNS)
        .single()
      return error || !data ? null : (data as DraftRef)
    },
    startVersion: async (draft, deviceId, description, versionsUsed) => {
      const { data, error } = await db
        .from('shop_drafts')
        .update({ description, versions_used: versionsUsed, identity: null, words: null, catalog: null, block_status: {}, updated_at: new Date().toISOString() })
        .eq('id', draft.id)
        .eq('device_id', deviceId)
        .is('claimed_by', null)
        // Only forward. A refund can hand the same version number out twice; without this, a re-run would reuse a
        // number an in-flight run is still saving under, and save_p2s_block's version guard would let both write.
        .lt('versions_used', versionsUsed)
        .select('id')
      return !error && Array.isArray(data) && data.length === 1
    },
    saveBlock: async (draftId, deviceId, version, event) => {
      // One statement in Postgres (`save_p2s_block`): the status merge is atomic and a superseded version stops.
      const { data, error } = await db.rpc('save_p2s_block', {
        p_draft: draftId, p_device: deviceId, p_version: version,
        p_key: event.key, p_data: event.data, p_status: event.status,
      })
      return !error && data === true
    },
    refund: async ({ subject }) => {
      const { error } = await db.rpc('refund_p2s_generation', { p_device: subject, p_budget_period: period })
      if (error) console.error('[p2s] refund failed', error.message)
    },
    callModel: callGemini,
    modelConfigured: !!process.env.GEMINI_API_KEY,
    newDeviceId: () => randomUUID(),
    log: (line) => console.info('[p2s]', JSON.stringify(line)),
  }
}
