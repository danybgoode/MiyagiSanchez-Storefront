/**
 * Rate limiting via Upstash Redis.
 *
 * Env vars required (set in Vercel + .env.local):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *
 * If not configured, all limits pass through silently (local dev / cold start).
 */

import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'

// ── Lazy singleton ─────────────────────────────────────────────────────────────

let _redis: Redis | null = null
function getRedis(): Redis | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null
  if (!_redis) {
    _redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  }
  return _redis
}

// ── Limit configs ──────────────────────────────────────────────────────────────

// Offers: max 10 per IP per hour — prevents spam offers
const offerLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 h'),  prefix: 'rl:offers' })
}

// Stamps: max 30 per IP per 10 min — prevents message spam
const stampLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '10 m'), prefix: 'rl:stamps' })
}

// Checkout: max 20 per IP per 10 min — prevents checkout abuse
const checkoutLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '10 m'), prefix: 'rl:checkout' })
}

// MCP: max 120 per IP per minute — per-agent reasonable limit
const mcpLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(120, '1 m'), prefix: 'rl:mcp' })
}

// Partner-shaped credentials need a track lookup while recruiting is OFF so
// an operator can be rolled back before the shared MCP bucket. Keep that
// pre-auth DB work independently bounded; exhaustion degrades to the same
// generic unauthorized result for every partner-shaped credential.
const mcpPartnerPreflightLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(120, '1 m'), prefix: 'rl:mcp_partner_preflight' })
}

// Supply import: max 5 batch imports per IP per hour — prevents bulk abuse
const supplyImportLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 h'), prefix: 'rl:supply' })
}

// Catalog AI extract: max 15 paste-extractions per IP per hour — each call hits
// a paid LLM, so keep it tight while still allowing real onboarding iteration.
const catalogExtractLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(15, '1 h'), prefix: 'rl:catalog_extract' })
}

// Embed widget: max 240 reads per IP per minute — the widget is public and
// scriptable from any page, so it needs a ceiling, but generous enough for a
// busy page rendering several cards. Only applied to embed-marked requests, so
// it never throttles the marketplace or AI agents.
const embedLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(240, '1 m'), prefix: 'rl:embed' })
}

// Sweepstakes public writes: verification codes + entry attempts.
const sweepstakesLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '1 h'), prefix: 'rl:sweepstakes' })
}

// Telegram inbound webhook: max 30 /start redemptions per CHAT per minute. Keyed
// by chat_id, not IP — every webhook call shares Telegram's server IPs, so an IP
// bucket would throttle all sellers at once. Caps one user's /start spam only.
const telegramWebhookLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m'), prefix: 'rl:tg_webhook' })
}

// Telegram link minting: max 10 deep-links per seller per 10 min — prevents a
// seller hammering "Conecta Telegram" into a pile of live tokens.
const telegramLinkLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '10 m'), prefix: 'rl:tg_link' })
}

// Promoter applications: max 5 submissions per IP per hour — a public, unauthenticated
// form, so this is the primary anti-spam backstop alongside the honeypot.
const promoterApplyLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 h'), prefix: 'rl:promoter_apply' })
}

// Public claim requests can email an address supplied by the visitor.
const claimRequestLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 h'), prefix: 'rl:claim_request' })
}

// Tiendas Fundadoras public application: max 5 submissions per IP per hour —
// same shape as promoter_apply (a public, unauthenticated form), the primary
// anti-spam backstop alongside the honeypot.
const fundadorasApplyLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 h'), prefix: 'rl:fundadoras_apply' })
}

// Tiendas Fundadoras FUNNEL pings (view/start/validation_failed) — a SEPARATE,
// looser bucket from the application above. A page load + a fumbled form fires
// several cheap telemetry events; sharing the 5/hour apply budget would let
// those pings 429 the real application (worse behind one NAT/carrier IP). This
// bucket is generous because the events are observability, not a write.
const fundadorasTrackLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, '1 h'), prefix: 'rl:fundadoras_track' })
}

// Artwork upload: max 20 per IP per 10 min — a fully public, unauthenticated
// guest-upload surface (custom-print-products S3), generous enough for a
// buyer retrying a slow mobile upload without opening the door to abuse.
const artworkUploadLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '10 m'), prefix: 'rl:artwork' })
}

// Launchpad public writes: manuscript submissions to a bookshop convocatoria —
// verification codes, upload, and submit. A fully public, unauthenticated
// surface (bookshop-launchpad S1.1), so this is a primary anti-abuse backstop.
// Tighter than sweepstakes: each submit carries a file upload, not just a row.
const launchpadLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 h'), prefix: 'rl:launchpad' })
}

// Launchpad voting: the public /v/[slug] verification + vote surface (S3.2). A
// vote is a single row (no upload), and a campaign page is shared widely, so this
// is looser than the manuscript-upload bucket but still a real anti-abuse cap.
const launchpadVoteLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 h'), prefix: 'rl:launchpad_vote' })
}

// Relationship intake: max 60 writes per IP per 10 min — founding-merchant
// field capture (activation-crm S1.2/S1.3). Deliberately its OWN bucket, not
// shared with `checkout` — the intake step alone can burn a save on every
// field-blur plus a consent check per preview, and `checkout` is shared with
// all six `/api/promoter/close/*` MONEY routes (20/10min). Sharing the two
// would let a busy field session for one merchant rate-limit the promoter
// out of charging a DIFFERENT merchant's card (activation-crm S1 review A13).
const relationshipLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, '10 m'), prefix: 'rl:relationship' })
}

// Comparador shop-URL analyzer: max 8 analyses per IP per 10 min — a fully
// public, unauthenticated, anonymous surface that triggers a server-side
// external fetch of a caller-supplied URL (cost-comparator-homepage S3 ·
// US-3.1). Tight enough to blunt someone using it as a free URL-fetch proxy,
// generous enough for a merchant/consultant retrying a slow shop or trying a
// couple of competitors back to back.
const comparatorAnalyzeLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(8, '10 m'), prefix: 'rl:comparator_analyze' })
}

// Prompt-to-shop generation bursts (epic prompt-to-shop D5). Two buckets because one is not enough: per IP
// catches a script cycling device cookies, per device catches one phone hammering «Otra versión». Both may fail
// open like every limiter here — the HARD caps are the Supabase allowance and the daily budget, which fail closed.
// The IP bucket is generous because a market stall's whole carrier NAT can share one address.
const p2sGenerateIpLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 h'), prefix: 'rl:p2s_generate_ip' })
}

const p2sGenerateDeviceLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(6, '10 m'), prefix: 'rl:p2s_generate_device' })
}

// «Mándame el enlace» (prompt-to-shop S3.1): each request emails an address the requester typed. Five an hour per IP
// bounds anyone using it to fill a stranger's inbox; a merchant needs one. Fails open like the rest — the draft
// ownership check behind it does not.
const p2sMailLinkLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 h'), prefix: 'rl:p2s_mail_link' })
}

// Per device as well, like p2s_generate_device: a carrier NAT shares one IP across a market, so the IP bucket
// alone is either too loose for one phone or too tight for the stall next to it.
const p2sMailLinkDeviceLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, '1 h'), prefix: 'rl:p2s_mail_link_device' })
}

// Prompt-to-shop photo → product (S4.2, D5). Each analysis is one paid Gemini vision call, and it runs BEFORE the
// merchant confirms, so the monthly photo allowance (spent at confirm, fails closed) does not bound it. This burst
// bucket does, per user: 12 analyses in 10 minutes covers a merchant photographing a shelf, retakes included. It fails
// open like every limiter here; the hard monthly cap is the allowance row.
const p2sPhotoLimiter = () => {
  const redis = getRedis()
  if (!redis) return null
  return new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(12, '10 m'), prefix: 'rl:p2s_photo' })
}

// ── Public helper ──────────────────────────────────────────────────────────────

export type LimitKey = 'offers' | 'checkout' | 'mcp' | 'mcp_partner_preflight' | 'supply_import' | 'stamps' | 'catalog_extract' | 'embed' | 'sweepstakes' | 'telegram_webhook' | 'telegram_link' | 'promoter_apply' | 'claim_request' | 'artwork_upload' | 'launchpad' | 'launchpad_vote' | 'comparator_analyze' | 'relationship' | 'fundadoras_apply' | 'fundadoras_track' | 'p2s_generate_ip' | 'p2s_generate_device' | 'p2s_mail_link' | 'p2s_mail_link_device' | 'p2s_photo'

function limiterFor(key: LimitKey): Ratelimit | null {
  const getLimiter = key === 'offers'          ? offerLimiter
    : key === 'checkout'        ? checkoutLimiter
    : key === 'mcp'             ? mcpLimiter
    : key === 'mcp_partner_preflight' ? mcpPartnerPreflightLimiter
    : key === 'stamps'          ? stampLimiter
    : key === 'catalog_extract' ? catalogExtractLimiter
    : key === 'embed'           ? embedLimiter
    : key === 'sweepstakes'     ? sweepstakesLimiter
    : key === 'telegram_webhook'? telegramWebhookLimiter
    : key === 'telegram_link'   ? telegramLinkLimiter
    : key === 'promoter_apply'  ? promoterApplyLimiter
    : key === 'claim_request' ? claimRequestLimiter
    : key === 'artwork_upload'  ? artworkUploadLimiter
    : key === 'launchpad'       ? launchpadLimiter
    : key === 'launchpad_vote'  ? launchpadVoteLimiter
    : key === 'comparator_analyze' ? comparatorAnalyzeLimiter
    : key === 'relationship'   ? relationshipLimiter
    : key === 'fundadoras_apply' ? fundadorasApplyLimiter
    : key === 'fundadoras_track' ? fundadorasTrackLimiter
    : key === 'p2s_generate_ip' ? p2sGenerateIpLimiter
    : key === 'p2s_generate_device' ? p2sGenerateDeviceLimiter
    : key === 'p2s_mail_link' ? p2sMailLinkLimiter
    : key === 'p2s_mail_link_device' ? p2sMailLinkDeviceLimiter
    : key === 'p2s_photo' ? p2sPhotoLimiter
    : supplyImportLimiter
  return getLimiter()
}

export type LimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfter: number; limit: number; remaining: number }

/** Read the current bucket without adding a request. */
export async function peekRateLimit(key: LimitKey, identifier: string): Promise<LimitDecision> {
  const limiter = limiterFor(key)
  if (!limiter) return { allowed: true }

  try {
    const { remaining, reset, limit } = await limiter.getRemaining(identifier)
    if (remaining > 0) return { allowed: true }
    return {
      allowed: false,
      retryAfter: Math.ceil((reset - Date.now()) / 1000),
      limit,
      remaining,
    }
  } catch {
    return { allowed: true }
  }
}

/**
 * Check rate limit for a given key and identifier (usually IP address).
 * Returns { allowed: true } if passes or if Redis is unconfigured.
 * Returns { allowed: false, retryAfter: number } if blocked.
 */
export async function checkRateLimit(
  key: LimitKey,
  identifier: string,
): Promise<LimitDecision> {
  const limiter = limiterFor(key)
  if (!limiter) return { allowed: true }   // Redis not configured — pass through

  try {
    const { success, limit, remaining, reset } = await limiter.limit(identifier)
    if (success) return { allowed: true }
    return {
      allowed:    false,
      retryAfter: Math.ceil((reset - Date.now()) / 1000),
      limit,
      remaining,
    }
  } catch {
    return { allowed: true }   // Redis error — fail open, never block business logic
  }
}

/**
 * Get the real IP from a Next.js request, respecting Vercel's forwarded headers.
 */
export function getClientIp(req: Request): string {
  const headers = new Headers((req as Request & { headers: Headers }).headers)
  return (
    headers.get('x-real-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    '127.0.0.1'
  )
}
