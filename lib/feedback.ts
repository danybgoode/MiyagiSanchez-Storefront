/**
 * Pure `send_feedback` input validation — no `next/*`, no `server-only`, no DB
 * import — so the Playwright `api` runner can import it directly (LEARNINGS:
 * keep a pure validator/predicate next-free in its own file; mirrors
 * `lib/partner-tools.ts` and `lib/collection-derive.ts`'s `validateCollectionName`).
 *
 * `platform_feedback.author_kind` also accepts `'agent'` in its CHECK constraint
 * for a future unauthenticated/agent-generic filing path, but no caller mints it
 * yet — `resolveToolShop` only ever resolves a seller or partner credential, so
 * `handleSendFeedback` (app/api/ucp/mcp/route.ts) derives `author_kind` itself
 * from which credential shape resolved, never from caller input.
 */

export const FEEDBACK_CATEGORIES = ['feature', 'mcp-tool', 'bug'] as const
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]

/** Full author-kind domain (schema-level) — 'promoter' is minted by /api/promoter/report — see file header re: 'agent'. */
export const FEEDBACK_AUTHOR_KINDS = ['seller', 'partner', 'agent', 'promoter'] as const
export type FeedbackAuthorKind = (typeof FEEDBACK_AUTHOR_KINDS)[number]

const MESSAGE_MIN_LEN = 5
const MESSAGE_MAX_LEN = 2000
const TOOL_NAME_MAX_LEN = 100

export type FeedbackValidation =
  | { ok: true; category: FeedbackCategory; message: string; toolName: string | null }
  | { ok: false; error: string }

/** Validates + trims a `send_feedback` call's raw MCP tool arguments. */
export function validateFeedbackInput(args: Record<string, unknown> | undefined): FeedbackValidation {
  const category = typeof args?.category === 'string' ? args.category : ''
  if (!FEEDBACK_CATEGORIES.includes(category as FeedbackCategory)) {
    return { ok: false, error: `category debe ser una de: ${FEEDBACK_CATEGORIES.join(', ')}.` }
  }

  const message = typeof args?.message === 'string' ? args.message.trim() : ''
  if (message.length < MESSAGE_MIN_LEN) {
    return { ok: false, error: `message es obligatorio (mínimo ${MESSAGE_MIN_LEN} caracteres).` }
  }
  if (message.length > MESSAGE_MAX_LEN) {
    return { ok: false, error: `message es demasiado largo (máximo ${MESSAGE_MAX_LEN} caracteres).` }
  }

  let toolName: string | null = null
  if (args?.tool_name !== undefined && args?.tool_name !== null) {
    if (typeof args.tool_name !== 'string') {
      return { ok: false, error: 'tool_name debe ser texto.' }
    }
    const trimmed = args.tool_name.trim()
    if (trimmed.length > TOOL_NAME_MAX_LEN) {
      return { ok: false, error: `tool_name es demasiado largo (máximo ${TOOL_NAME_MAX_LEN} caracteres).` }
    }
    toolName = trimmed.length > 0 ? trimmed : null
  }

  return { ok: true, category: category as FeedbackCategory, message, toolName }
}

/** A promoter's field report may only be one of these two (the form offers no 'mcp-tool'). */
export const PROMOTER_REPORT_CATEGORIES = ['feature', 'bug'] as const
export type PromoterReportCategory = (typeof PROMOTER_REPORT_CATEGORIES)[number]

export type PromoterReportValidation =
  | { ok: true; category: PromoterReportCategory; message: string }
  | { ok: false; error: string }

/** Validates a promoter's «Reportar» body. Reuses the message bounds of `send_feedback`, narrows the category. */
export function validatePromoterReport(body: Record<string, unknown> | null | undefined): PromoterReportValidation {
  const category = typeof body?.category === 'string' ? body.category : ''
  if (!PROMOTER_REPORT_CATEGORIES.includes(category as PromoterReportCategory)) {
    return { ok: false, error: `category debe ser una de: ${PROMOTER_REPORT_CATEGORIES.join(', ')}.` }
  }
  const checked = validateFeedbackInput({ category, message: body?.message })
  if (!checked.ok) return checked
  return { ok: true, category: category as PromoterReportCategory, message: checked.message }
}

/**
 * The row a promoter's report becomes. The author is the PROMOTER the session resolved, never anything the body says;
 * the label is their name and code so /admin/feedback reads «Ana (PRM-X)», the same shape a partner's has.
 */
export function promoterFeedbackRow(
  promoter: { id: string; code: string; name: string | null },
  report: { category: PromoterReportCategory; message: string },
) {
  return {
    author_kind: 'promoter' as const,
    author_id: promoter.id,
    author_label: promoter.name ? `${promoter.name} (${promoter.code})` : promoter.code,
    category: report.category,
    tool_name: null,
    message: report.message,
  }
}
