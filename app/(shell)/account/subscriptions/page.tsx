import { redirect } from 'next/navigation'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import AccountSubscriptionsClient from './AccountSubscriptionsClient'

export const metadata = { title: { absolute: 'Mis suscripciones — Miyagi Sánchez' } }

export default async function AccountSubscriptionsPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const buyerEmail = user.emailAddresses?.[0]?.emailAddress ?? ''

  const { data: subscriptions } = await db
    .from('marketplace_subscriptions')
    .select(`
      id, status, payment_method, current_period_start, current_period_end,
      cancel_at_period_end, created_at,
      marketplace_listings!inner(id, title, price_cents, currency, metadata),
      marketplace_shops!inner(id, name, slug)
    `)
    .or(`buyer_clerk_user_id.eq.${user.id},buyer_email.ilike.${buyerEmail}`)
    .in('status', ['active', 'trialing', 'past_due', 'pending_confirmation', 'canceled'])
    .order('created_at', { ascending: false })
    .limit(50)

  // Fetch content for active subscriptions
  const activeShopIds = [...new Set(
    (subscriptions ?? [])
      .filter(s => s.status === 'active' || s.status === 'trialing')
      .map(s => (s.marketplace_shops as unknown as { id: string }).id),
  )]

  const { data: content } = activeShopIds.length > 0
    ? await db
        .from('marketplace_subscription_content')
        .select('id, shop_id, listing_id, title, body, file_url, file_type, created_at')
        .in('shop_id', activeShopIds)
        .eq('is_published', true)
        .order('created_at', { ascending: false })
        .limit(50)
    : { data: [] }

  return (
    <AccountSubscriptionsClient
      subscriptions={subscriptions ?? []}
      content={content ?? []}
    />
  )
}
