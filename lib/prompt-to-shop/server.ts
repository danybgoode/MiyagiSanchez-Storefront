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
import type { IdentityBlock } from './blocks'
import type { EditDeps } from './edit'
import type { DraftRef, DraftsDeps } from './handler'
import type { ModelRequest, ModelResult } from './planner'
import { verifyTurnstile } from './turnstile'
import { parseServiceAccount, vertexGenerateUrl, vertexTokenSource } from './vertex'

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash'
/** One block must not hold the narration hostage: a hung call becomes a failed attempt, then a fallback. */
const MODEL_TIMEOUT_MS = 12_000

// Two ways to reach the same model. A service account (GOOGLE_VERTEX_SA_JSON, raw or base64 JSON) goes through
// Vertex AI and bills that Cloud project — the account with credit. Otherwise GEMINI_API_KEY goes through the Gemini
// API. Vertex wins when both are set. See vertex.ts for why a service account cannot use the Gemini API.
const VERTEX_SA = parseServiceAccount(process.env.GOOGLE_VERTEX_SA_JSON)
const VERTEX_LOCATION = process.env.GOOGLE_VERTEX_LOCATION || 'global'
const vertexToken = VERTEX_SA ? vertexTokenSource(VERTEX_SA) : null

async function modelEndpoint(): Promise<{ url: string; headers: Record<string, string> } | null> {
  if (VERTEX_SA && vertexToken) {
    const token = await vertexToken.get()
    if (!token) return null
    return { url: vertexGenerateUrl(VERTEX_SA.project_id, GEMINI_MODEL, VERTEX_LOCATION), headers: { Authorization: `Bearer ${token}` } }
  }
  const key = process.env.GEMINI_API_KEY ?? ''
  return { url: `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, headers: { 'x-goog-api-key': key } }
}

async function callGemini(req: ModelRequest): Promise<ModelResult> {
  return callModelBody(req.body)
}

/** True when either credential is set. Without one, a model call can only fail. */
export const MODEL_CONFIGURED = !!VERTEX_SA || !!process.env.GEMINI_API_KEY
export const MODEL_VIA = VERTEX_SA ? 'vertex' : 'gemini_api'

/**
 * One `generateContent` call with any body (text blocks, or the S4.2 photo with `inlineData`), through the same
 * credential choice and timeout as the generation blocks. Never throws.
 */
export async function callModelBody(body: object, timeoutMs: number = MODEL_TIMEOUT_MS): Promise<ModelResult> {
  try {
    const endpoint = await modelEndpoint()
    if (!endpoint) return { ok: false, error: 'vertex token refused' }
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...endpoint.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
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
    modelConfigured: MODEL_CONFIGURED,
    newDeviceId: () => randomUUID(),
    log: (line) => console.info('[p2s]', JSON.stringify({ via: VERTEX_SA ? 'vertex' : 'gemini_api', ...line })),
  }
}

/** The real reads/writes behind `PATCH /api/p2s/drafts/[id]`. The decisions live in `edit.ts`. */
export function editDeps(): EditDeps {
  return {
    read: async (draftId, deviceId) => {
      const { data, error } = await db
        .from('shop_drafts')
        .select('identity, updated_at')
        .eq('id', draftId)
        .eq('device_id', deviceId)
        .is('claimed_by', null)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle()
      if (error || !data) return null
      const row = data as { identity: IdentityBlock | null; updated_at: string }
      return { identity: row.identity, updatedAt: row.updated_at }
    },
    write: async (draftId, deviceId, expectedUpdatedAt, identity) => {
      // Optimistic: lands only while `updated_at` is what the read saw (a generation saving a block bumps it), and
      // `.select()` reads the row back, because supabase-js reports no error for an UPDATE that matched nothing.
      const { data, error } = await db
        .from('shop_drafts')
        .update({ identity, updated_at: new Date().toISOString() })
        .eq('id', draftId)
        .eq('device_id', deviceId)
        .is('claimed_by', null)
        .gt('expires_at', new Date().toISOString())
        .eq('updated_at', expectedUpdatedAt)
        .select('id')
      if (error) throw new Error(error.message)
      return Array.isArray(data) && data.length === 1
    },
  }
}
