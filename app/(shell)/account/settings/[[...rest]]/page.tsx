import { redirect } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import LazyUserProfile from '@/app/components/clerk-lazy/LazyUserProfile'

export const metadata = { title: { absolute: 'Configuración de cuenta — Miyagi Sánchez' } }

// Clerk-hosted account management (email, password, sessions, delete account).
// `/account` has no middleware.ts auth gate (only /shop/manage(.*) is in
// isProtected), so this page enforces auth itself, same as /account/page.tsx.
//
// Catch-all segment ([[...rest]]) is required by Clerk's path-based routing so
// <UserProfile /> can render its multi-step flows (email verification, MFA…)
// under this one path.
export default async function AccountSettingsPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <LazyUserProfile
        routing="path"
        path="/account/settings"
        appearance={{
          variables: {
            // Direct hex values, not var(--color-*) — Clerk's color-mix()
            // theming doesn't reliably resolve CSS custom properties.
            // Mirrors app/globals.css: --color-accent, --color-background, --r-sm.
            colorPrimary: '#1d6f42',
            colorBackground: '#f9f9f7',
            borderRadius: '8px',
          },
        }}
      />
    </div>
  )
}
