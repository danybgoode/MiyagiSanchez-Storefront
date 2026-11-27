import 'server-only'
import { timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/supabase'
import { DELETED_STATUS } from '@/lib/listing-lifecycle'

/**
 * GET /api/internal/tally/{summary|members|log} — the operator's members view in tally
 * (tally.goldenfrijoles.com, the owner's analytics app). READ-ONLY.
 *
 * Daniel asked for it on 2026-11-27 ("members lists have to be available in all projects").
 * tally calls it server-side with `Authorization: Bearer $TALLY_CONNECTOR_KEY` and shows the
 * answer to the master-key holder only; it stores nothing. A missing, wrong or unset key is a
 * plain 404, indistinguishable from an absent route. No page or session reaches it.
 *
 * Members are Clerk users (paged, sorted and searched by Clerk itself), each joined to the shop
 * they own in the `marketplace_shops` mirror and that shop's live listings.
 */

export const dynamic = 'force-dynamic'

type Col = { key: string; label: string; type?: 'text' | 'number' | 'date'; sort?: boolean }

const notFound = () => new Response(null, { status: 404 })
const json = (body: unknown) => Response.json(body, { headers: { 'Cache-Control': 'private, no-store' } })
const int = (v: string | null, d: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Number.parseInt(v ?? '', 10) || d))
const PAGE = 1000 // PostgREST's row cap in this project (LEARNINGS.md)

function authorized(request: Request): boolean {
  const secret = process.env.TALLY_CONNECTOR_KEY?.trim()
  const header = request.headers.get('authorization')
  if (!secret || secret.length < 32 || !header?.startsWith('Bearer ')) return false
  const given = Buffer.from(header.slice('Bearer '.length).trim())
  const expected = Buffer.from(secret)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function clerk() {
  const { clerkClient } = await import('@clerk/nextjs/server')
  return clerkClient()
}

async function allRows<T>(read: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>) {
  const out: T[] = []
  for (let from = 0; from < 50 * PAGE; from += PAGE) {
    const { data, error } = await read(from, from + PAGE - 1)
    if (error) throw error
    out.push(...(data ?? []))
    if ((data ?? []).length < PAGE) break
  }
  return out
}

type Shop = { id: string; slug: string | null; name: string | null; clerk_user_id: string | null; created_at: string }

async function shopsAndListings() {
  const [shops, listings] = await Promise.all([
    allRows<Shop>((a, b) =>
      db.from('marketplace_shops').select('id, slug, name, clerk_user_id, created_at').order('id').range(a, b),
    ),
    allRows<{ shop_id: string | null; created_at: string }>((a, b) =>
      db.from('marketplace_listings').select('shop_id, created_at').neq('status', DELETED_STATUS).order('id').range(a, b),
    ),
  ])
  const perShop = new Map<string, number>()
  for (const l of listings) if (l.shop_id) perShop.set(l.shop_id, (perShop.get(l.shop_id) ?? 0) + 1)
  return { shops, listings, perShop }
}

const MEMBER_SORT: Record<string, string> = {
  created_at: 'created_at',
  last_seen: 'last_sign_in_at',
  last_active: 'last_active_at',
  email: 'email_address',
  name: 'first_name',
}

const MEMBER_COLS: Col[] = [
  { key: 'name', label: 'Name', sort: true },
  { key: 'email', label: 'Email', sort: true },
  { key: 'shop', label: 'Shop' },
  { key: 'listings', label: 'Listings', type: 'number' },
  { key: 'created_at', label: 'Joined', type: 'date', sort: true },
  { key: 'last_seen', label: 'Last sign-in', type: 'date', sort: true },
  { key: 'last_active', label: 'Last active', type: 'date', sort: true },
]

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null)

async function members(url: URL) {
  const size = int(url.searchParams.get('size'), 25, 5, 200)
  const page = int(url.searchParams.get('page'), 1, 1, 100000)
  const sortKey = MEMBER_SORT[url.searchParams.get('sort') ?? ''] ?? 'last_active_at'
  const dir = url.searchParams.get('dir') === 'asc' ? '+' : '-'
  const q = (url.searchParams.get('q') ?? '').trim()
  const client = await clerk()
  const [{ data, totalCount }, { shops, perShop }] = await Promise.all([
    client.users.getUserList({
      limit: size,
      offset: (page - 1) * size,
      orderBy: `${dir}${sortKey}` as '-created_at', // one of Clerk's sortable fields (MEMBER_SORT)
      ...(q ? { query: q } : {}),
    }),
    shopsAndListings(),
  ])
  const shopOf = new Map(shops.filter((s) => s.clerk_user_id).map((s) => [s.clerk_user_id as string, s]))
  return {
    total: totalCount,
    columns: MEMBER_COLS,
    rows: data.map((u) => {
      const shop = shopOf.get(u.id)
      return {
        name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || '—',
        email: u.primaryEmailAddress?.emailAddress ?? u.emailAddresses[0]?.emailAddress ?? '—',
        shop: shop ? (shop.name ?? shop.slug ?? '—') : '—',
        listings: shop ? (perShop.get(shop.id) ?? 0) : 0,
        created_at: iso(u.createdAt),
        last_seen: iso(u.lastSignInAt),
        last_active: iso(u.lastActiveAt),
      }
    }),
  }
}

async function count(table: string, since?: string) {
  let q = db.from(table).select('*', { count: 'exact', head: true })
  if (since) q = q.gte('created_at', since)
  const { count: n, error } = await q
  return error ? null : (n ?? 0)
}

async function summary(days: number) {
  const since = new Date(Date.now() - days * 864e5).toISOString()
  const today = new Date(Date.now() - 864e5).toISOString()
  const client = await clerk()
  const users: Array<{ createdAt: number; lastActiveAt: number | null }> = []
  for (let offset = 0; offset < 20000; offset += 500) {
    const { data } = await client.users.getUserList({ limit: 500, offset, orderBy: '-created_at' })
    users.push(...data.map((u) => ({ createdAt: u.createdAt, lastActiveAt: u.lastActiveAt })))
    if (data.length < 500) break
  }
  const { shops, listings, perShop } = await shopsAndListings()
  const [conversations, favorites, subscriptions, conversationsRange] = await Promise.all([
    count('marketplace_conversations'),
    count('marketplace_favorites'),
    count('marketplace_subscriptions'),
    count('marketplace_conversations', since),
  ])
  const sinceMs = Date.parse(since)
  const newUsers = users.filter((u) => u.createdAt >= sinceMs)
  const active = users.filter((u) => (u.lastActiveAt ?? 0) >= sinceMs).length
  const claimed = shops.filter((s) => s.clerk_user_id)
  const stocked = shops.filter((s) => (perShop.get(s.id) ?? 0) >= 3).length
  const daily = new Map<string, number>()
  for (const u of newUsers) {
    const d = new Date(u.createdAt).toISOString().slice(0, 10)
    daily.set(d, (daily.get(d) ?? 0) + 1)
  }
  const n = (v: number | null) => v ?? '—'
  return {
    tiles: [
      {
        label: 'Members',
        value: users.length,
        sub: `+${users.filter((u) => u.createdAt >= Date.parse(today)).length} today · +${newUsers.length} in range`,
      },
      { label: 'Active, in range', value: active, sub: `of ${users.length} members` },
      { label: 'Shops', value: shops.length, sub: `${claimed.length} claimed by their owner` },
      { label: 'Shops with 3+ listings', value: stocked, sub: 'stocked enough to sell' },
      { label: 'Live listings', value: listings.length, sub: `+${listings.filter((l) => l.created_at >= since).length} in range` },
      { label: 'Conversations', value: n(conversations), sub: `+${n(conversationsRange)} in range` },
    ],
    sections: [
      {
        title: 'Members',
        kind: 'kv',
        rows: [
          ['Total', users.length],
          ['New in range', newUsers.length],
          ['Active in range', active],
          ['Own a shop', claimed.length],
        ],
      },
      {
        title: 'Marketplace',
        kind: 'kv',
        rows: [
          ['Shops', shops.length],
          ['New shops in range', shops.filter((s) => s.created_at >= since).length],
          ['Live listings', listings.length],
          ['Favorites', n(favorites)],
          ['Subscriptions', n(subscriptions)],
        ],
      },
    ],
    daily: [...daily.entries()].sort().map(([d, v]) => ({ d, n: v })),
    daily_label: 'New members per day',
  }
}

async function log(url: URL) {
  const size = int(url.searchParams.get('size'), 25, 5, 200)
  const page = int(url.searchParams.get('page'), 1, 1, 100000)
  const q = (url.searchParams.get('q') ?? '').replace(/[%_\\,()]/g, '').trim()
  let query = db.from('admin_audit_log').select('action, actor_email, target, created_at', { count: 'exact' })
  if (q) query = query.ilike('action', `%${q}%`)
  const { data, count: total, error } = await query
    .order('created_at', { ascending: false })
    .range((page - 1) * size, page * size - 1)
  if (error) throw error
  return {
    total: total ?? 0,
    rows: (data ?? []).map((r) => ({ at: r.created_at, name: r.action, who: r.actor_email ?? '—', target: r.target ?? '—' })),
    columns: [
      { key: 'at', label: 'When', type: 'date' },
      { key: 'name', label: 'Admin action' },
      { key: 'who', label: 'Who' },
      { key: 'target', label: 'Target' },
    ],
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ what: string }> }) {
  if (!authorized(request)) return notFound()
  const { what } = await params
  const url = new URL(request.url)
  if (what === 'summary') return json(await summary(int(url.searchParams.get('days'), 30, 1, 400)))
  if (what === 'members') return json(await members(url))
  if (what === 'log') return json(await log(url))
  return notFound()
}
