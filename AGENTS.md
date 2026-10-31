# Agent index — miyagisanchez.com

## What is this?

**miyagisanchez.com** — a multi-seller P2P marketplace for Mexico. The mission: make ecommerce best practices (trust, escrow, offer negotiation, AI-native shopping) available to everyone for free, at the highest quality level.

**Architecture**: Medusa v2 headless commerce backend + Next.js 16 App Router frontend. Fully UCP and MCP compatible — AI agents can browse, negotiate, and buy natively without a browser.

**Monorepo**:
```
medusa-bonsai/
├── apps/backend/          ← Medusa v2 (the commerce engine — products, orders, payments, fulfillment)
└── apps/miyagisanchez/    ← Next.js 16 (UI layer + UCP/MCP endpoints + non-commerce APIs)
```

**Workflow (gitflow)**: work on a **feature branch** (`feat/<epic-slug>`), commit per story, open a **PR** with `gh`, and **merge to `main`** when verified + approved. **Production runs on the Oracle VM `panfleto-prod`** behind Cloudflare (epic `miyagi-to-oracle-vm`, cut over 2026-10-16; the GCP Cloud Run/Cloud Build rail is **deleted**). Merging to `main` builds the arm64 image (`.github/workflows/image-arm64.yml` → `ghcr.io/danybgoode/miyagisanchez-storefront:main`) but **deploys nothing by itself**: the deploy is `ssh -i ~/.ssh/panfleto_oci ubuntu@159.54.158.4 /opt/miyagi/infra/oci/update.sh` once the image build is green (root repo `infra/oci/`; it resolves `:main` to a digest, and a `*_PIN` line in `.env` rolls back). The backend works the same way. `cloudbuild.yaml` stays only as the build-args source of truth that `e2e/image-arm64-build-args.spec.ts` checks. Vercel is only the per-PR preview and CI target. Each frontend branch/PR still gets a **Vercel preview**, but CI runs the Playwright suites against it **only when the PR is labelled `e2e-preview`**: Vercel is the free Hobby plan, its Active CPU is shared by every project on the account, and CI on every push paused them all on 2026-10-30 (`.github/workflows/ci.yml` header). Never commit feature work straight to `main`. Roll back a bad merge with `git revert` on `main`.

## Start here (orientation for any agent)

Before planning or building, read these — they are the source of truth and change often:
- **`Roadmap/README.md`** (repo container root, one level above this app) — the product poster: every feature by domain, current status. Tracked in git (product source of truth) — present in every checkout and worktree.
- **`Roadmap/WAYS-OF-WORKING.md`** — how we plan/build/ship: the cadence, gitflow, Definition of Done (story **and** epic), QA/smoke-test rules, the Playwright harness (`npm run test:e2e`). Follow it.
- **`Roadmap/LEARNINGS.md`** — the distilled, cross-cutting wisdom from past epics' retrospectives (multi-agent + async-deploy coordination, tooling gotchas, what's worked). **Read it** — it's how a past retro reaches you instead of dying in its epic folder. You feed it at epic close (see the epic Definition of Done).
- **Team memory** (`~/.claude/projects/.../memory/`, auto-loaded via `MEMORY.md`) — durable facts: deploy topology (the Oracle VM rail), per-epic notes, gotchas.
- Process: **plan first** (plan mode → user stories → Daniel approves) → branch + **scaffold the epic/sprint docs before code** → build one story → verify → **smoke-test** → PR → merge. At **epic close**, update `Roadmap/README.md` (the poster), write a `RETROSPECTIVE.md`, and **promote its durable learnings to `Roadmap/LEARNINGS.md`**.

---

## ⚠️ Five rules that cannot be violated

### 1. Medusa owns all commerce. Never build it from scratch.

If a feature touches products, orders, payments, fulfillment, or returns → **it goes in `apps/backend` as a Medusa module/plugin, and the frontend calls the Medusa Store API**. Do not create Supabase tables or custom Next.js API routes for these concerns.

| Concern | Where it lives |
|---|---|
| Products / listings / variants | Medusa Products API |
| Shops / sellers / vendors | Custom `seller` module (`apps/backend/src/modules/seller/`) + module links (NOT `@medusajs/marketplace` — no such plugin is installed) |
| Cart + checkout | Medusa Cart → Order flow |
| Orders, order lifecycle | Medusa Orders API |
| Payments (Stripe Connect, MercadoPago, SPEI) | Medusa payment providers in `apps/backend` |
| Shipping / fulfillment | Medusa Fulfillment module + Envia.com provider |
| Returns / refunds | Medusa Returns module |
| Subscriptions | Custom Medusa module at `apps/backend/src/modules/subscriptions/` |
| Inventory | Medusa Inventory module |
| Regions / currencies (MXN, USD) | Medusa Regions |

**Frontend reads commerce data via**: `import { medusa } from '@/lib/medusa'` → calls `MEDUSA_STORE_URL/store/*`. Never `db.from()` for anything in the table above.

### 2. Supabase is ONLY for non-commerce marketplace data.

Supabase holds things Medusa has no concept of:

| Concern | Supabase table |
|---|---|
| Buyer–seller conversations | `marketplace_conversations` + `marketplace_conversation_events` |
| Offer / negotiation state | `marketplace_offers` |
| Favorites / saved items | `marketplace_favorites` |
| Supply import staging | `supply_batches` + `supply_items` |
| Scraper runs + items | `marketplace_scrape_runs` + `marketplace_scrape_run_items` |
| UCP buyer identity / trust scores | `ucp_buyer_identities` |

**Rule of thumb**: "Does Medusa have a module for this?" → Yes: Medusa. No: Supabase.

### 3. UCP and MCP are first-class citizens. Every commerce feature must be agent-accessible.

This marketplace is a **UCP-native implementation** (https://ucp.dev). UCP is the open standard (backed by Google, Shopify, Stripe, Amazon, Visa, Mastercard) for agentic commerce — REST + OAuth 2.0 + MCP + A2A.

When building any commerce feature:
- Products must be discoverable via `GET /api/ucp/catalog` (backed by Medusa)
- Checkout options must be available via `POST /api/ucp/checkout-session`
- All actions must be reachable via the MCP server at `POST /api/ucp/mcp` (JSON-RPC 2.0)
- The capability manifest at `GET /api/ucp/manifest` must stay accurate
- When Medusa replaces a Supabase data source, update the UCP routes to read from Medusa

See [ucp.md](.claude/context/ucp.md) for full UCP/MCP architecture.

### 4. Clerk is the auth layer. Never replace it.

Clerk handles all frontend auth. A custom Medusa auth provider at `apps/backend/src/modules/auth-clerk/` validates Clerk JWTs so Medusa can identify customers. Do not remove Clerk, do not build custom auth pages.

### 5. es-MX is the default. A defined allow-list of surfaces is bilingual (es/en).

User-facing copy is **es-MX by default** — the seller portal and most pages are Spanish-only. A **defined allow-list of surfaces is genuinely bilingual (es/en)** via the `locales/{es,en}.json` dictionary (~119 keys) + `getDictionary()`: the dictionary-backed public pages (e.g. `app/terminos`), the **sweepstakes** public flow (`app/g/[slug]`, with per-campaign `*_en/*_es` fields + `?lang=en`), and the **embed widget** locale toggle. The gate has two parts: (a) **es-MX copy-completeness** everywhere — no orphan strings, no stray hardcoded English; and (b) on the bilingual allow-list, **both locales present**. Don't make a new surface bilingual by default — extend the allow-list deliberately. Brand names stay as-is (Stripe, MercadoPago, WhatsApp, Cal.com). See [conventions.md](.claude/context/conventions.md#bilingual).

---

## Next.js 16 breaking changes (always apply)

`params` and `searchParams` are Promises — always `await` them. `cookies()` and `headers()` are async.

```ts
// ✅ Correct
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
}
```

---

## Context routing — read only what you need

| I'm working on… | Read these docs |
|---|---|
| Medusa backend, plugins, modules, workflows | [medusa.md](.claude/context/medusa.md) |
| Payment flows (checkout, webhook, refund) | [payments.md](.claude/context/payments.md) |
| Subscription feature (tiers, content, buyer portal) | [payments.md](.claude/context/payments.md#subscriptions) |
| Seller portal (`/sell`, `/shop/manage/*`) | [seller.md](.claude/context/seller.md) |
| Non-commerce DB (conversations, offers, supply) | [database.md](.claude/context/database.md) |
| UCP / MCP / AI agent commerce APIs | [ucp.md](.claude/context/ucp.md) |
| API route, auth, error handling, rate limiting | [conventions.md](.claude/context/conventions.md) |
| UI component, i18n, Tailwind patterns | [conventions.md](.claude/context/conventions.md) |
| File upload (images, digital goods) | [conventions.md](.claude/context/conventions.md#storage) |
| New page / routing / layout | [architecture.md](.claude/context/architecture.md) |
| Admin features, scrapers, supply import | [architecture.md](.claude/context/architecture.md#admin) |

---

## Quick-reference

```bash
# Dev — run both services
cd apps/backend && npx medusa dev           # Medusa backend on :9000
cd apps/miyagisanchez && npm run dev        # Next.js frontend on :3001 (Turbopack)

# Type-check (frontend)
npx tsc --noEmit

# Medusa DB migrate
cd apps/backend && npx medusa db:migrate

# Build frontend
npm run build
```

**Key env vars**:

Frontend (`apps/miyagisanchez/.env.local`):
- `MEDUSA_STORE_URL` — Medusa backend URL (`http://localhost:9000` in dev)
- `MEDUSA_PUBLISHABLE_KEY` — Medusa publishable API key (required for all Store API calls)
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY`
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — conversations/offers/supply only
- `R2_*` — Cloudflare R2 (images bucket); `R2_DIGITAL_*` (private digital files bucket)
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — admin notifications
- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — rate limiting
- `VERCEL_API_TOKEN` + `VERCEL_PROJECT_ID` — custom domain provisioning

Backend (`apps/backend/.env`):
- `DATABASE_URL` — Medusa Postgres DB
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
- `MP_ACCESS_TOKEN` — MercadoPago
- `CLERK_SECRET_KEY` — Clerk auth provider validates JWTs against this
- `STORE_CORS` / `ADMIN_CORS` / `AUTH_CORS`

**Key frontend imports**:
```ts
import { medusa } from '@/lib/medusa'          // Medusa Store API — ALL commerce data
import { db } from '@/lib/supabase'            // Supabase — ONLY conversations, offers, supply
import { currentUser, auth } from '@clerk/nextjs/server'
import { tg } from '@/lib/telegram'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { uploadToR2, isR2Configured } from '@/lib/r2'
import { detectChannel } from '@/lib/channel'
```

---

## Federated Commerce — Channels

Every seller's products live in Medusa and surface through multiple independent storefronts.

| Channel | URL pattern | Purpose |
|---|---|---|
| Marketplace | `miyagisanchez.com/s/[slug]` | Discovery, cross-seller traffic, SEO |
| Own domain | `theirshop.mx` (any domain) | Brand identity, direct traffic, white-label |
| Embed widget | `<script>` tag on any site | Existing audiences on other platforms |
| API / UCP | `/api/ucp/*` | Headless, programmatic, AI agents |

Custom domain routing: Middleware detects non-platform hostnames → looks up vendor in Medusa by `custom_domain` metadata → rewrites to `/s/[slug]` with `x-miyagi-channel: custom` header.

Key files:
```
lib/vercel-domains.ts          — addDomainToProject / getDomainStatus / removeDomainFromProject
lib/channel.ts                 — detectChannel(req) → 'marketplace' | 'custom_domain' | 'embed' | 'api'
app/s/[slug]/ChannelLayout.tsx — white-label shell (branded nav, no platform chrome)
app/api/sell/shop/domain/      — POST/GET/DELETE domain API route
```
