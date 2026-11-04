/**
 * scripts/cancel-subdomain-subscriptions.ts — decision (b) of epic 08 · plans-gratis-negocio (S2.4, README D11).
 *
 * The subdomain is free now, so every live PAID subdomain subscription is cancelled at the END of its current period
 * (no lost days, no further charge) and its owner gets one email saying so. The subdomain keeps working.
 *
 *   npm run subdomain:cancel-paid                 # DRY RUN — lists them, writes and sends nothing
 *   npm run subdomain:cancel-paid -- --apply      # cancels at period end and emails
 *
 * Idempotent: a subscription already set to end is skipped (and so is never emailed twice). A Stripe read failure or
 * any failed cancel exits non-zero — a run that "succeeds" at nothing reads as a passing gate. Run with PRODUCTION
 * Stripe and Resend credentials (the VM env), after the deploy that makes the subdomain free everywhere.
 *
 * Env: STRIPE_SECRET_KEY, RESEND_API_KEY (apply only).
 */
import process from 'node:process'
import Stripe from 'stripe'
import { Resend } from 'resend'
import { CANCELLED_BY_US, NOTICE_SENT, planSubdomainCancellations, subdomainFreeEmail, type SubdomainSubLike } from '../lib/subdomain-free-cancel'

export function parseArgs(argv: readonly string[]): { ok: true; apply: boolean } | { ok: false; error: string } {
  let apply = false
  for (const arg of argv) {
    if (arg === '--apply') { apply = true; continue }
    if (arg === '--dry-run') { apply = false; continue }
    return { ok: false, error: `unknown argument: ${arg}` }
  }
  return { ok: true, apply }
}

const FROM = 'Miyagi Sánchez <noreply@miyagisanchez.com>'

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) throw new Error(parsed.error)
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY is required — refusing to run blind')
  const stripe = new Stripe(key)

  // Every subscription the subdomain checkout ever created carries metadata.kind = 'subdomain'.
  const found: Array<SubdomainSubLike & { periodEnd: number | null }> = []
  for await (const s of stripe.subscriptions.search({ query: "metadata['kind']:'subdomain'", expand: ['data.customer'], limit: 100 })) {
    const customer = s.customer as Stripe.Customer | Stripe.DeletedCustomer | string
    const item = s.items?.data?.[0] as unknown as { current_period_end?: number } | undefined
    found.push({
      id: s.id,
      status: s.status,
      cancel_at_period_end: s.cancel_at_period_end,
      metadata: (s.metadata ?? null) as Record<string, string> | null,
      customerEmail: typeof customer === 'object' && customer && !('deleted' in customer && customer.deleted) ? (customer as Stripe.Customer).email ?? null : null,
      periodEnd: item?.current_period_end ?? null,
    })
  }

  const decisions = planSubdomainCancellations(found)
  const owed = decisions.filter((d) => d.action === 'cancel' || d.action === 'notify')
  console.log(`[subdomain:cancel-paid] ${parsed.apply ? 'APPLY' : 'DRY RUN'} — ${found.length} subdomain subscription(s); ` +
    `${decisions.filter((d) => d.action === 'cancel').length} to end at period end, ${decisions.filter((d) => d.action === 'notify').length} owed the email`)
  for (const d of decisions) console.log(`  ${d.action === 'skip' ? '·' : '+'} ${d.id} (${d.action}: ${d.why})`)
  const noEmail = decisions.filter((d) => d.why === 'no_email')
  if (!parsed.apply) {
    console.log('[subdomain:cancel-paid] dry run — nothing cancelled or sent. Re-run with --apply.')
    if (noEmail.length) console.log(`  ! ${noEmail.length} have no customer email: left running, to be handled by hand.`)
    return
  }

  // Preflight (Codex, #472): never cancel anything when the email cannot be sent — the email is half of decision (b).
  const resendKey = process.env.RESEND_API_KEY
  if (!resendKey) throw new Error('RESEND_API_KEY is required for --apply — nothing was cancelled')
  const resend = new Resend(resendKey)

  const failures: string[] = []
  let cancelled = 0
  let emailed = 0
  for (const d of owed) {
    const sub = found.find((s) => s.id === d.id)!
    if (d.action === 'cancel') {
      try {
        // Marked as OURS in the same write, so a re-run can tell our cancellations from the merchant's own.
        await stripe.subscriptions.update(d.id, { cancel_at_period_end: true, metadata: { [CANCELLED_BY_US]: '1' } })
        cancelled += 1
      } catch (e) {
        failures.push(`${d.id}: cancel failed (${e instanceof Error ? e.message : String(e)})`)
        continue
      }
    }
    const mail = subdomainFreeEmail({ periodEnd: new Date((sub.periodEnd ?? Date.now() / 1000) * 1000) })
    const r = await resend.emails.send({ from: FROM, to: sub.customerEmail!, subject: mail.subject, text: mail.text, html: mail.html })
    if (r.error) { failures.push(`${d.id}: email failed (${r.error.message}) — a re-run retries it`); continue }
    emailed += 1
    try {
      await stripe.subscriptions.update(d.id, { metadata: { [NOTICE_SENT]: '1' } })
    } catch (e) {
      // Sent but not marked: a re-run would send it again. Say so loudly rather than pretend.
      failures.push(`${d.id}: email SENT but not marked (${e instanceof Error ? e.message : String(e)}) — mark metadata.${NOTICE_SENT}=1 by hand`)
    }
  }
  console.log(`[subdomain:cancel-paid] cancelled ${cancelled}; emailed ${emailed}; ${failures.length} problem(s)`)
  for (const f of failures) console.error(`  ! ${f}`)
  if (noEmail.length) console.error(`  ! ${noEmail.length} subscription(s) have no customer email and were left running — handle by hand.`)
  if (failures.length) throw new Error(`${failures.length} problem(s) — see above. Re-running retries what is owed and skips what is done.`)
}

if (process.argv[1]?.endsWith('cancel-subdomain-subscriptions.ts')) {
  main().catch((e) => {
    console.error('[subdomain:cancel-paid] FAILED:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
