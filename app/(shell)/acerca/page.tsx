import { getLanguagePreference } from '@/lib/site-language-server'
import { headers } from 'next/headers'
import { normalizeLocale } from '@/lib/dictionary'
import { ABOUT_PAGE, aboutCopy } from '@/lib/about-content'
import { getOverriddenAboutPage, getOverriddenAboutSections } from '@/lib/about-content-overrides'
import { AboutPage } from './_components/AboutSections'
import { getShop } from '@/lib/listings'
import { assertShopNotPreviewPrivate, isShopPreviewPrivateBySlug } from '@/lib/preview-access'
import AcercaBody from '../_shop-content/AcercaBody'
import type { Metadata } from 'next'
import { CONTACT_EMAIL } from '@/lib/contact'

const BASE_URL = 'https://miyagisanchez.com'
const PAGE_PATH = '/acerca'
const meta = ABOUT_PAGE.es

type AcercaPageProps = {
  searchParams: Promise<{ lang?: string }>
}

// Own-shop premium presentation (epic 07, Sprint 3): this same path also
// serves a shop's own Acerca page on subdomain/custom domain — resolved from
// the unspoofable `x-miyagi-shop-slug` header middleware.ts sets. Absent
// (platform host) ⇒ everything below is byte-for-byte the original platform
// About-Miyagi-Sánchez page.
async function resolveChannelShop() {
  const channelSlug = (await headers()).get('x-miyagi-shop-slug')
  if (!channelSlug) return null
  return getShop(channelSlug)
}

export async function generateMetadata(): Promise<Metadata> {
  const shop = await resolveChannelShop()
  // Don't leak a preview-private shop's name in the <title>.
  if (shop && !(await isShopPreviewPrivateBySlug(shop.slug, shop.clerk_user_id))) {
    return { title: `Acerca — ${shop.name}` }
  }
  return {
    title: meta.metaTitle,
    description: meta.metaDescription,
    alternates: { canonical: `${BASE_URL}${PAGE_PATH}` },
    openGraph: {
      type: 'website',
      locale: 'es_MX',
      url: `${BASE_URL}${PAGE_PATH}`,
      siteName: 'Miyagi Sánchez',
      title: meta.metaTitle,
      description: meta.metaDescription,
    },
  }
}

export default async function AcercaPage({ searchParams }: AcercaPageProps) {
  const shop = await resolveChannelShop()
  if (shop) {
    // Consent-safe previews: the CHANNEL-native page (subdomain / custom domain
    // serve it directly — middleware rewrites only `/` and `/convocatoria`), so
    // it needs the guard independently of the /s/[slug]/acerca variant.
    await assertShopNotPreviewPrivate(shop)
    return <AcercaBody shop={shop} basePath="" language={await getLanguagePreference()} />
  }

  const { lang } = await searchParams
  const locale = normalizeLocale(lang)
  const [page, sections] = await Promise.all([
    getOverriddenAboutPage(locale),
    getOverriddenAboutSections(),
  ])

  // JSON-LD Organization — grounded description from the what_is section (real text, agent-fetchable).
  const whatIs = sections.find((s) => s.id === 'what_is')
  const description = whatIs ? aboutCopy(whatIs, locale).body[0] : page.metaDescription
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Miyagi Sánchez',
    url: BASE_URL,
    // schema.org/Organization.email — the machine-readable half of the same
    // fact the page states in words below. An agent asking "how do I reach
    // this marketplace" should not have to scrape a footer.
    email: CONTACT_EMAIL,
    description,
    inLanguage: locale === 'en' ? 'en' : 'es-MX',
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <AboutPage locale={locale} page={page} sections={sections} />
    </>
  )
}
