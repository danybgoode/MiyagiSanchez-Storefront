import { currentUser } from '@clerk/nextjs/server'
import { headers } from 'next/headers'
import { getActiveDealForBuyer } from '@/lib/active-deal'
import { db } from '@/lib/supabase'
import {
  ListingPage as renderListingPage,
  generateListingMetadata as renderListingMetadata,
  type ListingRequestContext,
} from './ListingRenderer'

type MetadataArgs = Parameters<typeof renderListingMetadata>[0]
type PageArgs = Parameters<typeof renderListingPage>[0]

async function requestChannel(): Promise<Pick<ListingRequestContext, 'channelSlug' | 'customDomain'>> {
  const requestHeaders = await headers()
  return {
    channelSlug: requestHeaders.get('x-miyagi-shop-slug'),
    customDomain: requestHeaders.get('x-miyagi-domain'),
  }
}

/**
 * The platform's shop-scoped PDP (`/mx/s/<slug>/l/<id>`) passes the shop slug
 * from the URL. It replaces the middleware channel headers ONLY for that route;
 * on a platform host those headers are stripped anyway, so nothing else changes.
 */
type ShopScope = { shopSlug: string }

async function channelFor(scope?: ShopScope): Promise<Pick<ListingRequestContext, 'channelSlug' | 'customDomain' | 'platformShopScoped'>> {
  if (scope) return { channelSlug: scope.shopSlug, customDomain: null, platformShopScoped: true }
  return requestChannel()
}

// NOT a second parameter on the exports below: Next calls `generateMetadata(props,
// parent)`, so an extra parameter receives `parent` and fails the build's route
// type check. The shop-scoped route calls its own named entry points instead.
async function listingMetadata(args: MetadataArgs, scope?: ShopScope) {
  return renderListingMetadata({
    ...args,
    requestContext: { mode: 'dynamic', ...(await channelFor(scope)) },
  })
}

export function generateListingMetadata(args: MetadataArgs) {
  return listingMetadata(args)
}

export function generateShopScopedListingMetadata(args: MetadataArgs, scope: ShopScope) {
  return listingMetadata(args, scope)
}

export const generateMetadata = generateListingMetadata

export function ListingPage(args: PageArgs) {
  return listingPage(args)
}

export function ShopScopedListingPage(args: PageArgs, scope: ShopScope) {
  return listingPage(args, scope)
}

async function listingPage(args: PageArgs, scope?: ShopScope) {
  const [{ id }, channel, user] = await Promise.all([
    args.params,
    channelFor(scope),
    currentUser(),
  ])
  const [favorite, activeDeal] = user
    ? await Promise.all([
        db
          .from('marketplace_favorites')
          .select('id, marketplace_listings!inner(medusa_product_id)')
          .eq('clerk_user_id', user.id)
          .eq('marketplace_listings.medusa_product_id', id)
          .maybeSingle(),
        getActiveDealForBuyer(id, user.id),
      ])
    : [{ data: null }, null]

  return renderListingPage({
    ...args,
    requestContext: {
      mode: 'dynamic',
      ...channel,
      userId: user?.id ?? null,
      favorited: !!favorite.data,
      activeDeal,
      buyerPrefill: user ? {
        name: [user.firstName, user.lastName].filter(Boolean).join(' '),
        email: user.emailAddresses[0]?.emailAddress ?? '',
      } : null,
    },
  })
}

export default ListingPage
