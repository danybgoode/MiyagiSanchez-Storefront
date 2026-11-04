/**
 * Ending the paid subdomain subscriptions now that the subdomain is free (epic 08 · plans-gratis-negocio S2.4,
 * decision b: "cancel them at the end of their current period, with an email saying the subdomain is free now").
 *
 * Pure: which Stripe subscriptions to end, which owners are still owed the email, and the email itself. The I/O shell
 * is `scripts/cancel-subdomain-subscriptions.ts` (dry run by default). Ending at PERIOD END means nobody loses a day
 * they paid for and nobody is charged again; the subdomain itself never goes away (it is free).
 *
 * The notice is RETRYABLE (Codex, #472): the script marks every subscription IT cancels
 * (`metadata.subdomain_free_cancel = '1'`) and marks the email only once it was actually sent
 * (`metadata.subdomain_free_notice = '1'`). A subscription we cancelled whose owner was not yet emailed is `notify`,
 * so a re-run sends what a failed run could not — never twice, and never to a merchant who cancelled on their own.
 * A subscription with no customer email is never cancelled: the email is half of the decision.
 */

/** The Stripe fields the decision reads. */
export type SubdomainSubLike = {
  id: string
  status: string
  cancel_at_period_end: boolean
  metadata: Record<string, string> | null
  customerEmail: string | null
}

export const CANCELLED_BY_US = 'subdomain_free_cancel'
export const NOTICE_SENT = 'subdomain_free_notice'

export type CancelDecision = {
  id: string
  action: 'cancel' | 'notify' | 'skip'
  why: 'live_subdomain' | 'notice_owed' | 'not_subdomain' | 'already_ending' | 'not_live' | 'done' | 'no_email'
}

const LIVE = new Set(['active', 'trialing', 'past_due'])

export function planSubdomainCancellations(subs: readonly SubdomainSubLike[]): CancelDecision[] {
  return subs.map((s): CancelDecision => {
    const meta = s.metadata ?? {}
    if (meta.kind !== 'subdomain') return { id: s.id, action: 'skip', why: 'not_subdomain' }
    if (!LIVE.has(s.status)) return { id: s.id, action: 'skip', why: 'not_live' }
    if (s.cancel_at_period_end) {
      if (meta[CANCELLED_BY_US] !== '1') return { id: s.id, action: 'skip', why: 'already_ending' }
      if (meta[NOTICE_SENT] === '1') return { id: s.id, action: 'skip', why: 'done' }
      return s.customerEmail ? { id: s.id, action: 'notify', why: 'notice_owed' } : { id: s.id, action: 'skip', why: 'no_email' }
    }
    if (!s.customerEmail) return { id: s.id, action: 'skip', why: 'no_email' }
    return { id: s.id, action: 'cancel', why: 'live_subdomain' }
  })
}

/** The email (es-MX) to the owner of a cancelled subdomain subscription. `periodEnd` is when the last paid period ends. */
export function subdomainFreeEmail(input: { periodEnd: Date }): { subject: string; text: string; html: string } {
  const date = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' }).format(input.periodEnd)
  const subject = 'Tu subdominio ahora es gratis'
  const lines = [
    'Buenas noticias: en Miyagi Sánchez el subdominio de tu tienda ahora es gratis en todos los planes.',
    `Por eso cancelamos tu suscripción del subdominio. Termina el ${date}, al final del periodo que ya pagaste, y no te volveremos a cobrar.`,
    'Tu subdominio sigue funcionando igual, hoy y después de esa fecha. No tienes que hacer nada.',
    'Si quieres tu propio dominio, Mercado Libre sincronizado y más ayuda de la IA, todo eso viene en el plan Negocio: https://miyagisanchez.com/shop/manage/negocio',
  ]
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)
  return {
    subject,
    text: lines.join('\n\n'),
    html: `<h1 style="font-size:20px">Tu subdominio ahora es gratis</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}`,
  }
}
