# e2e — the Playwright harness

Three layers, three purposes. Grow each by **one spec per new testable story**.

## `api` project — the deterministic gate (always-on)
API-level specs (`*.spec.ts`, excluding `*.browser.spec.ts` and `*.staging.spec.ts`) hit public
endpoints via the `request` fixture, against `baseURL`. No browser binaries → fast and cheap.
**Runs in CI on every PR** (`ci.yml`) and must be green before merge.

```bash
npm run test:e2e                                  # the gate
PLAYWRIGHT_BASE_URL=https://<preview> npm run test:e2e
```

Previews are SSO-gated — CI passes `VERCEL_AUTOMATION_BYPASS_SECRET` so the suite reaches them.

## `browser` project — opt-in real-browser smoke (NOT the gate)
`*.browser.spec.ts`, Chromium. Asserts *rendered* UI an API call can't see — a field renders before
the CTA, a counter ticks, a required-field nudge fires. Kept out of the blocking gate (binaries are
heavy/slow); run on demand, and nightly via `.github/workflows/browser-smoke.yml`.

```bash
npx playwright install chromium      # once
npm run test:e2e:browser
```

### `scripts/live-smoke.mjs` — the default interactive entry point (any agent)
Wraps this project for on-demand verification during a build session (as opposed to the permanent
regression suite above). **The default tool for "does this actually render correctly" — for any
coding agent, not just Claude Code; no Claude-in-Chrome access needed.** Two modes: `--path` for an
ad-hoc check against one URL (nothing permanent left behind — for active-development "does this
look right" moments), `--spec` to run an existing committed `*.browser.spec.ts` by name. Emits a
JSON report + a screenshot to `test-results/live-smoke/` that the calling agent reads back, rather
than just an exit code.

```bash
node scripts/live-smoke.mjs --env=prod  --flow=unauthed --path=/mx/vende/migracion
node scripts/live-smoke.mjs --env=local --flow=admin    --path=/admin/promoter
```

Full usage, the honest environment × auth matrix, and the Claude-in-Chrome fallback boundary:
`skills/live-smoke/SKILL.md` (root repo).

## `staging` project — opt-in, deliberately different host (NOT the gate)
`*.staging.spec.ts`. Same `request`-fixture shape as `api`, but the spec targets a host OTHER than
`baseURL` on purpose — e.g. an infra-migration staging hostname
(`09-platform-infra/frontend-vercel-to-cloudrun`'s `gcp.miyagisanchez.com`). Excluded from `api` for
exactly that reason: included there, it runs against the PR's Vercel preview and fails on a host
mismatch that isn't a real bug — this happened live (two specs shipped as plain `*.spec.ts`, got
swept into the CI gate, failed against the wrong host). Always invoke with an explicit
`PLAYWRIGHT_BASE_URL` pointed at the real target:

```bash
PLAYWRIGHT_BASE_URL=https://gcp.miyagisanchez.com npx playwright test --project=staging
```

### Anonymous smokes (preview/prod) — `MS_TEST_PERSONALIZED_LISTING_ID`
A public listing with a **required** custom field lights up the personalization buy-box smoke. Unset →
skips. **Prefer anonymous assertions** — many client islands (e.g. the personalization buy box)
render + intercept *before* sign-in, so they need no auth and run against any deploy.

### Authed smokes — dev Clerk only (preview CI or local)
Auth uses `@clerk/testing` **ticket** sign-in (no password/OTP/2FA). Clerk rejects its testing token
for production secret keys, so the scheduled production job is deliberately anonymous. The preview
path in `ci.yml` is the only CI path with `MS_TEST_BROWSER_AUTH=1`; it maps the dedicated dev-instance
GitHub secrets `MS_TEST_CLERK_PUBLISHABLE_KEY` / `MS_TEST_CLERK_SECRET_KEY` to the standard Clerk env
names. If either key or a needed fixture is absent, the affected tests skip and the job stays green.

Every browser run writes `test-results/browser-smoke-fixture-skips.json`; both workflows publish its
authed-skip count and missing fixture **names only** in the GitHub Actions job summary, then upload the
JSON as `browser-smoke-fixture-skips`.

```bash
# 1) boot the app (uses .env.local → the dev Clerk instance)
npm run dev                       # http://localhost:3001

# 2) in another shell — point the browser project at it, with the DEV Clerk keys
#    (CLERK_PUBLISHABLE_KEY/CLERK_SECRET_KEY must be the SAME instance the app serves)
PLAYWRIGHT_BASE_URL=http://localhost:3001 \
MS_TEST_BROWSER_AUTH=1 \
CLERK_PUBLISHABLE_KEY=<dev pk_test> CLERK_SECRET_KEY=<dev sk_test> \
MS_TEST_BUYER_EMAIL=<dev user email> \
  npm run test:e2e:browser
```

| env | for |
|---|---|
| `MS_TEST_BROWSER_AUTH=1` | master switch for authed smokes (off by default → skip) |
| `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | **dev** Clerk instance keys (must match the app's) |
| `MS_TEST_BUYER_EMAIL` / `MS_TEST_SELLER_EMAIL` | a user that exists in that dev instance |

> **Instance-match gotcha:** the keys, the test users, and the app must all be the **same** Clerk
> instance, or `clerk.signIn` times out waiting for `window.Clerk`. Decode a publishable key with
> `echo <suffix> | base64 -d` to see its frontend-API host. The preview CI browser layer is
> non-blocking; its credentialed tests are informative rather than a merge gate.

### Fixture inventory (derived from `e2e/**/*.spec.ts`)

The table is the provisionable `MS_TEST_*` surface actually referenced by the spec tree. `ci.yml`
wires the API and browser fixtures; `browser-smoke.yml` wires the browser-only anonymous subset for
the production nightly. A missing fixture is a visible skip, not a failure.

| Env var | Specs unlocked | Fixture requirement |
| --- | --- | --- |
| `MS_TEST_BROWSER_AUTH` | all auth-gated browser specs | Literal `1`; set only in the preview CI job or a local dev-Clerk run. |
| `MS_TEST_BUYER_EMAIL` | `smoke`, `home-hero-auth`, `home-personalization`, `buyer-notification-prefs-compras`, `checkout-cp-first`, `unread-poll` browser specs | Existing buyer in the same dev Clerk instance as the target. |
| `MS_TEST_SELLER_EMAIL` | `onboarding-success-card`, shop-settings, `seller-unclaimed-s3` browser specs | Existing seller in that dev Clerk instance. **Must also OWN A SHOP** — see below. |
| `MS_TEST_ADMIN_EMAIL` | `admin-seleccion.browser.spec.ts` | Dev Clerk user recognized as an admin by the app. This spec requires its explicit email. |
| `MS_TEST_PDP_LISTING_ID` | `agent-prompt`, `trust-signals` browser; `ucp-cutover-api` | Public listing; seller exposes a payment or fulfillment method for trust-signals. |
| `MS_TEST_PERSONALIZED_LISTING_ID` | `personalization`, PDP gallery fallback; `agent-prompt`, `trust-signals`, `ucp-cutover-api` fallbacks | Public listing with a required custom field. |
| `MS_TEST_GALLERY_LISTING_ID` | `pdp-gallery.browser.spec.ts` | **Optional pin, VALIDATED.** Discovered from the live catalog when unset or when the pin no longer resolves with 2+ photos. |
| `MS_TEST_GALLERY_SINGLE_LISTING_ID` | `pdp-gallery.browser.spec.ts` | **Optional pin, VALIDATED.** Discovered when unset or stale — a public listing with exactly one photo. Safe to delete from Actions secrets. |
| ~~`MS_TEST_GALLERY_ZERO_LISTING_ID`~~ | *(no spec)* | **Unused as of 2026-08-17** — the zero-photo browser spec was retired (see below). Safe to delete from Actions secrets. |
| `MS_TEST_SHIPPABLE_LISTING_ID` | `checkout-cp-first.browser.spec.ts`, `ucp-checkout-session-shipping-boundary.spec.ts` | Public, priced physical listing with Envía shipping. |
| `MS_TEST_CLAIMED_SLUG` | `seller-unclaimed-s3.browser.spec.ts`, `collection-isolation.spec.ts` | **Optional pin, VALIDATED.** A claimed shop is discovered from the live catalog when unset or when the pin's claim page no longer shows the manage CTA (`_helpers/claimed-shop-fixture.ts`). The old pin `miyagiprints` was deleted and kept the nightly red 2026-10-15 → 11-03. Safe to delete from Actions secrets. |
| `MS_TEST_UNCLAIMED_LISTING_ID` | `unclaimed-pdp.browser.spec.ts`, `unclaimed-guardrails.spec.ts` | Public listing on a “Sin reclamar” shop. |
| `MS_TEST_GTM_ID` | `site-analytics-loader.browser.spec.ts` | Set to `1` only when the target build has `NEXT_PUBLIC_GTM_ID`; this is a repo variable, not a secret. |
| `MS_TEST_ARRANGED_LISTING_ID` | `ucp-checkout-session-arranged-delivery.spec.ts` | Public, priced listing using coordinated delivery. |
| `MS_TEST_EVENT_LISTING_ID` | `ucp-checkout-quantity.spec.ts`, `ucp-rental-quote.spec.ts` | Public, priced event listing (the rental spec uses it as a non-rental control). |
| `MS_TEST_RENTAL_LISTING_ID` | `ucp-rental-quote.spec.ts` | Public, priced rental listing. |
| `MS_TEST_PRINT_STUDIO_SUBMISSION_ID` | `print-studio-api.spec.ts` | Disposable approved print-studio submission; also requires `PRINT_STUDIO_TOKEN`. |
| `MS_TEST_PRINT_STUDIO_SOCIAL_ID` | `print-studio-api.spec.ts` | Disposable approved social submission; also requires `PRINT_STUDIO_TOKEN`. |
| `MS_TEST_PRINT_STUDIO_EDITION_ID` | `print-studio-api.spec.ts` | Existing `print_editions` UUID for the social-placement check. |
| `MS_TEST_PERSONALIZATION_STRICT` | `home-personalization.browser.spec.ts` | Optional `1`: strengthens an already-running assertion; it does not unlock a skipped test. |

`CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` are also required for credentialed tests, but are not
`MS_TEST_*` names. CI maps them from the dedicated dev-instance secrets above. `MS_TEST_BUYER_PASSWORD`
and `MS_TEST_SELLER_PASSWORD` are vestigial: no spec references either, because ticket sign-in needs
only an email plus the Clerk secret key. Do not provision them.

## Retired specs — and what would justify bringing them back

**`pdp · zero-image placeholder parity` (browser) — retired 2026-08-17.** It asserted that
`Gallery.tsx`'s `images.length === 0` branch renders the same back/share chrome as every other PDP. It
never ran against production: every public listing in the live catalog has at least one photo (66 on
2026-08-15, 67 on 2026-08-17), so it resolved FIXTURE UNAVAILABLE and skipped on every single nightly.

The cost is real and is stated here rather than buried: the placeholder branch now has **no automated
coverage at all**, the only one of Gallery's three render paths without a spec. That is a deliberate
trade. A spec that cannot run is not coverage either, and a nightly skip that never ends teaches people
to read skips as green — which is the failure mode this whole file exists to prevent.

**Bring it back when a public zero-photo listing exists** as a durable fixture. Discovery still supports
the `'zero'` photo count in `_helpers/gallery-fixture.ts`, so reviving it means re-adding the describe
block (see the retirement comment in `pdp-gallery.browser.spec.ts`), not rebuilding machinery.

## The seller fixture owns a shop — `qa-playwright-fixture` (created 2026-08-20)

Every `/shop/manage/*` spec needs its signed-in seller to own a row in
`marketplace_shops`. `playwright-seller@miyagisanchez.com` owned none, so those specs
did not fail on their subject — the settings page 404'd before rendering anything, and
sixteen "missing selector" failures read exactly like a broken seller portal. They were
one absent row.

There is no non-production Supabase, so the row lives in the live database. It is scoped
to be inert there, deliberately:

| property | value | why |
|---|---|---|
| `slug` | `qa-playwright-fixture` | greppable; obviously not a merchant |
| `name` | `[QA] Playwright Test Shop — automated tests only` | unmistakable anywhere it is listed |
| `clerk_user_id` | the **dev**-instance id of `playwright-seller` | that id cannot exist in the production Clerk instance, so **no real person can ever sign in as this shop** |
| `source` | `qa-fixture` | filterable |
| `metadata.is_test_fixture` | `true` | filterable |

**It is not publicly reachable.** The public shop page reads the MEDUSA seller, not this
table (see `LEARNINGS.md` → *shop settings live in two stores*), and this fixture has no
Medusa seller and no listings — so `/mx/s/qa-playwright-fixture` 404s and it cannot appear
in the catalog. Verified before and after creation.

**It is necessary but not sufficient.** With the row in place the settings page gets past
the shop lookup and then fails on `getMySeller()`, which calls Medusa — so the seven
category-B seller entries stay `unavailable` until a local Medusa runs on `:9000`. The
sweep reports that as its own state rather than as a failure.

### Recreating it

The sweep probes for this row by slug (`seller-shop-fixture` in
`scripts/smoke-sweep.manifest.json`), so if it goes missing the seller entries report
UNAVAILABLE with this file named — they do not silently fail. To restore it:

```sql
insert into marketplace_shops (slug, name, description, location, clerk_user_id, verified, source, metadata)
values (
  'qa-playwright-fixture',
  '[QA] Playwright Test Shop — automated tests only',
  'Automated-test fixture. Not a real merchant. See e2e/README.md.',
  'QA',
  'user_3EjPSw1XwZyyAVpoUoZoC1kTlra',  -- playwright-seller in the DEV Clerk instance (honest-eel-39)
  false,
  'qa-fixture',
  jsonb_build_object('is_test_fixture', true, 'safe_to_delete', true)
);
```

The `clerk_user_id` is the one field that matters and the one to re-derive rather than
copy blindly — it must be the **dev**-instance id of whatever `MS_TEST_SELLER_EMAIL`
points at, which is what makes the row unreachable from production auth:

```bash
curl -s -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  "https://api.clerk.com/v1/users?email_address=playwright-seller@miyagisanchez.com" \
  | jq -r '.[0].id'
```

Safe to delete; nothing references it:

```sql
delete from marketplace_shops where slug = 'qa-playwright-fixture';
```

## Conventions
- `_helpers/` is not a test dir (no `*.spec.ts`) — shared helpers only.
- A browser spec replaces a hand-driven browser smoke that was previously "owed to Daniel."
- Keep browser specs resilient: assert behaviour/landmarks, not volatile copy or layout.

## Fixture ids that actually satisfy the gated specs (verified live 2026-07-27)

Two `api`-project specs are fixture-gated and had been **silently skipping** in CI. When the fixtures
were first supplied they **failed** — not a code bug: the configured listings did not satisfy what the
specs assert. These do, verified against the live production endpoint:

| Secret | Verified value | What the spec needs, and why this one works |
|---|---|---|
| `MS_TEST_PDP_LISTING_ID` | `prod_01KXBHQMR7A2YFKBMXAA2NK7ZJ` | `ucp-cutover-api.spec.ts` needs a listing whose `payment_options` include at least one **instant method with a `checkout_url`**. This one returns Stripe + bank transfer with a URL. |
| `MS_TEST_UNCLAIMED_LISTING_ID` | `prod_01KW35VS38TVERK4BCM6667J1F` | `unclaimed-guardrails.spec.ts` needs an **unclaimed** shop: every claim-gated method unavailable, and `mercadopago.reason_unavailable` containing `vendedor registrado`. Both confirmed. |

**Do not assume a listing qualifies because it is public.** Most of the catalog pre-launch is unclaimed
"gem" listings with no registered seller, so every payment method is unavailable and any spec needing a
`checkout_url` fails. Re-verify with:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"listing_id":"<id>"}' https://miyagisanchez.com/api/ucp/checkout-session
```

These are **production** ids on Daniel's own disposable tenants (pre-launch, no real sellers). They are
data, not secrets — they live in repo secrets only to match the existing fixture convention.
