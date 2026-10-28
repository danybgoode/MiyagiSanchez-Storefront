# Architecture

## Stack

| Layer | Technology | Notes |
|---|---|---|
| Commerce engine | Medusa v2 (`apps/backend`) | All products, orders, payments, fulfillment |
| Frontend | Next.js 16.2.6, App Router | Consumes Medusa Store API + Supabase for non-commerce |
| Runtime | React 19.2.4 | `use client` only where interactivity is needed |
| Styling | Tailwind CSS v4 | No config file — uses CSS variables via `--color-*` |
| Non-commerce DB | Supabase (Postgres) | Conversations, offers, supply, UCP identity |
| Auth | Clerk v7 | `@clerk/nextjs` — bridged to Medusa via custom auth provider |
| Frontend hosting | Vercel | Auto-deploys from `main`; frontend on port 3001 in dev |
| Backend hosting | Render (free plan) | `https://miyagi-medusa-api.onrender.com` — deploys from `github.com/danybgoode/MiyagiSanchez-Backend` |
| Commerce DB | Neon Postgres | Medusa migrations applied; MXN region + sales channel seeded |
| Rate limiting | Upstash Redis | `UPSTASH_REDIS_REST_URL` + token |

**Read [medusa.md](medusa.md) before touching any commerce-related code.**

---

## File structure

```
miyagisanchez/
├── app/
│   ├── layout.tsx                    ← root layout, ClerkProvider, fonts
│   ├── page.tsx                      ← homepage
│   ├── l/                            ← listing browse (/l) + detail (/l/[id])
│   ├── s/[slug]/                     ← seller storefront + claim flow
│   ├── sell/                         ← /sell onboarding + /sell/edit/[id]
│   ├── shop/manage/                  ← seller portal (protected by middleware)
│   │   ├── page.tsx                  ← dashboard hub
│   │   ├── settings/                 ← ShopSettings panel
│   │   ├── analytics/                ← MRR/ARR charts (subscriptions)
│   │   ├── subscriptions/            ← manage subscriber list
│   │   ├── content/                  ← gated content library
│   │   └── offers/                   ← incoming offers inbox
│   ├── account/subscriptions/        ← buyer: active subscriptions + content
│   ├── payment/success/              ← post-checkout landing page
│   └── api/
│       ├── ucp/                      ← UCP + MCP endpoints (see ucp.md)
│       ├── conversations/            ← buyer-seller messaging (Supabase)
│       ├── offers/                   ← offer/negotiation state (Supabase)
│       ├── favorites/                ← saved items (Supabase)
│       ├── webhooks/envia/           ← Envia.com shipping webhooks
│       ├── sell/shop/domain/         ← custom domain provisioning
│       ├── supply/                   ← bulk import pipeline
│       ├── admin/                    ← scraper admin
│       └── cron/                     ← cleanup jobs
├── lib/
│   ├── medusa.ts                     ← Medusa Store API client (use for ALL commerce)
│   ├── supabase.ts                   ← Supabase client (conversations/offers/supply only)
│   ├── ucp/                          ← UCP schema, identity, webhook helpers
│   ├── channel.ts                    ← detectChannel() for federated commerce
│   ├── vercel-domains.ts             ← custom domain provisioning
│   ├── types.ts                      ← shared types (non-commerce only)
│   ├── telegram.ts                   ← admin notifications
│   ├── ratelimit.ts                  ← Upstash Redis rate limiting
│   ├── r2.ts                         ← Cloudflare R2 upload/presign
│   ├── email.ts                      ← Resend
│   ├── offers.ts                     ← offer logic helpers
│   ├── calcom.ts                     ← Cal.com booking integration
│   └── encryption.ts                 ← AES-256-GCM for stored tokens
├── supabase/migrations/              ← non-commerce DB only (conversations, offers, supply)
├── locales/en.json + es.json         ← ALL user-visible strings
├── AGENTS.md                         ← always read first
└── .claude/context/                  ← specialist docs (read on demand)
```

---

## Routing rules (Next.js 16+)

```ts
// ❌ Wrong — params is a Promise in Next.js 16+
export default function Page({ params }: { params: { id: string } }) {
  const { id } = params
}

// ✅ Correct
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
}
// searchParams same pattern
```

---

## CSS design tokens

Use CSS variables, never Tailwind's default palette:

```css
var(--color-text)           /* primary text */
var(--color-muted)          /* secondary/muted text */
var(--color-accent)         /* brand green #1d6f42 */
var(--color-accent-hover)   /* darker accent */
var(--color-border)         /* borders */
var(--color-background)     /* page background */
var(--color-surface-alt)    /* card / panel background */
```

Never `text-gray-600` — always `text-[var(--color-muted)]`.

---

## Protected routes

`middleware.ts` protects `/shop/manage(.*)` — Clerk redirects to `/sign-in` automatically. For API routes that need auth, call `currentUser()` or `auth()` and handle 401 manually.

---

<a name="admin"></a>
## Admin & Scrapers

- `/admin` — scraper dashboard (Clerk-gated at admin email level in the page component)
- `lib/scrapers/` — `mercadolibre.ts` + `serpapi.ts` scrape listings from ML and Google Shopping
- `/api/admin/scrape` — triggers scrape runs
- `SCRAPER_AGENTS.md` — full scraper architecture doc (read if touching scrapers)
- `SUPPLY_IMPORT_SCHEMA.md` — CSV bulk-import schema doc

Supply import pipeline stages scraped data in Supabase (`supply_batches`, `supply_items`) before admin reviews and publishes as Medusa products.

**Medusa admin**: Full order/product management is available at `MEDUSA_STORE_URL/app`. Do not build custom admin UIs for concerns Medusa already covers.
