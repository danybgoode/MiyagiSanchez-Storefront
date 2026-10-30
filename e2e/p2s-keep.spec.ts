import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { handleMailLink, type MailLinkDeps } from '../lib/prompt-to-shop/mail-link'
import type { OwnedDraftRow } from '../lib/prompt-to-shop/access'
import { fallbackCatalog, fallbackIdentity, fallbackWords } from '../lib/prompt-to-shop/blocks'
import { MAIL_LINK_COPY } from '../lib/prompt-to-shop/copy'
import { validateIdentity } from '../lib/prompt-to-shop/blocks'

// Prompt-to-shop S3.1 — «Quedármela» and «Mándame el enlace». The sheet's Clerk wiring is held at the source (a
// Clerk flow cannot run in the api runner); the mail route's decision is pure and driven with fakes, asserting the
// ORDER: validate → limit → ownership → send, and that a refusal at any step sends nothing.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const DRAFT = '7f2a1b3c-4d5e-4f60-8a71-b2c3d4e5f607'
const DEVICE = '0b9e8c1e-3c2a-4d8e-9a51-6f1f2b3c4d5e'
const SHARE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const identity = fallbackIdentity('Vendo velas de soya en Guadalajara')

function fakes(opts: { allowed?: boolean; sendOk?: boolean } = {}) {
  const trace: string[] = []
  const sent: Array<Parameters<MailLinkDeps['send']>[0]> = []
  const row: OwnedDraftRow = {
    id: DRAFT, identity, words: fallbackWords(identity), catalog: fallbackCatalog(),
    block_status: { identity: 'ok', words: 'ok', catalog: 'ok' }, versions_used: 1, updated_at: 'x', view_token: SHARE,
  }
  const deps: MailLinkDeps = {
    allowed: async (device) => { trace.push(`limit:${device}`); return opts.allowed ?? true },
    findOwned: async (id, device) => { trace.push('findOwned'); return id === DRAFT && device === DEVICE ? row : null },
    send: async (mail) => { trace.push('send'); sent.push(mail); return opts.sendOk ?? true },
  }
  return { trace, sent, deps }
}

test('the owner gets both links by email: validate, limit, ownership, then send', async () => {
  const f = fakes()
  const res = await handleMailLink({ draftId: DRAFT, body: { email: '  Ana@Ejemplo.MX ' }, deviceCookie: DEVICE }, f.deps)
  expect(res).toEqual({ status: 200, body: { ok: true, message: MAIL_LINK_COPY.sent } })
  expect(f.trace).toEqual([`limit:${DEVICE}`, 'findOwned', 'send'])
  expect(f.sent).toEqual([{ to: 'ana@ejemplo.mx', shopName: identity.name, draftId: DRAFT, sharePath: `/p2s/v/${SHARE}` }])
})

test('a malformed address sends nothing and spends no limit', async () => {
  for (const email of ['', 'sin-arroba', 'a@b', 'dos@@x.mx', 'con espacio@x.mx', 42, null]) {
    const f = fakes()
    const res = await handleMailLink({ draftId: DRAFT, body: { email }, deviceCookie: DEVICE }, f.deps)
    expect(res.status, String(email)).toBe(400)
    expect(f.trace, String(email)).toEqual([])
  }
})

test('a spent limit sends nothing and does not even read the draft', async () => {
  const f = fakes({ allowed: false })
  const res = await handleMailLink({ draftId: DRAFT, body: { email: 'ana@ejemplo.mx' }, deviceCookie: DEVICE }, f.deps)
  expect(res.status).toBe(429)
  expect(f.trace).toEqual([`limit:${DEVICE}`])
})

test('only the phone that made the draft can mail it: another device, no cookie, or the share token as the id send nothing', async () => {
  const shapes: Array<[string, { draftId: string; deviceCookie: string | undefined }]> = [
    ['another device', { draftId: DRAFT, deviceCookie: '66666666-6666-4666-8666-666666666666' }],
    ['no cookie', { draftId: DRAFT, deviceCookie: undefined }],
    ['share token as the id', { draftId: SHARE, deviceCookie: DEVICE }],
  ]
  for (const [label, input] of shapes) {
    const f = fakes()
    const res = await handleMailLink({ ...input, body: { email: 'ana@ejemplo.mx' } }, f.deps)
    expect(res.status, label).toBe(404)
    expect(f.trace, label).not.toContain('send')
  }
})

test('a provider refusal is reported as not sent, never as «Listo»', async () => {
  const f = fakes({ sendOk: false })
  const res = await handleMailLink({ draftId: DRAFT, body: { email: 'ana@ejemplo.mx' }, deviceCookie: DEVICE }, f.deps)
  expect(res).toMatchObject({ status: 503, body: { ok: false, error: 'failed' } })
})

test('the mail route is limited, cookie-owned, and reaches the token only through the owner resolution', () => {
  const route = strip(read('app/api/p2s/link/[id]/route.ts'))
  expect(route).toContain("checkRateLimit('p2s_mail_link', ip)")
  expect(route).toContain("checkRateLimit('p2s_mail_link_device', deviceId)")
  expect(read('lib/ratelimit.ts')).toContain("prefix: 'rl:p2s_mail_link_device'")
  expect(route).toContain('DEVICE_COOKIE')
  expect(route).toContain('readDeps.findOwned')
  expect(route).not.toMatch(/searchParams|nextUrl|headers\.get/)
  expect(read('lib/ratelimit.ts')).toContain("prefix: 'rl:p2s_mail_link'")
})

test('the email says where the shop can be kept, and links the owner path and the view-only path', () => {
  const email = read('lib/email.ts')
  const sender = email.slice(email.indexOf('export async function sendP2sDraftLink'), email.indexOf('/** General account welcome'))
  expect(sender).toContain('`${SITE}/p2s/${encodeURIComponent(ctx.draftId)}`')
  expect(sender).toContain('`${SITE}${ctx.sharePath}`')
  expect(sender).toContain('en el teléfono donde la armaste')
})

test('the sheet signs up with Clerk by hash and lands on /sell/armar by FALLBACK, never force', () => {
  const sheet = strip(read('app/(shell)/p2s/_components/KeepSheet.tsx'))
  expect(sheet).toContain('const keepHref = `/sell/armar?draft=${draftId}`')
  expect(sheet).toContain('<LazySignUp')
  expect(sheet).toContain('routing="hash"')
  expect(sheet).toContain('fallbackRedirectUrl={keepHref}')
  expect(sheet).toContain('signInFallbackRedirectUrl={keepHref}')
  expect(sheet).toContain('signInUrl={`/sign-in?redirect_url=${encodeURIComponent(keepHref)}`}')
  // Force would hijack a `redirect_url`; the env var is dead config in Clerk v7.
  expect(sheet).not.toMatch(/forceRedirectUrl|ForceRedirectUrl|AFTER_SIGN_IN_URL|AFTER_SIGN_UP_URL/)
  // A Google sign-up returns with a Clerk hash that only a mounted <SignUp> can finish.
  expect(sheet).toContain("window.location.hash.startsWith('#/')")
  // …read as an external store, never set from inside an effect (react-hooks/set-state-in-effect).
  expect(sheet).toContain('useSyncExternalStore(subscribeHash, readClerkHash, noClerkHashOnServer)')
  expect(sheet).toContain("addEventListener('hashchange'")
  expect(sheet).toContain('const open = !signedIn && (opened || (clerkHash && !dismissed))')
})

test('signed in, «Quedármela» is a plain link to the claim — no sheet', () => {
  const sheet = strip(read('app/(shell)/p2s/_components/KeepSheet.tsx'))
  expect(sheet).toMatch(/signedIn && ready \? \(\s*<Link href=\{keepHref\}/)
  expect(sheet).toContain('{open && !signedIn ? (')
  const page = read('app/(shell)/p2s/[id]/page.tsx')
  expect(page).toContain('const { userId } = await auth()')
  expect(page).toContain('signedIn={!!userId}')
  const owner = read('app/(shell)/p2s/_components/OwnerCanvas.tsx')
  expect(owner).toContain("can('keep') ? <KeepSheet")
})

test('/sell/armar sends a signed-out visitor back to their draft, and never claims during the render', () => {
  const page = strip(read('app/(shell)/sell/armar/page.tsx'))
  expect(page).toContain("redirect(draftId ? `/p2s/${draftId}` : sellerLandingPath('mx'))")
  expect(page).toContain("export const dynamic = 'force-dynamic'")
  // The claim runs in the route handler (it busts the shop cache, which a render may not do).
  expect(page).not.toMatch(/claimAndApply|claimDeps|revalidateTag/)
  expect(page).toContain('findKeptDraft(userId, draftId)')
})

test('the per-device mail limit is keyed on the cookie device; a missing cookie still meets the IP limit', async () => {
  const f = fakes()
  await handleMailLink({ draftId: DRAFT, body: { email: 'ana@ejemplo.mx' }, deviceCookie: undefined }, f.deps)
  expect(f.trace[0]).toBe('limit:null')
})

test('a shop name is one line: control characters and line breaks are refused, and stripped before a subject', () => {
  const base = { name: 'Velas Luna', tagline: 'Hechas a mano', description: 'Velas de soya.', accent_color: '#1f6f5c', accent_alternates: ['#8a3b12', '#2f4b8a', '#6b2f6b'], theme_preset: 'papel' }
  expect(validateIdentity(base).ok).toBe(true)
  for (const name of ['Velas\nLuna', 'Velas\r\nBcc: x@y.mx', 'Velas\u0007Luna', 'Velas\u2028Luna']) {
    expect(validateIdentity({ ...base, name }).ok, JSON.stringify(name)).toBe(false)
  }
  const email = read('lib/email.ts')
  const sender = email.slice(email.indexOf('export async function sendP2sDraftLink'), email.indexOf('/** General account welcome'))
  expect(sender).toContain("const shopName = plainLine(ctx.shopName) || 'Tu tienda'")
  expect(sender).not.toContain('ctx.shopName}')
})

test('a keep whose colours and words did not save says so, and is not refreshed into a view that claims they landed', () => {
  const runner = read('app/(shell)/p2s/_components/ClaimRunner.tsx')
  expect(runner).toContain("result.kind === 'kept' && result.configApplied) router.refresh()")
  expect(runner).toContain("outcome?.kind === 'kept' && !outcome.configApplied")
  expect(runner).toContain('ARMAR_COPY.configFailedLead')
})
