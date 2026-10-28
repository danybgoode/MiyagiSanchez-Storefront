import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * nextpublic-docker-buildargs-hardening — locks in that the Cloud Run frontend
 * Docker build actually receives every NEXT_PUBLIC_* var as a build-arg.
 *
 * This is a fast-follow from two live prod bugs (home-dynamic-rows-restore-
 * and-polish S1, checkout-cloudrun-localhost-fallback-outage): Next.js inlines
 * NEXT_PUBLIC_* into the CLIENT bundle at `next build` time, but the Docker
 * build never received them as build-args — only Cloud Run RUNTIME env vars
 * (set by infra/gcp/deploy-frontend.sh, applied after the image already
 * exists) — so any 'use client' file reading one directly baked in
 * `undefined` permanently.
 *
 * REPO BOUNDARY NOTE: `infra/gcp/deploy-frontend.sh` lives in a SEPARATE,
 * independently-hosted repo (danybgoode/MiyagiSanchez-Product) from this
 * one — neither repo's CI can see the other's files (no cross-repo PAT was
 * taken on for this hardening task). This spec is therefore anchored to the
 * SAME explicit `NEXT_PUBLIC_VARS` list as
 * infra/gcp/test/frontend-build-args.test.js in that other repo (kept
 * identical by convention) — a residual manual-sync risk, but far smaller
 * than a guard that silently can't run at all across the boundary.
 *
 * Pure fs-read/regex checks, no browser/request fixture — runs in the `api`
 * project alongside cloudbuild-cache.spec.ts / dockerfile-lockfile.spec.ts.
 */

const ROOT = process.cwd()
const dockerfileFull = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
const cloudbuild = readFileSync(join(ROOT, 'cloudbuild.yaml'), 'utf8')

// MUST stay identical to the NEXT_PUBLIC_VARS array in the root repo's
// infra/gcp/test/frontend-build-args.test.js.
const NEXT_PUBLIC_VARS = [
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_MEDUSA_MXN_REGION_ID',
  'NEXT_PUBLIC_MP_PUBLIC_KEY',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
  'NEXT_PUBLIC_MEDUSA_STORE_URL',
  'NEXT_PUBLIC_SITE_URL',
  'NEXT_PUBLIC_CLERK_SIGN_IN_URL',
  'NEXT_PUBLIC_CLERK_SIGN_UP_URL',
  'NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL',
  'NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL',
  // Added 2026-07-17 (nextpublic-buildtime-inlining-audit close-out): GTM_ID was
  // Vercel-only env — the Cloud Run cutover dropped it and analytics went dark
  // (live-bundle-confirmed). MIYAGI_WHATSAPP is server-read today but same class.
  'NEXT_PUBLIC_GTM_ID',
  'NEXT_PUBLIC_MIYAGI_WHATSAPP',
]

const SUBSTITUTION_VARS = [
  'NEXT_PUBLIC_MEDUSA_STORE_URL',
  'NEXT_PUBLIC_SITE_URL',
  'NEXT_PUBLIC_CLERK_SIGN_IN_URL',
  'NEXT_PUBLIC_CLERK_SIGN_UP_URL',
  'NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL',
  'NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL',
  'NEXT_PUBLIC_GTM_ID',
  'NEXT_PUBLIC_MIYAGI_WHATSAPP',
]
const SECRET_VARS = NEXT_PUBLIC_VARS.filter((n) => !SUBSTITUTION_VARS.includes(n))

const dockerfileBuilderStage = dockerfileFull.slice(
  dockerfileFull.indexOf('AS builder'),
  dockerfileFull.indexOf('AS runner'),
)
const dockerfileRunnerStage = dockerfileFull.slice(dockerfileFull.indexOf('AS runner'))

test.describe('Dockerfile — NEXT_PUBLIC_* builder-stage ARG/ENV', () => {
  test('every NEXT_PUBLIC_* var is declared as a builder-stage ARG', () => {
    for (const name of NEXT_PUBLIC_VARS) {
      expect(dockerfileBuilderStage, `missing ARG ${name}`).toMatch(new RegExp(`^ARG ${name}$`, 'm'))
    }
  })

  test('every NEXT_PUBLIC_* ARG is ENV-exported (else `next build` cannot see it)', () => {
    for (const name of NEXT_PUBLIC_VARS) {
      expect(dockerfileBuilderStage, `missing ENV export for ${name}`).toMatch(
        new RegExp(`${name}=\\$${name}`),
      )
    }
  })

  test('the server-side catalog fetch receives the public Medusa URL while prerendering', () => {
    // `lib/listings.ts` reads MEDUSA_STORE_URL, not NEXT_PUBLIC_MEDUSA_STORE_URL.
    // Without this bridge the builder hits localhost, catches the failure, and
    // ships the first Cloud Run revision with a cached empty marketplace.
    expect(dockerfileBuilderStage).toMatch(
      /^\s*MEDUSA_STORE_URL=\$NEXT_PUBLIC_MEDUSA_STORE_URL/m,
    )
  })

  test('no NEXT_PUBLIC_* var leaks into the runner stage', () => {
    for (const name of NEXT_PUBLIC_VARS) {
      expect(dockerfileRunnerStage, `${name} must not appear in the runner stage — it gets a real value at Cloud Run runtime`).not.toContain(name)
    }
  })
})

test.describe('GitHub deployment notification workflow', () => {
  test('keeps the immediate push alert but does not poll retired Vercel production', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/notify-telegram.yml'), 'utf8')

    expect(workflow).toContain('name: Push notification')
    expect(workflow).toContain('📦')
    expect(workflow).not.toMatch(/vercel-production-deploy|Vercel production|api\.vercel\.com|target=production/)
  })
})

test.describe('cloudbuild.yaml — NEXT_PUBLIC_* build-args', () => {
  test('every NEXT_PUBLIC_* var is passed as a --build-arg', () => {
    for (const name of NEXT_PUBLIC_VARS) {
      expect(cloudbuild, `missing --build-arg ${name}`).toMatch(new RegExp(`--build-arg ${name}=`))
    }
  })

  test('the default-bearing vars resolve from substitutions, not secrets', () => {
    for (const name of SUBSTITUTION_VARS) {
      expect(cloudbuild, `missing _${name}: under substitutions:`).toMatch(new RegExp(`_${name}:`))
      expect(cloudbuild, `${name} build-arg must reference the substitution`).toMatch(
        new RegExp(`--build-arg ${name}="\\$\\{_${name}\\}"`),
      )
    }
  })

  test('the real-key vars resolve from Secret Manager secretEnv, not substitutions', () => {
    for (const name of SECRET_VARS) {
      expect(cloudbuild, `missing ${name} under secretEnv:`).toMatch(new RegExp(`^\\s*- ${name}\\s*$`, 'm'))
      expect(cloudbuild, `${name} build-arg must reference the secretEnv var`).toMatch(
        new RegExp(`--build-arg ${name}="\\$\\$${name}"`),
      )
    }
  })

  test('NEXT_PUBLIC_SUPABASE_URL reuses the existing SUPABASE_URL secret (not a duplicate)', () => {
    expect(cloudbuild).toMatch(
      /versionName:\s*projects\/\$PROJECT_ID\/secrets\/SUPABASE_URL\/versions\/latest\s*\n\s*env:\s*NEXT_PUBLIC_SUPABASE_URL/,
    )
  })

  test('the build-and-push step still ends with --push and the two image tags (unchanged by the secretEnv/bash conversion)', () => {
    expect(cloudbuild).toMatch(/--push/)
    expect(cloudbuild).toMatch(/-t \$\{_REGION\}-docker\.pkg\.dev\/\$PROJECT_ID\/\$\{_AR_REPO\}\/frontend:\$SHORT_SHA/)
    expect(cloudbuild).toMatch(/-t \$\{_REGION\}-docker\.pkg\.dev\/\$PROJECT_ID\/\$\{_AR_REPO\}\/frontend:latest/)
  })
})

// ── Source-scan guard — the systemic close of nextpublic-buildtime-inlining-audit ──
//
// The lists above lock the PIPELINE side (Dockerfile/cloudbuild carry every known
// var). This test locks the SOURCE side: any `process.env.NEXT_PUBLIC_X` read that
// appears anywhere in app code must be in NEXT_PUBLIC_VARS, or the Cloud Run image
// build never receives it and every 'use client' read inlines `undefined` — the
// exact failure that shipped three times (Medusa URL, checkout MEDUSA_BASE, GTM_ID,
// the last one killing analytics silently for a week). With this test, introducing
// a new NEXT_PUBLIC_* var without extending the build-arg rail is a red gate
// locally and in CI instead of a silent prod regression.

import { readdirSync, statSync } from 'fs'

const SOURCE_DIRS = ['app', 'lib', 'components', 'hooks'].filter((d) => {
  try {
    return statSync(join(ROOT, d)).isDirectory()
  } catch {
    return false
  }
})

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) collectSourceFiles(p, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p)
  }
  return out
}

test.describe('app source — every NEXT_PUBLIC_* read is covered by the build-arg rail', () => {
  test('no process.env.NEXT_PUBLIC_* read of a var missing from NEXT_PUBLIC_VARS', () => {
    const offenders: string[] = []
    for (const dir of SOURCE_DIRS) {
      for (const file of collectSourceFiles(join(ROOT, dir))) {
        const src = readFileSync(file, 'utf8')
        for (const m of src.matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)) {
          if (!NEXT_PUBLIC_VARS.includes(m[1])) {
            offenders.push(`${file.slice(ROOT.length + 1)} reads ${m[1]}`)
          }
        }
      }
    }
    expect(
      offenders,
      `NEXT_PUBLIC_* vars read in source but missing from the build-arg rail — add them to NEXT_PUBLIC_VARS here AND in Dockerfile + cloudbuild.yaml + the root repo's infra/gcp/test/frontend-build-args.test.js + deploy-frontend.sh, or they inline undefined on Cloud Run:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
