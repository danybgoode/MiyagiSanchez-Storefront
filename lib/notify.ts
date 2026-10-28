import 'server-only'
import webpush from 'web-push'
import { db } from '@/lib/supabase'
import { logNotification } from '@/lib/notifications/log'

/**
 * Notification seam. Today: VAPID web push. Swappable to Novu/etc. later —
 * callers only ever use `notify()`, never the transport. Server-only.
 */

let configured = false
function ensureVapid(): boolean {
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  if (!pub || !priv) return false
  if (!configured) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:soporte@miyagisanchez.com', pub, priv)
    configured = true
  }
  return true
}

/**
 * Is web push actually CONFIGURED (VAPID keys present)?
 *
 * Additive and deliberately NOT a change to `notify()`'s `Promise<void>`
 * fire-and-forget contract, which every existing caller relies on.
 *
 * It exists because `notify()` returns SILENTLY when VAPID is unset — so a caller
 * that must record a DELIVERY OUTCOME cannot distinguish "sent" from "there is no
 * push transport on this deploy". The portfolio reminder rail
 * (merchant-partner-lifecycle S2.2) needs that difference: a reminder nobody could
 * receive has to be recorded as failed, not reported as sent (cross-agent review
 * round 2, PR 310 — my first fix pre-checked the SUBSCRIPTION but not the
 * TRANSPORT, so "valid subscription + missing VAPID" still recorded a false
 * success).
 *
 * Answers "could we even try?", never "did it arrive".
 */
export function pushConfigured(): boolean {
  return ensureVapid()
}

export type NotifyEvent = {
  // 'portfolio_reminder' added (Merchant Partner lifecycle · Sprint 2, Story
  // 2.2) — a STEWARD-directed reminder that a merchant in their portfolio is
  // overdue. Additive only: `public/sw.js` never switches on `kind` (it only
  // reads `title`/`body`/`url`/`tag` generically), so this widening is a
  // zero-blast-radius change to every existing caller.
  // 'onboarding_nudge' (prompt-to-shop S5.4): the day 1/3/7 reminder to finish a shop. Additive, like the one above.
  kind: 'new_message' | 'offer' | 'order' | 'portfolio_reminder' | 'onboarding_nudge'
  title: string
  body: string
  url: string
  tag?: string
}

/** Fire a push to all of a user's registered devices. No-op if push isn't
 *  configured or the user has no subscriptions. Prunes dead subscriptions. */
export async function notify(userId: string, event: NotifyEvent): Promise<void> {
  // Both early returns below are the reason this function looked like it worked for
  // years: an unconfigured transport and a user with no devices are indistinguishable
  // from a delivered push at the call site. They are now recorded as SKIPS.
  if (!ensureVapid()) {
    logNotification({ channel: 'push', outcome: 'skipped', clerkUserId: userId, subject: event.title, reason: 'unconfigured' })
    return
  }
  const { data: subs } = await db
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('clerk_user_id', userId)
  if (!subs?.length) {
    logNotification({ channel: 'push', outcome: 'skipped', clerkUserId: userId, subject: event.title, reason: 'no_subscription' })
    return
  }

  const payload = JSON.stringify({
    title: event.title,
    body: event.body,
    url: event.url,
    tag: event.tag ?? event.kind,
  })

  let delivered = 0
  let failed = 0
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        )
        delivered += 1
      } catch (err: unknown) {
        failed += 1
        const code = (err as { statusCode?: number }).statusCode
        if (code === 404 || code === 410) {
          await db.from('push_subscriptions').delete().eq('id', s.id)
        }
      }
    }),
  )

  // A partial fan-out is a send, not a failure — but the counts are kept so an
  // audit can tell one device from five.
  logNotification({
    channel: 'push',
    outcome: delivered > 0 ? 'sent' : 'failed',
    clerkUserId: userId,
    subject: event.title,
    reason: delivered > 0 ? null : 'all_endpoints_rejected',
    context: { kind: event.kind, delivered, failed },
  })
}
