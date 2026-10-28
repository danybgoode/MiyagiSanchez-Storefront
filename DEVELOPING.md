# Developing

The Next.js 16 frontend for [Miyagi Sánchez](https://miyagisanchez.com) — a multi-seller
marketplace where anyone in Mexico can open a shop and sell with no commission, across the
marketplace, their own domain, an embeddable widget, or to AI shopping agents. This repo is the
**UI layer + UCP/MCP agent-commerce endpoints + non-commerce APIs**; all commerce data (products,
orders, payments, fulfillment) lives in the Medusa backend and is read through the Medusa Store
API — see [`AGENTS.md`](AGENTS.md) for the five rules that govern where things go in this repo.

This repo is part of the Miyagi Sánchez platform; the product roadmap and cross-repo practice live in the
root docs repo, [`MiyagiSanchez-Product`](https://github.com/danybgoode/MiyagiSanchez-Product).

## What this repo owns

- Every buyer- and seller-facing page (`app/`) — discovery, checkout hand-off, seller portal
  (`/shop/manage`), the agentic/UCP-MCP surface (`/api/ucp/*`).
- Non-commerce data: buyer–seller conversations, offers, favorites, supply-import staging — all in
  Supabase, never Medusa (see `AGENTS.md` rule #2).
- Clerk-backed auth, R2 file storage, Telegram admin notifications, Upstash rate limiting.

## Practice

Follows the same gitflow, risk-tiered PR review, and deterministic-gate discipline as the rest of
the platform — see [`Roadmap/WAYS-OF-WORKING.md`](https://github.com/danybgoode/MiyagiSanchez-Product/blob/main/Roadmap/WAYS-OF-WORKING.md)
in the root repo. This repo's own deterministic gate is `tsc` + `next build` + the Playwright
suite (`npm run test:e2e`) — see [`e2e/README.md`](e2e/README.md) for the harness.

## Deploy

Merging to `main` builds `ghcr.io/danybgoode/miyagisanchez-storefront:main` (arm64, GitHub Actions). It deploys nothing by
itself: production runs on the Oracle VM, and `/opt/miyagi/infra/oci/update.sh` (in MiyagiSanchez-Product)
pulls the new image, restarts, and posts the 🚀 Telegram pair of the merge's 📦.
Every PR still gets a Vercel preview for review before merge; Vercel does not serve production.

## Quickstart

```bash
npm install
npm run dev   # next dev --turbopack, :3001
```

You'll need a `.env.local` with `MEDUSA_STORE_URL`, `MEDUSA_PUBLISHABLE_KEY`, Clerk, Supabase, and
R2 keys — see the full list in `AGENTS.md`'s Quick-reference section.

The Medusa backend (`apps/backend` in the sibling repo) needs to be running on `:9000` for most
pages to show real data.

Other scripts: `npm run build` (production build), `npm run lint` (ESLint), `npm run test:e2e`
(Playwright, API-level, no browser), `npm run test:e2e:browser` (opt-in real-browser smoke).

## Where things live

- [`AGENTS.md`](AGENTS.md) — the five rules (Medusa owns commerce, Supabase is non-commerce only,
  UCP/MCP-first, Clerk-only auth, es-MX-by-default) plus the doc-routing table into `.claude/context/`.
- [`e2e/README.md`](e2e/README.md) — the Playwright harness (deterministic `api` gate + opt-in
  `browser` smoke).
