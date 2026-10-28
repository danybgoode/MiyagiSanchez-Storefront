/**
 * Prompt-to-shop — the generation planner (epic D9, D11).
 *
 * Turns one description into three sequential model calls (identity → words → catalog), each validated, retried
 * once, and replaced by a deterministic fallback if it still fails. Every side effect is INJECTED: the model call,
 * the block save and the event emit. That is what lets the `api` spec drive the whole sequence with fakes and
 * assert its ORDER, which is the property that matters here: a block is saved before it is sent, and nothing is
 * sent for a block that was not saved.
 */

import {
  BLOCK_KEYS,
  fallbackCatalog,
  fallbackIdentity,
  fallbackWords,
  parseModelJson,
  validateBlock,
  type BlockData,
  type BlockKey,
  type BlockStatus,
  type IdentityBlock,
} from './blocks'
import { RESPONSE_SCHEMAS, catalogPrompt, identityPrompt, wordsPrompt } from './prompts'

export interface ModelRequest {
  block: BlockKey
  body: {
    contents: Array<{ role: 'user'; parts: Array<{ text: string }> }>
    generationConfig: Record<string, unknown>
  }
}

export interface ModelResult {
  ok: boolean
  /** The model's text, when ok. */
  text?: string
  /** HTTP status or a short reason, when not ok — logged, never shown. */
  error?: string
  promptTokens?: number
  outputTokens?: number
}

export type BlockEvent<K extends BlockKey = BlockKey> = { key: K; status: BlockStatus; data: BlockData[K] }

export interface PlannerDeps {
  callModel: (req: ModelRequest) => Promise<ModelResult>
  /** Persist one block. Must resolve true only when the row was actually written (`.select()` back). */
  saveBlock: (event: BlockEvent) => Promise<boolean>
  emit: (event: BlockEvent) => void
  log?: (line: Record<string, unknown>) => void
  now?: () => number
}

export const MAX_ATTEMPTS_PER_BLOCK = 2

export function buildBlockRequest(key: BlockKey, description: string, identity?: IdentityBlock): ModelRequest {
  const id = identity ?? fallbackIdentity(description)
  const prompt =
    key === 'identity' ? identityPrompt(description)
    : key === 'words' ? wordsPrompt(description, id)
    : catalogPrompt(description, id)
  return {
    block: key,
    body: {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        // A little more variety for identity, where «Otra versión» should actually look different.
        temperature: key === 'identity' ? 0.9 : 0.6,
        // Thinking tokens count against maxOutputTokens. Measured live on gemini-3.5-flash (2026-10-28): with the
        // default level, identity spent 980 tokens thinking inside a 1024 cap and stopped at MAX_TOKENS mid-JSON,
        // so EVERY identity fell back. These blocks are short structured fills, not reasoning; minimal thinking
        // returned valid JSON with no thinking tokens, and the headroom covers a verbose model either way.
        thinkingConfig: { thinkingLevel: 'minimal' },
        maxOutputTokens: key === 'catalog' ? 4096 : 2048,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMAS[key],
      },
    },
  }
}

function fallbackFor<K extends BlockKey>(key: K, description: string, identity: IdentityBlock | undefined): BlockData[K] {
  if (key === 'identity') return fallbackIdentity(description) as BlockData[K]
  if (key === 'words') return fallbackWords(identity ?? fallbackIdentity(description)) as BlockData[K]
  return fallbackCatalog() as BlockData[K]
}

/** One block: up to two model attempts, then the fallback. Never throws for a model failure. */
export async function generateBlock<K extends BlockKey>(
  key: K,
  description: string,
  identity: IdentityBlock | undefined,
  deps: Pick<PlannerDeps, 'callModel' | 'log' | 'now'>,
): Promise<BlockEvent<K>> {
  const now = deps.now ?? Date.now
  const req = buildBlockRequest(key, description, identity)
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_BLOCK; attempt++) {
    const started = now()
    let result: ModelResult
    try {
      result = await deps.callModel(req)
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : 'call failed' }
    }
    const parsed = result.ok && result.text ? validateBlock(key, parseModelJson(result.text)) : null
    deps.log?.({
      block: key, attempt, ms: now() - started, ok: !!parsed?.ok,
      prompt_tokens: result.promptTokens ?? null, output_tokens: result.outputTokens ?? null,
      ...(result.ok ? {} : { error: result.error }),
      ...(parsed && !parsed.ok ? { issues: parsed.issues.slice(0, 5) } : {}),
    })
    if (parsed?.ok) return { key, status: 'ok', data: parsed.data as BlockData[K] }
  }
  return { key, status: 'fallback', data: fallbackFor(key, description, identity) }
}

export type GenerationOutcome = { ok: true; events: BlockEvent[] } | { ok: false; reason: 'save_failed'; failedBlock: BlockKey }

/**
 * The whole draft, block by block: generate → save → emit, in that order, for each block. A save that does not
 * land stops the run there: emitting a block the draft does not hold would show the merchant a shop that a reload
 * cannot bring back.
 */
export async function generateDraft(description: string, deps: PlannerDeps): Promise<GenerationOutcome> {
  const events: BlockEvent[] = []
  let identity: IdentityBlock | undefined
  for (const key of BLOCK_KEYS) {
    const event = await generateBlock(key, description, identity, deps)
    if (key === 'identity') identity = event.data as IdentityBlock
    const saved = await deps.saveBlock(event)
    if (!saved) return { ok: false, reason: 'save_failed', failedBlock: key }
    deps.emit(event)
    events.push(event)
  }
  return { ok: true, events }
}
