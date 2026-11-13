import { BuyerCopyText } from '@/app/components/BuyerPresentationContext'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import LazyUserButton from '@/app/components/clerk-lazy/LazyUserButton'
import { ACCOUNT_HUB_LINKS } from '@/lib/account-hub-links'

export const metadata = { title: { absolute: 'Mi cuenta — Miyagi Sánchez' } }

// Account hub. Reachable from the PWA "Perfil" tab and the desktop user menu.
// Previously /account had no page → the mobile nav linked here and 404'd.
const LINKS = ACCOUNT_HUB_LINKS

export default async function AccountPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const name = user.firstName || user.username
  const email = user.emailAddresses?.[0]?.emailAddress ?? ''

  return (
    <div className="max-w-lg mx-auto px-4 py-8">
      <header className="flex items-center justify-between gap-4 mb-8">
        <div className="min-w-0">
          <h1 className="text-xl font-bold truncate"><BuyerCopyText copyKey="account.page.9a62ab6f" />{' '}{name ?? <BuyerCopyText copyKey="account.fallbackName" />}</h1>
          {email && <p className="text-sm text-[var(--color-muted)] truncate">{email}</p>}
        </div>
        <LazyUserButton />
      </header>

      <nav className="flex flex-col gap-2">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="flex items-center gap-4 border border-[var(--color-border)] rounded-xl p-4 no-underline hover:bg-[var(--color-surface-alt)] transition-colors"
          >
            <i className={l.icon} style={{ fontSize: 22 }} aria-hidden />
            <span className="flex-1 min-w-0">
              <span className="block font-medium text-[var(--color-foreground)]">{l.label}</span>
              <span className="block text-xs text-[var(--color-muted)]">{l.desc}</span>
            </span>
            <i className="iconoir-arrow-right text-[var(--color-muted)]" style={{ fontSize: 18 }} aria-hidden />
          </Link>
        ))}
      </nav>

      <div className="mt-8 text-center">
        <Link
          href="/sell"
          className="text-sm text-[var(--color-muted)] no-underline hover:text-[var(--color-foreground)]"
        >
          <BuyerCopyText copyKey="account.page.f1134fb1" /></Link>
      </div>
    </div>
  )
}
