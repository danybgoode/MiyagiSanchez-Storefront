/**
 * lib/preferred-channels.ts
 *
 * THE single source for the merchant "preferred contact channel" vocabulary —
 * the values, their es-MX labels, and the type guard.
 *
 * Created in response to fresh-reviewer finding 2 on PR 308
 * (merchant-partner-lifecycle S1). Before this file, the vocabulary existed in
 * FOUR places and had already drifted:
 *
 *   - `app/api/promoter/relationship/route.ts`        — `PREFERRED_CHANNELS` (validator)
 *   - `lib/fundadoras-application.ts`                — `PREFERRED_CHANNELS` (validator)
 *   - `app/(shell)/promotor/cerrar/NegocioStep.tsx` (promoter-panel, from `promotorPanel.negocio.channels`) — labels, `email: 'Correo'`
 *   - `lib/portfolio/resolver.ts`                    — labels, `email: 'Correo electrónico'`
 *
 * Two identical value arrays and two label maps that disagreed on one string.
 * That is the exact failure `Roadmap/LEARNINGS.md` calls *"a paraphrased
 * contract drifts permissive"* and that README D3 forbids — and the same PR that
 * introduced the fourth copy had already extracted `STAGE_LABEL` into
 * `lib/merchant-stage-labels.ts` for precisely this reason. This file gives the
 * channel vocabulary the same treatment.
 *
 * ZERO-IMPORT on purpose (no `server-only`, no `next/*`, no Clerk, no Supabase):
 * a validator on the API path, a `'use client'` form, a server component and an
 * `api` Playwright spec all have to be able to load it.
 *
 * THE AUTHORITATIVE list is the database: `merchant_relationships.preferred_channel`
 * carries a CHECK constraint over exactly these five values
 * (`supabase/migrations/20260723100000_activation_crm_s1.sql`). This file mirrors
 * that CHECK, and `PREFERRED_CHANNEL_LABEL` is typed
 * `Record<PreferredChannel, string>` so adding a sixth value without adding its
 * label fails `tsc` rather than silently rendering a merchant with no channel —
 * which is what a `Record<string, string>` allowed.
 */

export const PREFERRED_CHANNELS = ['whatsapp', 'phone', 'email', 'instagram', 'in_person'] as const

export type PreferredChannel = (typeof PREFERRED_CHANNELS)[number]

/** es-MX labels, one per value. Exhaustive BY TYPE — see the file header. */
export const PREFERRED_CHANNEL_LABEL: Readonly<Record<PreferredChannel, string>> = {
  whatsapp: 'WhatsApp',
  phone: 'Teléfono',
  email: 'Correo electrónico',
  instagram: 'Instagram',
  in_person: 'En persona',
}

/**
 * Narrowing guard for an unknown/caller-supplied value.
 *
 * Uses an explicit `.includes` over the value list rather than `value in
 * PREFERRED_CHANNEL_LABEL` — the `in` form walks the prototype chain, so
 * `'toString'` would test true and resolve to a FUNCTION where a Spanish label
 * belongs. That was a real bug in this epic's first cut of the resolver
 * (PR 308, caught red by `e2e/portfolio-resolver.spec.ts`); keeping the guard
 * here means no future call site can reintroduce it.
 */
export function isPreferredChannel(value: unknown): value is PreferredChannel {
  return typeof value === 'string' && (PREFERRED_CHANNELS as readonly string[]).includes(value)
}

/** The label for a stored value, or `null` when the value is absent or not one
 *  of the five. Never a placeholder, never a raw slug leaked to a UI. */
export function preferredChannelLabel(value: unknown): string | null {
  return isPreferredChannel(value) ? PREFERRED_CHANNEL_LABEL[value] : null
}
