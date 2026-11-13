import type { Metadata } from 'next'
import Link from 'next/link'
import { getDictionary, normalizeLocale } from '@/lib/dictionary'

const BASE_URL = 'https://miyagisanchez.com'
const PAGE_PATH = '/terminos'
const TITLE = 'Términos de uso - Miyagi Sánchez'

export const metadata: Metadata = {
  // The title already ends with the brand; `absolute` stops the layout template appending it twice.
  title: { absolute: TITLE },
  // Had no openGraph override (agent-readability-marketing-surface Story 1.2)
  // — inherited the root layout's og:url pointing at `/` instead of itself.
  alternates: { canonical: `${BASE_URL}${PAGE_PATH}` },
  openGraph: {
    type: 'website',
    locale: 'es_MX',
    url: `${BASE_URL}${PAGE_PATH}`,
    siteName: 'Miyagi Sánchez',
    title: TITLE,
  },
}

export default async function TermsPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>
}) {
  const { lang } = await searchParams
  const locale = normalizeLocale(lang)
  const dict = await getDictionary(locale)
  const ui = dict.terms

  return (
    <main className="max-w-3xl mx-auto px-4 py-10">
      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <Link href="/" className="text-xs text-[var(--color-muted)] hover:underline no-underline">
            miyagisanchez.com
          </Link>
          <h1 className="text-3xl font-bold mt-2">{ui.title}</h1>
          <p className="text-sm text-[var(--color-muted)] mt-2">{ui.subtitle}</p>
        </div>
        <Link
          href={ui.languageHref}
          className="text-sm border border-[var(--color-border)] rounded-lg px-3 py-2 no-underline hover:bg-[var(--color-surface-alt)]"
        >
          {ui.language}
        </Link>
      </div>

      <div className="space-y-6">
        {ui.sections.map((section) => (
          <section key={section.title} className="border-b border-[var(--color-border)] pb-5">
            <h2 className="text-lg font-semibold mb-2">{section.title}</h2>
            <p className="text-sm leading-6 text-[var(--color-muted)]">{section.body}</p>
          </section>
        ))}
      </div>
    </main>
  )
}
