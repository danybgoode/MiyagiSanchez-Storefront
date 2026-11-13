import Link from 'next/link'
import { db } from '@/lib/supabase'
import { getDictionary, normalizeLocale } from '@/lib/dictionary'
import {
  campaignDescription,
  campaignIsWithinEntryWindow,
  campaignTerms,
  campaignTitle,
  getCampaignBySlug,
  getSweepstakesSettings,
  publicSweepstakesUrl,
} from '@/lib/sweepstakes'
import { shopUrlFor } from '@/lib/market-url'
import { SITE_ORIGIN } from '@/lib/market-seo'
import SweepstakesEntryClient from './SweepstakesEntryClient'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ lang?: string }>
}) {
  const { slug } = await params
  const { lang } = await searchParams
  const locale = normalizeLocale(lang)
  const campaign = await getCampaignBySlug(slug)
  if (!campaign) return { title: { absolute: 'Sweepstakes - Miyagi Sánchez' } }
  return {
    title: campaignTitle(campaign, locale),
    description: campaignDescription(campaign, locale),
    openGraph: campaign.prize_image_url ? { images: [{ url: campaign.prize_image_url }] } : undefined,
  }
}

function StateMessage({ text, locale }: { text: string; locale: 'es' | 'en' }) {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12 bg-[var(--color-background)]">
      <div className="max-w-md w-full border border-[var(--color-border)] rounded-xl p-6 text-center">
        <Link href={`/terminos?lang=${locale}`} className="text-xs text-[var(--color-muted)] no-underline hover:underline">
          miyagisanchez.com
        </Link>
        <h1 className="mt-4 text-xl font-semibold">{text}</h1>
      </div>
    </main>
  )
}

export default async function SweepstakesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ lang?: string }>
}) {
  const [{ slug }, { lang }] = await Promise.all([params, searchParams])
  const locale = normalizeLocale(lang)
  const dict = await getDictionary(locale)
  const ui = dict.sweepstakes.public
  const [settings, campaign] = await Promise.all([getSweepstakesSettings(), getCampaignBySlug(slug)])

  if (!campaign) return <StateMessage text={ui.notFound} locale={locale} />
  if (!settings.enabled) return <StateMessage text={ui.paused} locale={locale} />

  const now = new Date().getTime()
  const starts = campaign.starts_at ? new Date(campaign.starts_at).getTime() : null
  const ends = campaign.ends_at ? new Date(campaign.ends_at).getTime() : null
  const isEnded = !!ends && now >= ends
  const isTooEarly = !!starts && now < starts
  const active = campaignIsWithinEntryWindow(campaign)

  const { data: shop } = await db
    .from('marketplace_shops')
    .select('slug, name')
    .eq('id', campaign.shop_id)
    .maybeSingle()

  return (
    <SweepstakesEntryClient
      slug={campaign.slug}
      locale={locale}
      ui={ui}
      title={campaignTitle(campaign, locale)}
      description={campaignDescription(campaign, locale)}
      terms={campaignTerms(campaign, locale)}
      prizeImageUrl={campaign.prize_image_url}
      endsAt={campaign.ends_at}
      publicUrl={publicSweepstakesUrl(campaign.slug, locale)}
      languageHref={`/g/${campaign.slug}?${ui.languageHrefSuffix}`}
      status={active ? 'active' : isEnded || campaign.status === 'completed' ? 'ended' : isTooEarly ? 'not_live' : 'not_live'}
      purchaseBonusEnabled={campaign.purchase_bonus_enabled}
      purchaseTicketValue={campaign.purchase_ticket_value}
      shopUrl={shop?.slug ? shopUrlFor(SITE_ORIGIN, shop.slug) : null}
      shopName={shop?.name ?? null}
    />
  )
}
