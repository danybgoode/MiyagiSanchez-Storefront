/**
 * The promoter fills a shop from photos (epic 08 · plans-gratis-negocio S5.1, README D14).
 *
 * At the counter, the promoter photographs a merchant's product and gets a suggested card (name, description,
 * category, price) for the UNCLAIMED shop they just opened. The suggestion only FILLS the workspace's product form:
 * the promoter reviews it and publishes through the existing promoter listing route, so there is no new write path
 * and that route's ownership checks still decide which shop can be written.
 *
 * Reuses prompt-to-shop's photo core (the SSRF-safe own-upload check, the vision request, the suggestion validator,
 * the retry), with the promoter's own allowance subject on the existing daily budget.
 *
 * Pure: every effect is injected, so the order and the refusals are tested without a model.
 */
import { buildPhotoRequest, isOwnPhotoUrl, validateSuggestion, PHOTO_MAX_ATTEMPTS, type PhotoHosts, type PhotoSuggestion } from './prompt-to-shop/photo'
import { parseModelJson } from './prompt-to-shop/blocks'

/** Vision analyses a promoter may run per Mexico City day — a fail-closed bound on the model cost. */
export const PROMOTER_PHOTO_ANALYSES_PER_DAY = 60

/** The promoter's own allowance subject on `spend_ai_allowance` (kind `daily_budget`), never a merchant's. */
export function promoterPhotoSubject(promoterId: string): string {
  return `photo_analysis:promoter:${promoterId}`
}

export interface PromoterPhotoDeps {
  hosts: PhotoHosts
  burstAllowed: () => Promise<boolean>
  /** `spend_ai_allowance` raw answer: a number = spent, null = at the cap. Fails closed. */
  spend: () => Promise<{ data: unknown; error: unknown }>
  modelConfigured: boolean
  fetchImage: (url: string) => Promise<{ mimeType: string; base64: string } | null>
  callModel: (body: ReturnType<typeof buildPhotoRequest>) => Promise<{ ok: boolean; text?: string }>
}

export type PromoterPhotoOutcome =
  | { status: 200; body: { ok: true; suggestion: PhotoSuggestion | null; message?: string } }
  | { status: 400 | 429 | 503; body: { ok: false; error: string } }

const COPY = {
  badPhoto: 'Sube primero la foto desde este mismo formulario.',
  rateLimited: 'Vas muy rápido. Espera un momento.',
  daily: 'Ya usaste las fotos con IA de hoy. Llena este producto a mano; mañana vuelven.',
  unavailable: 'No pudimos revisar la foto ahora. Llena el producto a mano.',
  fillYourself: 'No pudimos leer el producto en la foto. Llénalo a mano.',
} as const

async function spendOne(deps: PromoterPhotoDeps): Promise<'spent' | 'capped' | 'error'> {
  let rpc: { data: unknown; error: unknown }
  try {
    rpc = await deps.spend()
  } catch (e) {
    rpc = { data: null, error: e instanceof Error ? e.message : 'spend threw' }
  }
  if (rpc.error) return 'error'
  return typeof rpc.data === 'number' ? 'spent' : 'capped'
}

export async function suggestFromPhoto(
  input: { promoterClerkId: string; imageUrl: unknown; shopName: string | null },
  deps: PromoterPhotoDeps,
): Promise<PromoterPhotoOutcome> {
  // Only a photo this promoter uploaded through our upload route: the server fetches it, so anything else is an SSRF door.
  if (!isOwnPhotoUrl(input.imageUrl, deps.hosts, input.promoterClerkId)) return { status: 400, body: { ok: false, error: COPY.badPhoto } }
  if (!(await deps.burstAllowed())) return { status: 429, body: { ok: false, error: COPY.rateLimited } }
  if (!deps.modelConfigured) return { status: 200, body: { ok: true, suggestion: null, message: COPY.fillYourself } }

  // The daily budget is spent BEFORE the vision call, and fails closed: an error or the cap both mean no model call.
  const first = await spendOne(deps)
  if (first === 'error') return { status: 503, body: { ok: false, error: COPY.unavailable } }
  if (first === 'capped') return { status: 429, body: { ok: false, error: COPY.daily } }

  const image = await deps.fetchImage(input.imageUrl)
  if (!image) return { status: 200, body: { ok: true, suggestion: null, message: COPY.fillYourself } }

  const request = buildPhotoRequest(image, input.shopName)
  for (let attempt = 1; attempt <= PHOTO_MAX_ATTEMPTS; attempt++) {
    // Every model call costs one unit, the retry included (Codex security, #475): otherwise 60 a day buys 120 calls.
    // Out of budget for the retry ⇒ "fill it by hand", never an unpaid call.
    if (attempt > 1 && (await spendOne(deps)) !== 'spent') break
    let result: { ok: boolean; text?: string }
    try {
      result = await deps.callModel(request)
    } catch {
      result = { ok: false }
    }
    const parsed = result.ok && result.text ? validateSuggestion(parseModelJson(result.text)) : null
    if (parsed?.ok) return { status: 200, body: { ok: true, suggestion: parsed.suggestion } }
  }
  return { status: 200, body: { ok: true, suggestion: null, message: COPY.fillYourself } }
}
