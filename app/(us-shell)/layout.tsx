import type { Metadata, Viewport } from 'next'
import MarketDocument, { marketRootMetadata, ROOT_VIEWPORT } from '@/app/components/MarketDocument'
import PlatformShell from '@/app/components/PlatformShell'
import PlatformThemeScript from '@/app/components/PlatformThemeScript'
import ReferralAttribution from '@/app/components/ReferralAttribution'
import { AgentContextProvider } from '@/app/components/AgentContext'
import { layoutLanguage } from '@/lib/site-language-server'
import '@/app/globals.css'
import '@/app/iconoir-subset.css'

export const metadata: Metadata = marketRootMetadata('us')
export const viewport: Viewport = ROOT_VIEWPORT

/** Static en-US catalog root. Literal children own market context; no header inference. */
/**
 * Per request since 2026-11-13: the chrome renders in the visitor's stored language (`lib/site-language.ts`), and a
 * cookie-dependent render must never be served from a shared cache. The data underneath stays cached at the fetch /
 * `unstable_cache` layer, so this costs a render, not a Medusa round-trip.
 */
export default async function UnitedStatesCatalogLayout({ children }: { children: React.ReactNode }) {
  const language = await layoutLanguage()
  return (
    <MarketDocument market="us" language={language}>
      <AgentContextProvider>
        <PlatformThemeScript />
        <PlatformShell market="us" language={language} platformThemeEligible>{children}</PlatformShell>
        <ReferralAttribution />
      </AgentContextProvider>
    </MarketDocument>
  )
}
