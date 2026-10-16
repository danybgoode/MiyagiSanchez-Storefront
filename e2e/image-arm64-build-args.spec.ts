import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * miyagi-to-oracle-vm S1.2 — the arm64 image built by .github/workflows/image-arm64.yml must receive
 * EXACTLY the build args cloudbuild.yaml gives the Cloud Run image, with the same literal values.
 *
 * Why it is DERIVED, not retyped: a manual image build without its NEXT_PUBLIC values cannot boot
 * (Clerk fail-fast — LEARNINGS, gcp-account-migration (7)), and a wrong routing literal (a localhost
 * store URL) bakes a dead endpoint into the client bundle permanently. Both images are built from the
 * same push until the cutover, so the moment they drift, the VM serves a different site than Cloud Run.
 *
 * Pure fs-read checks — runs in the `api` project next to frontend-build-args.spec.ts.
 */

const ROOT = process.cwd()
const cloudbuild = readFileSync(join(ROOT, 'cloudbuild.yaml'), 'utf8')
const workflow = readFileSync(join(ROOT, '.github/workflows/image-arm64.yml'), 'utf8')

// cloudbuild.yaml → `--build-arg NAME="..."` lines, split by where the value comes from.
const cbArgs = [...cloudbuild.matchAll(/--build-arg (NEXT_PUBLIC_[A-Z_]+)="([^"]*)"/g)].map((m) => ({
  name: m[1],
  source: m[2],
}))
// `_NAME: 'value'` substitution defaults — the literal a substitution-sourced arg resolves to.
const substitutions = Object.fromEntries(
  [...cloudbuild.matchAll(/^\s+_(NEXT_PUBLIC_[A-Z_]+): '([^']*)'/gm)].map((m) => [m[1], m[2]]),
)

// image-arm64.yml → the `build-args: |` block, one NAME=value per line.
const block = workflow.slice(workflow.indexOf('build-args: |'))
const wfArgs = Object.fromEntries(
  [...block.matchAll(/^\s+(NEXT_PUBLIC_[A-Z_]+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]),
)

test.describe('image-arm64.yml mirrors cloudbuild.yaml', () => {
  test('cloudbuild.yaml was parsed (a vacuous comparison passes nothing)', () => {
    expect(cbArgs.length).toBeGreaterThanOrEqual(16)
  })

  test('the same set of NEXT_PUBLIC build args, no more, no fewer', () => {
    expect(Object.keys(wfArgs).sort()).toEqual(cbArgs.map((a) => a.name).sort())
  })

  test('every substitution-sourced arg carries cloudbuild.yaml\'s own default, verbatim', () => {
    for (const { name } of cbArgs.filter((a) => a.source.startsWith('${_'))) {
      expect(substitutions, `no substitution default for ${name}`).toHaveProperty(name)
      expect(wfArgs[name], `${name} drifted from cloudbuild.yaml`).toBe(substitutions[name])
    }
  })

  test('every Secret-Manager-sourced arg reads its PROD_-prefixed production environment variable', () => {
    // Plain names would fall back to the repo-level CI variables (pk_test keys, localhost) when a
    // production value is missing — the prefix is what makes "missing" mean empty (PR #432 review).
    for (const { name } of cbArgs.filter((a) => a.source.startsWith('$$'))) {
      expect(wfArgs[name]).toBe(`\${{ vars.PROD_${name} }}`)
    }
    expect(workflow).toMatch(/^\s+environment: production$/m)
  })

  test('live-mode prefixes are enforced for every payment/auth key', () => {
    expect(workflow).toMatch(/NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" in pk_live_\*/)
    expect(workflow).toMatch(/NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY" in pk_live_\*/)
    expect(workflow).toMatch(/NEXT_PUBLIC_MP_PUBLIC_KEY" in APP_USR-\*/)
  })

  test('the build refuses to run with a missing production value', () => {
    for (const { name } of cbArgs.filter((a) => a.source.startsWith('$$'))) {
      expect(workflow, `${name} is not checked before the build`).toMatch(new RegExp(`for v in[\\s\\S]*${name}[\\s\\S]*done`))
    }
  })
})
