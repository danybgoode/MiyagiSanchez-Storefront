# Miyagi Sánchez — Scraper Project Handoff

## What this is

A catalog-population pipeline for **miyagisanchez.com** — a Mexican marketplace (Next.js 16 App Router, Supabase, Tailwind v4, Clerk v7). The goal is to seed `marketplace_listings` and `marketplace_shops` with real data from external sources so the site has content before organic sellers sign up.

---

## Repo location

```
/Users/cosmo/dobby/miyagisanchez-product/apps/storefront/
```

Key files:
| File | Purpose |
|------|---------|
| `lib/scrapers/serpapi.ts` | Google Local scraper (services, talleres, etc.) |
| `lib/scrapers/mercadolibre.ts` | ML seller + keyword scrapers |
| `app/api/admin/scrape/route.ts` | Admin API to trigger scrapes |
| `app/api/admin/import/route.ts` | Processes `marketplace_import_queue` |
| `app/api/admin/runs/route.ts` | Lists recent scrape run history |
| `app/admin/page.tsx` | Admin UI at `/admin` |
| `app/admin/AdminScrapeClient.tsx` | Client component for the admin panel |

---

## Architecture

### Flow A — Direct scrape (SerpAPI)
```
Admin UI /admin  →  POST /api/admin/scrape
  → scrapeSerpApiLocal() or scrapeMLSeller()
  → Creates marketplace_scrape_runs row (status: running)
  → For each result: upsert marketplace_shops + insert marketplace_listings
  → Updates run row (status: completed | failed)
```

### Flow B — Import queue
```
External source  →  INSERT marketplace_import_queue (status: pending)
  →  POST /api/admin/import
  →  Processes up to 100 rows: upsert shop + insert listing
  →  Updates row (status: processed | duplicate | failed)
```

### Authentication
Both endpoints check `x-admin-secret` header or `?secret=` query param against `ADMIN_SECRET` env var.

---

## Three scrapers

### 1. `scrapeSerpApiLocal` (working ✅)
- Searches `engine=google_local` via SerpAPI
- Use case: find service businesses (talleres, restaurantes, clínicas) by query + location
- Inserts a shop + listing per result
- Quality gate: score ≥ 2 out of 4 (name, address, contact, photo)
- Deduplication: `marketplace_shops.source_url` unique check

**Example call:**
```json
POST /api/admin/scrape
x-admin-secret: <ADMIN_SECRET>
{
  "source": "serpapi_google_local",
  "params": {
    "query": "taller mecánico",
    "location": "Ciudad de México, Mexico",
    "state": "Ciudad de México",
    "category": "servicios",
    "limit": 20
  }
}
```

### 2. `scrapeMLSeller` (working ✅)
- Scrapes a specific MercadoLibre seller's active listings
- Strategy: SerpAPI Google search for `site:auto.mercadolibre.com.mx OR site:articulo.mercadolibre.com.mx {nickname}` (bypasses ML PolicyAgent entirely)
- Paginates up to 5 Google pages (~50 items)
- For each result: fetches ML item page → extracts `og:title`, `og:image`, price from title
- Accepts seller URL formats: `/pagina/NICKNAME`, `/perfil/NICKNAME`, any ML listing URL with `MLM-XXXXXX`
- Known quirk: `start=0` returns only 1 result from SerpAPI; must omit `start` on page 0 (already handled)

**Example call:**
```json
POST /api/admin/scrape
x-admin-secret: <ADMIN_SECRET>
{
  "source": "mercadolibre_seller",
  "params": {
    "sellerUrl": "https://www.mercadolibre.com.mx/pagina/SELLER_NICKNAME",
    "category": "autos",
    "limit": 50
  }
}
```

### 3. `scrapeMercadoLibre` (BLOCKED ⛔)
- Attempts `GET /sites/MLM/search` on the ML API
- **Hard blocked by ML PolicyAgent for all MLM (Mexico) developer accounts** — returns 403 regardless of OAuth scopes or app_id
- Resolution: either use `scrapeMLSeller` (works now) or apply for ML catalog partner certification at developers.mercadolibre.com (takes weeks, formal process)
- The function is still in the codebase with a descriptive error message

---

## Database tables used

| Table | Purpose |
|-------|---------|
| `marketplace_shops` | Seller profiles. `source='scraped'`, `verified=false`. `source_url` is the dedup key. |
| `marketplace_listings` | Listings. `source_url` dedup key. `status='active'` for all scraped. |
| `marketplace_scrape_runs` | Audit log per scrape call: source, params, counts, error |
| `marketplace_import_queue` | Queue for external importers: `status` ∈ pending/processed/duplicate/failed |

---

## Environment variables required

```env
SERPAPI_KEY=...         # SerpAPI key — used by both scrapers
ADMIN_SECRET=...        # Shared secret to protect admin endpoints
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
# Only for scrapeMercadoLibre (currently blocked):
ML_APP_ID=...
ML_APP_SECRET=...
```

---

## Current state / known issues

1. **Scrape runs are synchronous** — the API waits for the full scrape to complete before responding. For large ML seller scrapes (50 items × OG fetch), this can hit Vercel's 60s function timeout on slow networks. **Next step: move to background job or queue.**

2. **No dedup on title** — if a listing's `source_url` changes (ML rotates listing URLs occasionally), it will insert a duplicate with a new URL. A content-hash or `ml_item_id` dedup would help.

3. **Price extraction from OG title is fragile** — works for the common ML format `"Title — $ 599,900"` but misses items that put price in meta tags differently. The `price_cents` field is often `null` for non-standard titles.

4. **Google search quota** — each ML seller scrape uses ~5 SerpAPI credits (1 per page). At $50/5000 credits, this is cheap but monitor usage.

5. **`start=0` SerpAPI bug** — documented and fixed in code. Omit `start` on page 0, set `start: 10, 20, 30...` for subsequent pages.

6. **Import queue (`/api/admin/import`) is unused** — it was built for an external bulk importer but nothing writes to `marketplace_import_queue` today. Can be wired up to a CSV upload or a browser extension.

---

## What to build next

### Priority 1 — Background jobs
Move long-running scrapes out of the HTTP request cycle:
- Option A: Vercel's background functions (fire-and-forget via `waitUntil`)
- Option B: Supabase Edge Functions + pg_cron
- Option C: Simple: write a "job" row, poll status from the admin UI (already half-done via `marketplace_scrape_runs`)

### Priority 2 — Bulk ML seller import
Build a UI flow to accept a list of ML seller URLs (one per line) and scrape them serially. The backend already handles one at a time; wrap it in a loop.

### Priority 3 — Category auto-tagging
After scraping, run a simple string-match or LLM call to assign categories to listings that come in without one (ML seller scrape often lacks category).

### Priority 4 — Price enrichment
For listings where `price_cents IS NULL` (about 30% of ML seller scrapes), try fetching the ML item page a second time with a different User-Agent pattern to improve OG extraction.

### Priority 5 — Google Local pagination
`scrapeSerpApiLocal` currently only fetches page 1 of Google Local results (~20 listings per query). Add `start` pagination to pull more.

---

## Admin UI

- Lives at `/admin` (protected by Clerk + `ADMIN_SECRET` env check)
- Shows three panels: SerpAPI local, ML seller, ML keyword (with PolicyAgent warning)
- Lists recent runs from `marketplace_scrape_runs`
- No pagination on run history — add if runs accumulate

---

## Tips for the next Claude session

- Read `lib/scrapers/serpapi.ts` and `lib/scrapers/mercadolibre.ts` in full before making changes
- The `slugify()` function in both files normalizes Spanish characters correctly (NFD decomposition) — don't touch it
- `scrapeMLSeller` uses `Promise.all` with `CONCURRENCY = 5` for OG fetches — don't increase past 8 or ML will 429
- SerpAPI `engine=google_local` and `engine=google` are different — local gives structured business data, google gives organic web results
- Test scrapes with `limit: 5` first to avoid burning credits on broken queries
