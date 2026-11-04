/**
 * Ending the paid subdomain subscriptions now that the subdomain is free (epic 08 · plans-gratis-negocio S2.4,
 * decision b: "cancel them at the end of their current period, with an email saying the subdomain is free now").
 *
 * Pure: which Stripe subscriptions to end, and the email each owner gets. The I/O shell is
 * `scripts/cancel-subdomain-subscriptions.ts` (dry run by default). Ending at PERIOD END means nobody loses a day they
 * paid for and nobody is charged again; the subdomain itself never goes away (it is free).
 */

/** The Stripe fields the decision reads. */
export type SubdomainSubLike = {
  id: string
  status: string
  cancel_at_period_end: boolean
  metadata: Record<string, string> | null
  customerEmail: string | null
}

export type CancelDecision = { id: string; action: 'cancel' | 'skip'; why: 'live_subdomain' | 'not_subdomain' | 'already_ending' | 'not_live' }

const LIVE = new Set(['active', 'trialing', 'past_due'])

export function planSubdomainCancellations(subs: readonly SubdomainSubLike[]): CancelDecision[] {
  return subs.map((s) => {
    if (s.metadata?.kind !== 'subdomain') return { id: s.id, action: 'skip', why: 'not_subdomain' }
    if (!LIVE.has(s.status)) return { id: s.id, action: 'skip', why: 'not_live' }
    if (s.cancel_at_period_end) return { id: s.id, action: 'skip', why: 'already_ending' }
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
