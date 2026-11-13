import { BuyerCopyText } from '@/app/components/BuyerPresentationContext'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import BuyerNotificationPreferences from './BuyerNotificationPreferences'

export const metadata = { title: { absolute: 'Notificaciones — Miyagi Sánchez' } }

// Buyer preference center (epic #5b). Signed-in buyers only — prefs are
// clerk_user_id-keyed; guests keep today's transactional emails to their order
// address (handled by the dispatchToBuyer guest fall-through, not here).
export default async function NotificacionesPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  return (
    <div className="max-w-lg mx-auto px-4 py-8">
      <header className="mb-6">
        <Link
          href="/account"
          className="text-sm text-[var(--color-muted)] no-underline hover:text-[var(--color-foreground)]"
        >
          <BuyerCopyText copyKey="account.notificaciones.page.b2cbd5da" /></Link>
        <h1 className="mt-2 text-xl font-bold"><BuyerCopyText copyKey="account.notificaciones.page.6d60adc4" /></h1>
        <p className="text-sm text-[var(--color-muted)]">
          <BuyerCopyText copyKey="account.notificaciones.page.07d982a7" /></p>
      </header>

      <BuyerNotificationPreferences />
    </div>
  )
}
