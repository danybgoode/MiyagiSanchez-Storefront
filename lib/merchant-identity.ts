/**
 * lib/merchant-identity.ts
 *
 * Founding merchant activation operations · Sprint 1 (Story 1.2) — pure,
 * zero-import normalization + the dedupe-precedence decision. Kept free of
 * `next`, Clerk and DB imports (the `lib/seller-mode.ts` convention) so the
 * `api` spec can import it directly and walk every branch without a database.
 *
 * `POST /api/promoter/relationship` is the only caller of the DEDUPE decision;
 * it does the three Supabase lookups (shop_id / phone_e164 / email_normalized)
 * and hands the results to `decideDedupeMatch`, which holds the PRECEDENCE
 * rule so the route and the spec can never disagree about which hit wins.
 */

// ── Phone ──────────────────────────────────────────────────────────────────

/**
 * Normalize a phone number toward E.164 for MEXICAN numbers. Mirrors the
 * digit-counting rule `lib/preview-verification.ts#normalizePhone` already
 * uses for WhatsApp delivery (10 local digits ⇒ prefix `52`; already-prefixed
 * numbers pass through), but returns the `+`-prefixed E.164 shape the
 * `phone_e164` column stores. Returns null when there aren't enough digits to
 * be a real number, or when the digit count is implausibly long (garbage
 * input) — the caller must never silently save an unusable "phone".
 */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '')
  if (digits.length < 10) return null
  const withCountry = digits.length === 10 ? `52${digits}` : digits
  if (withCountry.length > 15) return null // E.164 hard cap is 15 digits
  return `+${withCountry}`
}

// ── Email ──────────────────────────────────────────────────────────────────

const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Normalize an email for exact-match dedupe: trim + lowercase. Returns null
 * for anything that doesn't even have the shape of an email — a malformed
 * value must never become a false-positive dedupe key (or silently collide
 * with a different malformed value that happens to normalize the same way).
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim().toLowerCase()
  if (!trimmed || !EMAIL_SHAPE_RE.test(trimmed)) return null
  return trimmed
}

// ── Business name ────────────────────────────────────────────────────────

/**
 * A normalized comparison key for a business name: lower-case, diacritics
 * stripped, non-alphanumeric collapsed to single spaces, trimmed. Backs both
 * the `lower(business_name)` index (an exact-key lookup) and the fuzzy
 * similarity scan below. Never used to MERGE records (epic Decision 3) — only
 * to decide whether two names are worth a human's attention.
 */
export function businessNameKey(raw: string | null | undefined): string {
  return (raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Classic Levenshtein edit distance, iterative two-row DP (no recursion, no deps). */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const prevRow = new Array(n + 1)
  for (let j = 0; j <= n; j++) prevRow[j] = j
  const row = new Array(n + 1)
  for (let i = 1; i <= m; i++) {
    row[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(
        row[j - 1] + 1, // insertion
        prevRow[j] + 1, // deletion
        prevRow[j - 1] + cost, // substitution
      )
    }
    for (let j = 0; j <= n; j++) prevRow[j] = row[j]
  }
  return prevRow[n]
}

/**
 * Normalized similarity in [0, 1] between two business names, computed over
 * their `businessNameKey` forms (so accents/punctuation/case never matter).
 * `1` = identical keys; `0` = either name is empty after normalization.
 */
export function businessNameSimilarity(a: string, b: string): number {
  const ka = businessNameKey(a)
  const kb = businessNameKey(b)
  if (!ka || !kb) return 0
  if (ka === kb) return 1
  const maxLen = Math.max(ka.length, kb.length)
  return 1 - levenshteinDistance(ka, kb) / maxLen
}

/** The similarity threshold above which two names are worth flagging as a
 *  possible duplicate for a HUMAN to confirm — never auto-merged (Decision 3). */
export const FUZZY_NAME_THRESHOLD = 0.82

/** True when two business names are similar enough to suggest a duplicate. */
export function isFuzzyNameMatch(a: string, b: string): boolean {
  return businessNameSimilarity(a, b) >= FUZZY_NAME_THRESHOLD
}

// ── Dedupe precedence (Story 1.2 build contract) ────────────────────────────

export type DedupeMatchReason = 'shop_id' | 'phone_e164' | 'whatsapp_e164' | 'email_normalized'

export interface DedupeCandidateRows {
  /** Result of `WHERE shop_id = :shopId` (only run when a shopId was given). */
  byShopId: { id: string } | null
  /** Result of `WHERE phone_e164 = :normalizedPhone`. */
  byPhone: { id: string } | null
  /** Result of `WHERE email_normalized = :normalizedEmail`. */
  byEmail: { id: string } | null
  /** Result of `WHERE whatsapp_e164 = :normalizedWhatsapp` — the promoter panel's one required contact (promoter-panel S2). */
  byWhatsapp?: { id: string } | null
}

export type DedupeDecision =
  | { matched: true; relationshipId: string; matchReason: DedupeMatchReason }
  | { matched: false }

/**
 * The dedupe PRECEDENCE rule (build contract, sprint-1.md): (1) shop_id exact,
 * (2) phone_e164 exact, (3) email_normalized exact — the first present hit
 * wins, in that order, regardless of which lookups were even attempted. Pure
 * over already-fetched rows so the route (which does the actual Supabase
 * lookups) and this spec can never disagree about which one wins when more
 * than one candidate matched.
 */
export function decideDedupeMatch(rows: DedupeCandidateRows): DedupeDecision {
  if (rows.byShopId) return { matched: true, relationshipId: rows.byShopId.id, matchReason: 'shop_id' }
  if (rows.byPhone) return { matched: true, relationshipId: rows.byPhone.id, matchReason: 'phone_e164' }
  if (rows.byWhatsapp) return { matched: true, relationshipId: rows.byWhatsapp.id, matchReason: 'whatsapp_e164' }
  if (rows.byEmail) return { matched: true, relationshipId: rows.byEmail.id, matchReason: 'email_normalized' }
  return { matched: false }
}
