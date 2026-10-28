# MiyagiSanchez-Storefront (Next.js 16) — the standalone production image, built as
# ghcr.io/danybgoode/miyagisanchez-storefront by .github/workflows/image-arm64.yml and run on the Oracle VM.
# Build context is this directory (apps/miyagisanchez), NOT the monorepo root:
#   docker build -t ghcr.io/danybgoode/miyagisanchez-storefront:local .
#
# `output: 'standalone'` (next.config.ts) traces the deps each route actually
# needs into .next/standalone/node_modules. That trace does NOT reliably
# include `sharp` — Next's internal image optimizer requires it dynamically at
# runtime rather than via a static import, so static analysis misses most of
# its native binary + JS lib (confirmed by inspecting the traced output: only
# stub package.json files survived, not sharp/lib or the @img/sharp-<platform>
# binaries) — hence the explicit reinstall in the runner stage below, matching
# Next's own self-hosting Dockerfile guidance and this stage's own glibc/amd64
# platform.
#
# public/ and .next/static are NOT part of the standalone trace (Next only
# traces server-side code) — both are copied explicitly per Next's own
# self-hosting docs.

# ---- deps -------------------------------------------------------------------
FROM node:24-slim AS deps
WORKDIR /app
# package-lock.json makes this a deterministic, reproducible install (deps are
# caret-pinned in package.json, but npm ci pins to exactly what's in the
# lockfile — a rebuild of the same commit always gets the same tree).
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder ------------------------------------------------------------------
FROM node:24-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Next.js inlines NEXT_PUBLIC_* into the CLIENT bundle at `next build` time
# below, so they MUST be in process.env here — Cloud Run runtime
# `--set-env-vars` (infra/gcp/deploy-frontend.sh) is too late for any
# 'use client' read. These are all publishable/anon/public keys, public by
# design. Values arrive as --build-args from cloudbuild.yaml (Secret Manager
# for the real keys, substitutions for the literal-default routing vars).
# Builder stage only — the runner stage already gets real values at runtime.
# `lib/listings.ts` is server-rendered during `next build`; give that server
# read the same public store URL so the initial Cloud Run revision pre-renders
# the catalog instead of falling back to localhost and caching an empty home.
# Keep this list in parity with deploy-frontend.sh's NEXT_PUBLIC_*
# --set-env-vars: guarded by infra/gcp/test/frontend-build-args.test.js.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_MEDUSA_MXN_REGION_ID
ARG NEXT_PUBLIC_MP_PUBLIC_KEY
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
ARG NEXT_PUBLIC_MEDUSA_STORE_URL
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_CLERK_SIGN_IN_URL
ARG NEXT_PUBLIC_CLERK_SIGN_UP_URL
ARG NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL
ARG NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL
ARG NEXT_PUBLIC_GTM_ID
ARG NEXT_PUBLIC_MIYAGI_WHATSAPP
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
    NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=$NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY \
    NEXT_PUBLIC_MEDUSA_MXN_REGION_ID=$NEXT_PUBLIC_MEDUSA_MXN_REGION_ID \
    NEXT_PUBLIC_MP_PUBLIC_KEY=$NEXT_PUBLIC_MP_PUBLIC_KEY \
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY \
    NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_VAPID_PUBLIC_KEY=$NEXT_PUBLIC_VAPID_PUBLIC_KEY \
    NEXT_PUBLIC_MEDUSA_STORE_URL=$NEXT_PUBLIC_MEDUSA_STORE_URL \
    MEDUSA_STORE_URL=$NEXT_PUBLIC_MEDUSA_STORE_URL \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_CLERK_SIGN_IN_URL=$NEXT_PUBLIC_CLERK_SIGN_IN_URL \
    NEXT_PUBLIC_CLERK_SIGN_UP_URL=$NEXT_PUBLIC_CLERK_SIGN_UP_URL \
    NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=$NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL \
    NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=$NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL \
    NEXT_PUBLIC_GTM_ID=$NEXT_PUBLIC_GTM_ID \
    NEXT_PUBLIC_MIYAGI_WHATSAPP=$NEXT_PUBLIC_MIYAGI_WHATSAPP

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner -------------------------------------------------------------------
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# The standalone output does NOT ship package-lock.json, and the runner has no other copy
# of it — the /app/package-lock.json that used to exist here was a SIDE EFFECT of the old
# bare `npm install sharp` writing one. The sharp reinstall below pins to it, so copy it
# in explicitly rather than depending on a file another command happened to leave behind.
COPY --from=builder --chown=nextjs:nodejs /app/package-lock.json ./package-lock.json

# Reinstall sharp fresh in THIS stage — the standalone trace above copied only
# stub files for it (see comment at top).
#
# The `rm -rf` is LOAD-BEARING, not tidiness. The standalone trace leaves STUB package
# directories — a valid package.json and lib/index.js, but no binary. npm reads those as
# an already-installed package at a satisfying version, so a bare `npm install sharp`
# re-extracts NOTHING and exits 0 while @img/sharp-libvips-linux-x64's
# lib/libvips-cpp.so.<v> is still absent. sharp then throws ERR_DLOPEN_FAILED at module
# load and every /api/img request 500s — i.e. every product image on the site. That
# shipped: 8 days of dead images from 2026-08-25 (rev 00139), the build green throughout.
# npm 10 (Node 22) happened to repair the stub tree; npm 11 (Node 24) does not, so the
# Node bump alone surfaced it. Deleting the stubs is what forces a real fetch.
#
# PINNED to the lockfile's own resolution, not a bare `sharp`: `npm install sharp`
# re-resolves to the registry's LATEST at build time, ignoring package.json's range and
# the lockfile both, so the runner could ship a different sharp than the builder
# compiled against. Reading the pin from package-lock.json keeps the two stages in step
# with no second place to update.
#
# The `node -e "require('sharp')"` is the gate: it forces the layer to FAIL here if the
# native library cannot actually load, instead of shipping a green image whose image
# route is dead. An install that exits 0 having restored nothing is exactly the failure
# above, and only loading it proves otherwise.
# Runs as root (before the USER switch below), so re-chown the tree it touched.
RUN SHARP_VERSION="$(node -p "require('./package-lock.json').packages['node_modules/sharp'].version")" \
 && rm -rf node_modules/sharp node_modules/@img \
 && npm install --no-save "sharp@${SHARP_VERSION}" \
 && node -e "require('sharp')" \
 && chown -R nextjs:nodejs node_modules

USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
