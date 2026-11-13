import Link from 'next/link'
import { db } from '@/lib/supabase'
import ShopSectionNav from './ShopSectionNav'
import ShopThemeShell from './ShopThemeShell'
import { getDictionary } from '@/lib/dictionary'
import { resolveMarketPresentation } from '@/lib/market-presentation'
import { readPublicSellerMarket } from '@/lib/owned-market'
import { formatWallDate } from '@/app/(shell)/_wall/WallCopy'
import type { ShopPresentationContext } from '@/lib/shop-presentation/context'
import type { MarketplaceEvent } from '@/lib/events-types'

/**
 * Living Shop — the public Events index (epic 07, Story 3.4).
 *
 * 🚨 `marketplace_events` held ZERO rows across the whole platform when this was
 * built (epic D7), so the only branch a live smoke can currently observe is the
 * empty one. It is built against the real primitive anyway — a fixture-only
 * Events index that exists to make a screenshot is exactly what the operating
 * posture forbids — and the epic's dogfood must create a real event or name the
 * gap.
 *
 * Upcoming events lead. Past ones are listed underneath rather than deleted: a
 * merchant who runs events has a history worth showing, and a visitor who
 * arrives late needs to learn the thing already happened instead of finding
 * nothing. Cancelled events do not appear at all — an invitation that was
 * withdrawn is not history, it is noise.
 */

const PAST_LIMIT = 6

export default async function EventsIndexBody({ ctx }: { ctx: ShopPresentationContext }) {
  const market = readPublicSellerMarket(ctx.shop)?.market_code ?? 'mx'
  const presentation = resolveMarketPresentation(market, ctx.language)
  const dict = await getDictionary(presentation.language)
  const copy = dict.buyerCopy

  // Scoped by the Supabase mirror id, so another seller's events cannot appear
  // here even on a shared slug — the same isolation every owned-host route needs.
  const { data } = ctx.wallShopId
    ? await db
        .from('marketplace_events')
        .select('slug, title, starts_at, venue_name, status')
        .eq('shop_id', ctx.wallShopId)
        .eq('status', 'active')
        .order('starts_at', { ascending: true })
        .limit(100)
    : { data: [] as Array<Pick<MarketplaceEvent, 'slug' | 'title' | 'starts_at' | 'venue_name' | 'status'>> }

  // ONE timestamp for both partitions, matching the precedent in
  // `app/(mx-site)/mx/page.tsx`: a server-render snapshot shared by every read,
  // not client render state. Reading the clock inside each filter instead could
  // straddle an event's start time and put the same event in both lists.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now()
  const events = data ?? []
  const upcoming = events.filter((e) => Date.parse(e.starts_at) >= now)
  const past = events.filter((e) => Date.parse(e.starts_at) < now).reverse().slice(0, PAST_LIMIT)

  const row = (event: typeof events[number], dimmed: boolean) => (
    <li key={event.slug}>
      <Link
        href={`/e/${event.slug}`}
        className={`flex flex-col gap-0.5 p-4 rounded-xl border border-[var(--color-border)] no-underline text-[var(--color-text)] hover:border-[var(--color-text)] transition-colors ${dimmed ? 'opacity-60' : ''}`}
      >
        <span className="font-medium">{event.title}</span>
        <span className="text-sm text-[var(--color-muted)]">
          {formatWallDate(event.starts_at, presentation.htmlLang)} · {event.venue_name}
        </span>
      </Link>
    </li>
  )

  return (
    <ShopThemeShell theme={ctx.theme} accent={ctx.accent}>
    <div className="pb-12">
      <ShopSectionNav
        shopName={ctx.shop.name}
        logoUrl={ctx.shop.logo_url ?? null}
        config={ctx.sections}
        availability={ctx.availability}
        basePath={ctx.basePath}
        active="events"
        accent={ctx.accent}
        activeTextColor={ctx.accentTextColor}
        copy={copy}
      />

      <div className="max-w-4xl mx-auto px-4">
        <h1 className="text-xl font-bold mb-4">{copy['shopSections.eventsTitle']}</h1>

        {upcoming.length === 0 ? (
          <p className="text-center py-12 text-[var(--color-muted)]">{copy['shopSections.eventsEmpty']}</p>
        ) : (
          <ul className="flex flex-col gap-2 list-none p-0 m-0">{upcoming.map((e) => row(e, false))}</ul>
        )}

        {past.length > 0 && (
          <>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)] mt-8 mb-3">
              {copy['shopSections.eventsPastTitle']}
            </h2>
            <ul className="flex flex-col gap-2 list-none p-0 m-0">{past.map((e) => row(e, true))}</ul>
          </>
        )}
      </div>
    </div>
    </ShopThemeShell>
  )
}
