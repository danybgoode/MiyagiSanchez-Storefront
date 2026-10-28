# Medusa Backend

## Overview

`apps/backend` is the Medusa v2 commerce engine. It owns all commerce concerns: products, vendors, cart, orders, payments, fulfillment, returns, subscriptions. The Next.js frontend is a pure consumer of its Store API.

**Medusa v2 version**: 2.15.3  
**Store API base**: `MEDUSA_STORE_URL/store` (default `http://localhost:9000/store`)  
**Admin API base**: `MEDUSA_STORE_URL/admin` (internal use only)  
**Dev command**: `cd apps/backend && npx medusa dev`

---

## Deployment (production)

| Service | URL | Notes |
|---|---|---|
| Medusa API | `https://api.miyagisanchez.com` | GCP Cloud Run, us-east4; ~18min Cloud Build on `main` push |
| Admin UI | `https://api.miyagisanchez.com/app` | Enabled; `DISABLE_MEDUSA_ADMIN` env gates it |
| Database | `DATABASE_URL` env var | Neon Postgres; all migrations applied |
| Frontend | `https://miyagisanchez.com` | Vercel, auto-deploy from `main` only |
| Backend repo | `https://github.com/danybgoode/MiyagiSanchez-Backend` | Push `main` → Cloud Build trigger |

**Seeded production data**:
- Publishable key: `pk_bac9...` (set in `MEDUSA_PUBLISHABLE_KEY` on Vercel)
- MXN is default store currency; Mexico region + stock location "México" exist
- FulfillmentSet "Miyagi México" + 3 ShippingOptions seeded (post Section 3)

**CI/CD**: Cloud Build `cloudbuild.yaml` — builds Docker image → pushes to Artifact Registry → deploys Cloud Run revision. Check build status: `gh api repos/danybgoode/MiyagiSanchez-Backend/commits/main/check-runs`.

**Webhooks**:
- Frontend (`/api/webhooks/stripe`): handles `invoice.*`, `customer.subscription.*`, `payment_intent.*`
- Medusa backend (`/hooks/payment/pp_stripe-connect_stripe-connect`): handles `payment_intent.succeeded`, `charge.refunded`, `checkout.session.completed`

---

## Backend file structure

```
apps/backend/src/
├── modules/
│   ├── seller/            ← Custom multi-vendor seller module (NOT @medusajs/marketplace)
│   ├── auth-clerk/        ← Custom Clerk JWT auth provider
│   ├── subscriptions/     ← Custom subscription module (not native in Medusa v2)
│   ├── payment-stripe-connect/ ← Stripe Connect Express payment provider
│   └── payment-mercadopago/    ← MercadoPago Checkout Pro provider
├── api/
│   ├── store/             ← Custom store API extensions
│   │   ├── _utils/
│   │   │   ├── clerk-auth.ts   ← extractClerkUserId(), resolveSeller() — use these, never inline JWT decode
│   │   │   └── listing.ts      ← toListingShape(), toSellerShape() — canonical listing normalisation
│   │   ├── listings/      ← GET /store/listings, /store/listings/:id
│   │   ├── sellers/       ← GET /store/sellers/:slug, /store/sellers/:slug/products
│   │   ├── customers/     ← customer sync, order history
│   │   └── ...
│   └── admin/             ← Custom admin API extensions
├── workflows/             ← Medusa workflows (saga-style multi-step operations)
├── links/                 ← Module links (foreign keys between Medusa modules)
├── subscribers/           ← Event subscribers (webhooks, notifications)
└── jobs/                  ← Scheduled background jobs
medusa-config.ts           ← DB, CORS, plugins, modules config
```

---

## Installed plugins and modules

| Plugin / Module | Purpose |
|---|---|
| Custom `seller` module | Multi-vendor: sellers own products, have slugs, metadata |
| `@medusajs/payment-stripe` | Base Stripe; extended by custom Stripe Connect provider |
| Custom `payment-stripe-connect` | Stripe Connect Express for seller payouts |
| Custom `payment-mercadopago` | MP Checkout Pro + OAuth marketplace splits |
| `@medusajs/fulfillment-manual` | Manual fulfillment provider (backing native Medusa fulfillment objects) |
| Custom `auth-clerk` module | Validates Clerk JWTs for customer identification |
| Custom `subscriptions` module | Recurring billing, tiers, content gating |

**Note**: This project uses a **custom seller module** at `src/modules/seller/`, NOT `@medusajs/marketplace`. The seller model is `model.define()` + `MedusaService()` with a Medusa link to Products.

---

## Medusa data model → marketplace concepts

| Marketplace concept | Medusa entity |
|---|---|
| Seller shop | Custom Seller model (seller module) |
| Listing (product/digital/service/rental) | Product + ProductType + metadata |
| Subscription listing | Product with subscription metadata + custom Subscriptions module |
| Price | ProductVariant + Price (with region MXN) |
| Purchase | Cart → Order flow |
| Order management | Order + Fulfillment |
| Shipping | Fulfillment via Envia.com provider |
| Return / refund request | Return (Medusa Returns module) |
| Payment | PaymentCollection → PaymentSession → Payment |

---

## Custom listing shape

All `/store/listings` endpoints return the `ListingShape` type (from `src/api/store/_utils/listing.ts`), NOT raw Medusa Product objects. This shape is also the `Listing` type in `lib/types.ts` on the frontend:

```ts
{
  id, shop_id, medusa_product_id, title, description,
  price_cents, currency, condition, listing_type, category,
  state, municipio, location, metadata, images, tags,
  status, views, created_at,
  shop: { id, slug, name, description, location, logo_url, clerk_user_id, verified, metadata, ... }
}
```

Key endpoints:
- `GET /store/listings` — full catalog with filters: `q`, `category`, `condition`, `state`, `location`, `min_price`, `max_price`, `sort`, `seller_slug`, `listing_type`, and autos/inmuebles-specific filters
- `GET /store/listings/:id` — single listing
- `GET /store/sellers/:slug` — seller profile
- `GET /store/sellers/:slug/products` — raw Medusa products for a seller

---

## Auth: Clerk + Medusa bridge

**How it works**:
1. User authenticates with Clerk on the frontend (normal Clerk flow)
2. Frontend gets Clerk JWT from `await currentUser()` / `useAuth()`
3. For Medusa Store API calls requiring auth (orders, account), frontend passes Clerk JWT as `Authorization: Bearer <clerk_jwt>`
4. Custom auth provider at `apps/backend/src/modules/auth-clerk/` validates the JWT against Clerk's JWKS endpoint
5. On first validated call, Medusa creates/syncs a Customer record keyed to the Clerk user ID
6. Medusa returns its own short-lived JWT for subsequent Store API calls

**Shared auth utils** (always use these, never inline JWT decode):
```ts
// src/api/store/_utils/clerk-auth.ts
extractClerkUserId(req)           // → string | null  (from Authorization: Bearer header)
resolveSeller(req)                // → { sellerId, sellerName } | null
```

---

## Store API usage patterns

```ts
import { medusa } from '@/lib/medusa'

// Listings (use /store/listings, NOT /store/products — it returns the enriched shape)
const res = await fetch(`${MEDUSA_STORE_URL}/store/listings?limit=20`, {
  headers: { 'x-publishable-api-key': MEDUSA_PUBLISHABLE_KEY }
})

// Cart + checkout
const { cart } = await medusa.store.cart.create({ region_id: MXN_REGION_ID })
await medusa.store.cart.addLineItem(cartId, { variant_id: variantId, quantity: 1 })
await medusa.store.cart.complete(cartId)  // → creates Order

// Orders (authenticated)
const { orders } = await medusa.store.order.list({}, { Authorization: `Bearer ${token}` })
```

---

## Adding a new Medusa module

```ts
// apps/backend/src/modules/my-module/index.ts
import { Module } from '@medusajs/framework/utils'
import MyModuleService from './service'
export const MY_MODULE = 'myModule'
export default Module(MY_MODULE, { service: MyModuleService })

// Register in medusa-config.ts
modules: [{ resolve: './src/modules/my-module' }]
```

---

## Adding a new payment provider

```ts
// apps/backend/src/modules/my-payment/index.ts
import { ModuleProvider, Modules } from '@medusajs/framework/utils'
export default ModuleProvider(Modules.PAYMENT, {
  services: [MyPaymentProviderService],  // extends AbstractPaymentProvider
})
```

---

## Webhooks

Two separate Stripe webhook endpoints:
- **Frontend** `POST /api/webhooks/stripe` — subscription lifecycle, invoice events
- **Medusa backend** `POST /hooks/payment/pp_stripe-connect_stripe-connect` — payment intents, refunds, checkout sessions

MercadoPago webhooks: `POST /api/webhooks/mercadopago` (frontend) and Medusa's built-in MP provider handler.

---

## Medusa Admin Dashboard

**Current status: ENABLED at `https://api.miyagisanchez.com/app`** (Cloud Run has sufficient memory).

Gate: `medusa-config.ts` has `admin: { disable: process.env.DISABLE_MEDUSA_ADMIN === 'true' }`. Set `DISABLE_MEDUSA_ADMIN=true` in Cloud Run env to turn it off.

Admin user: `daniel@despachobonsai.com` (created in prod Neon DB). If you need to create a new admin user, use a Cloud Run Job (no shell on Cloud Run) — clone the medusa-web image + secrets + VPC connector `medusa-conn` and run `medusa user -e email@x.com -p password`.
