import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalCandidateShopUrl } from '../lib/candidate-shop-url'
import { validateApplicationInput } from '../lib/promoter-applications'
import { buildRecruitingAnalyticsPayload } from '../lib/recruiting-events'
import { coarseRecruitingSource } from '../lib/recruiting-source'
import { getPartnerIdentityByClerkId, isPromoterEconomicIdentity } from '../lib/promoter'
import { isLegacyPartnerTrackSchemaError, resolvePartnerRecruitingPreflight } from '../lib/partner-recruiting-preflight'

const ROOT = process.cwd()
const PARTNER_IDENTITY_BY_CLERK_ID_CONSUMERS = [
  'app/(shell)/partner/page.tsx',
  'lib/portfolio/draft-server.ts',
  'lib/relationship-access.ts',
] as const
const PROMOTER_IDENTITY_BY_CLERK_ID_CONSUMERS = [
  'app/(shell)/promotor/cerrar/page.tsx',
  'app/(shell)/mx/vende/promotor/page.tsx',
  'app/api/promoter/claim/link/route.ts',
  'app/api/promoter/close/listing/route.ts',
  'app/api/promoter/close/migration/route.ts',
  'app/api/promoter/close/package/[sku]/route.ts',
  'app/api/promoter/close/photo/route.ts',
  'app/api/promoter/close/receipt/route.ts', // promoter-panel S4: the merchant's receipt
  // close/print and rate-card are retired (410, no printed ads since 2026-11-05): they read no identity at all.
  'app/api/promoter/close/transfer/[id]/report/route.ts',
  'app/api/promoter/close/transfer/route.ts',
  'app/api/promoter/preview/activate/route.ts',
  'app/api/promoter/preview/route.ts',
  'app/api/promoter/shop/setup/route.ts',
  'lib/promoter-import-server.ts', // promoter-panel S1: the import routes' shared preamble
] as const
const PARTNER_IDENTITY_BY_ID_CONSUMERS = [
  'lib/portfolio/partner-portfolio-auth.ts',
] as const
const PROMOTER_IDENTITY_BY_ID_CONSUMERS = [
  'app/api/admin/promoter/transfers/[id]/approve/route.ts',
  'app/api/admin/promoter/transfers/[id]/reject/route.ts',
  'lib/promoter-close-notify.ts',
] as const
// Not a resolver consumer, on purpose: lib/promoter-receipt-read.ts reads only `name, code` of the promoter id inside a
// SIGNED receipt token (minted for a promoter-track identity by /api/promoter/close/receipt), with no track filter, so
// a promoter later moved to another track does not turn every receipt they issued into a 404 (pr-reviewer, #483).
// It grants nothing and computes no economics.

function sourceFilesBelow(relativeDirectory: string): string[] {
  const found: string[] = []
  const visit = (relativePath: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, relativePath), { withFileTypes: true })) {
      const child = path.join(relativePath, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (/\.tsx?$/.test(entry.name)) found.push(child)
    }
  }
  visit(relativeDirectory)
  return found
}

const VALID = {
  name: ' Operator Example ', email: 'OPERATOR@EXAMPLE.COM', whatsapp: '+1 212 555 0100', website: '',
  program_track: 'founding_operator', operator_details_version: 2,
  operator_details: { city: ' Austin, TX ', motivation: ' I already sell to these businesses. ' },
} as const

test.describe('partners recruiting v3 · operator contract', () => {
  test('accepts the five-field v2 intake and normalizes it', () => {
    const result = validateApplicationInput(VALID)
    expect(result.ok).toBe(true)
    if (result.ok && 'program_track' in result.clean) {
      expect(result.clean.program_track).toBe('founding_operator')
      expect(result.clean.email).toBe('operator@example.com')
      expect(result.clean.name).toBe('Operator Example')
      expect(result.clean.operator_details_version).toBe(2)
      expect(result.clean.operator_details).toEqual({ city: 'Austin, TX', motivation: 'I already sell to these businesses.' })
    }
  })

  test('motivation is optional and an empty answer is stored as null, never as ""', () => {
    const result = validateApplicationInput({ ...VALID, operator_details: { city: 'Austin, TX', motivation: '   ' } })
    expect(result.ok).toBe(true)
    if (result.ok && 'program_track' in result.clean) expect(result.clean.operator_details.motivation).toBeNull()
  })

  test('rejects unknown keys, missing contact details, a bad email and over-long answers', () => {
    expect(validateApplicationInput({ ...VALID, secret: 'nope' })).toEqual({ ok: false, reason: 'invalid_payload' })
    expect(validateApplicationInput({ ...VALID, operator_details: { ...VALID.operator_details, password: 'nope' } })).toEqual({ ok: false, reason: 'invalid_payload' })
    expect(validateApplicationInput({ ...VALID, website: 'https://spam.example' })).toEqual({ ok: false, reason: 'honeypot' })
    expect(validateApplicationInput({ ...VALID, whatsapp: '' })).toEqual({ ok: false, reason: 'missing_fields' })
    expect(validateApplicationInput({ ...VALID, email: 'not-an-email' })).toEqual({ ok: false, reason: 'invalid_email' })
    expect(validateApplicationInput({ ...VALID, operator_details: { city: 'x'.repeat(161), motivation: null } })).toEqual({ ok: false, reason: 'too_long' })
    expect(validateApplicationInput({ ...VALID, operator_details: { city: 'Austin', motivation: 'x'.repeat(1201) } })).toEqual({ ok: false, reason: 'too_long' })
  })

  test('the intake accepts version 2 and NOTHING else', () => {
    // The DB CHECK still accepts a stored v1 row; the INTAKE does not, so a replayed
    // dossier cannot reopen the three-shop program through the public endpoint.
    //
    // The version gate is asserted with OTHERWISE-VALID v2 details on purpose. A full v1
    // dossier is also rejected for having unknown detail keys, so testing with one would
    // pass even with the version check deleted — which is exactly what happened the first
    // time this was written.
    for (const operator_details_version of [1, 3, '2', null, undefined]) {
      expect(
        validateApplicationInput({ ...VALID, operator_details_version }),
        `version ${String(operator_details_version)} must be refused`,
      ).toEqual({ ok: false, reason: 'invalid_payload' })
    }
    expect(validateApplicationInput({ ...VALID, operator_details_version: 2 }).ok).toBe(true)
  })

  test('rejects unknown program tracks', () => {
    expect(validateApplicationInput({ name: 'X', email: 'x@example.com', whatsapp: '555', program_track: 'operator' })).toEqual({ ok: false, reason: 'invalid_payload' })
    expect(validateApplicationInput({ name: 'X', email: 'x@example.com', whatsapp: '555', program_track: '' })).toEqual({ ok: false, reason: 'invalid_payload' })
  })

  test('public URL contract canonicalizes and rejects credentials/local/private schemes without fetching', () => {
    expect(canonicalCandidateShopUrl(' HTTPS://Example.COM/path#private ')).toBe('https://example.com/path')
    for (const value of ['ftp://example.com', 'https://user:pass@example.com', 'https://intranet', 'http://localhost:3000', 'http://127.0.0.1', 'http://10.1.2.3', 'http://192.168.1.1', 'http://[::1]', 'http://[fd00::1]', 'http://[fe80::1]', 'http://[::ffff:192.168.1.1]', 'http://[::ffff:c0a8:101]', 'not a url']) {
      expect(canonicalCandidateShopUrl(value), value).toBeNull()
    }
  })

  test('legacy Promotor validation remains byte-compatible when track is absent', () => {
    expect(validateApplicationInput({ name: ' Test ', email: 'TEST@example.com', whatsapp: ' 555 ', city: ' CDMX ', motivation: ' Hola ' })).toEqual({
      ok: true, clean: { name: 'Test', email: 'test@example.com', whatsapp: '555', city: 'CDMX', motivation: 'Hola' },
    })
  })
})

test.describe('partners recruiting v3 · partner MCP preflight', () => {
  const operator = {
    id: 'operator-1', code: 'MYP-TEST', name: 'Test Operator', program_track: 'founding_operator',
    partner_token_hash: null, partner_connector_slug: null,
  } as const

  test('returns a reusable rolled-back identity result without consuming the MCP bucket', async () => {
    const result = await resolvePartnerRecruitingPreflight({
      loadPartner: async () => operator,
      partnerMcpEnabled: async () => true,
      recruitingV3Enabled: async () => false,
    })
    expect(result).toEqual({ kind: 'operator_rolled_back', partner: operator })
  })

  test('adds no preflight identity read in normal recruiting-ON operation', async () => {
    let identityReads = 0
    const result = await resolvePartnerRecruitingPreflight({
      loadPartner: async () => { identityReads += 1; return operator },
      partnerMcpEnabled: async () => true,
      recruitingV3Enabled: async () => true,
    })
    expect(result).toEqual({ kind: 'recruiting_enabled' })
    expect(identityReads).toBe(0)
  })

  test('bounds OFF-path identity work and treats an exhausted lookup budget as generic denial', async () => {
    let identityReads = 0
    const result = await resolvePartnerRecruitingPreflight({
      loadPartner: async () => { identityReads += 1; return operator },
      partnerMcpEnabled: async () => true,
      recruitingV3Enabled: async () => false,
      preflightAllowed: async () => false,
    })
    expect(result).toEqual({ kind: 'partner_preflight_limited' })
    expect(identityReads).toBe(0)
  })

  test('preserves confirmed absence and storage unavailability as different states', async () => {
    await expect(resolvePartnerRecruitingPreflight({
      loadPartner: async () => null,
      partnerMcpEnabled: async () => true,
      recruitingV3Enabled: async () => false,
    })).resolves.toEqual({ kind: 'partner_absent' })
    await expect(resolvePartnerRecruitingPreflight({
      loadPartner: async () => { throw new Error('partner_identity_unavailable') },
      partnerMcpEnabled: async () => true,
      recruitingV3Enabled: async () => false,
    })).rejects.toThrow('partner_identity_unavailable')
  })

  test('denies a disabled partner MCP path before recruiting or identity storage reads', async () => {
    const calls: string[] = []
    const result = await resolvePartnerRecruitingPreflight({
      partnerMcpEnabled: async () => { calls.push('partner-flag'); return false },
      recruitingV3Enabled: async () => { calls.push('recruiting-flag'); return false },
      loadPartner: async () => { calls.push('identity'); throw new Error('must not read identity') },
      preflightAllowed: async () => { calls.push('preflight-rate'); return true },
    })
    expect(result).toEqual({ kind: 'partner_mcp_disabled' })
    expect(calls).toEqual(['partner-flag', 'preflight-rate'])

    await expect(resolvePartnerRecruitingPreflight({
      partnerMcpEnabled: async () => false,
      recruitingV3Enabled: async () => { throw new Error('must not read recruiting flag') },
      loadPartner: async () => { throw new Error('must not read identity') },
      preflightAllowed: async () => false,
    })).resolves.toEqual({ kind: 'partner_preflight_limited' })
  })

  test('recognizes only the known pre-migration program_track schema gap', () => {
    expect(isLegacyPartnerTrackSchemaError({ code: '42703', message: 'column marketplace_promoters.program_track does not exist' })).toBe(true)
    expect(isLegacyPartnerTrackSchemaError({ code: '42703', message: 'column something_else does not exist' })).toBe(false)
    expect(isLegacyPartnerTrackSchemaError({ code: '08006', message: 'connection failure' })).toBe(false)
  })
})

test.describe('partners recruiting v3 · privacy-closed measurement', () => {
  test('builds only the fixed coarse vocabulary', () => {
    expect(buildRecruitingAnalyticsPayload({ event: 'application_submitted', track: 'founding_operator', source: 'campaign' })).toEqual({
      event: 'partners_recruiting_application_submitted', recruitment_track: 'founding_operator', funnel_stage: 'application_submitted', recruitment_source: 'campaign',
    })
    expect(buildRecruitingAnalyticsPayload({ event: 'application_disqualified', track: 'promoter', source: 'internal', reason: 'shop_count' })).toMatchObject({ disqualification_reason: 'shop_count' })
  })

  test('maps query attribution to the coarse source allowlist only', () => {
    expect(coarseRecruitingSource(undefined)).toBe('direct')
    expect(coarseRecruitingSource('internal')).toBe('internal')
    expect(coarseRecruitingSource('campaign')).toBe('campaign')
    expect(coarseRecruitingSource('newsletter-person@example.com')).toBe('unknown')
    expect(coarseRecruitingSource(['campaign'])).toBe('unknown')
  })

  test('drops URL/contact/free-text/merchant keys and unknown enum values at runtime', () => {
    for (const payload of [
      { event: 'view', track: 'founding_operator', source: 'direct', url: 'https://secret.example' },
      { event: 'view', track: 'founding_operator', source: 'direct', email: 'person@example.com' },
      { event: 'view', track: 'founding_operator', source: 'direct', company_name: 'Private' },
      { event: 'view', track: 'founding_operator', source: 'utm_campaign' },
      { event: 'anything', track: 'founding_operator', source: 'direct' },
    ]) expect(buildRecruitingAnalyticsPayload(payload)).toBeNull()
  })
})

test.describe('partners recruiting v3 · schema, gate and population guards', () => {
  test('partner identity lookup distinguishes confirmed absence from unavailable storage', async () => {
    await expect(getPartnerIdentityByClerkId('user_absent', async () => ({ data: null, error: null }))).resolves.toBeNull()
    await expect(getPartnerIdentityByClerkId('user_operator', async () => ({
      data: null,
      error: { message: 'program_track column unavailable' },
    }))).rejects.toThrow('partner_identity_unavailable')
  })

  test('migration is additive, defaults both tracks to promoter, keeps the flag dark and locks SQL functions to service_role', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260806120000_miyagi_partners_recruiting_v3.sql'), 'utf8')
    expect(sql.match(/program_track TEXT NOT NULL DEFAULT 'promoter'/g)).toHaveLength(2)
    expect(sql).toContain("program_track IN ('promoter', 'founding_operator')")
    expect(sql).toContain("status IN ('pending', 'approved', 'rejected')")
    expect(sql).toContain("status IN ('pending', 'approved')")
    expect(sql).toContain("'partners.recruiting_v3_enabled', false")
    expect(sql.match(/SECURITY DEFINER/g)).toHaveLength(5)
    expect(sql.match(/SET search_path = public, pg_temp/g)).toHaveLength(5)
    expect(sql.match(/GRANT EXECUTE ON FUNCTION [^\n]+ TO service_role;/g)).toHaveLength(5)
    expect(sql).toContain('ALTER TABLE marketplace_promoter_applications ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('REVOKE ALL ON TABLE marketplace_promoter_applications FROM PUBLIC, anon, authenticated')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE marketplace_promoter_applications TO service_role')
    for (const table of ['marketplace_promoters', 'partner_grants']) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
      expect(sql).toContain(`REVOKE ALL ON TABLE ${table} FROM PUBLIC, anon, authenticated`)
      expect(sql).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO service_role`)
    }
    expect(sql).toContain("p_activation_token_hash !~ '^[0-9a-f]{64}$'")
    expect(sql).toContain("invitation_provider_status IN ('pending', 'provider_accepted', 'unconfirmed')")
    expect(sql).toContain("invitation_provider_status = 'pending'")
    expect(sql).toContain('CREATE OR REPLACE FUNCTION miyagi_rotate_founding_operator_invitation')
    expect(sql).toContain('CREATE OR REPLACE FUNCTION miyagi_record_founding_operator_invitation_outcome')
    expect(sql).toContain("p_provider_outcome NOT IN ('provider_accepted', 'unconfirmed')")
    expect(sql).toContain('invitation_provider_accepted_at')
    expect(sql).not.toContain('invitation_delivered_at')
    expect(sql).toContain('AND activation_token_hash = p_activation_token_hash')
    expect(sql).toContain('coalesce(invitation_attempt_count, 0) + 1')
    expect(sql).toContain('IF v_application.invitation_provider_status = p_provider_outcome THEN')
    expect(sql).toContain("IF v_application.invitation_provider_status <> 'pending' THEN")
    expect(sql.indexOf('IF v_application.invitation_provider_status = p_provider_outcome THEN')).toBeLessThan(sql.indexOf('coalesce(invitation_attempt_count, 0) + 1'))
    expect(sql.indexOf("IF v_application.invitation_provider_status <> 'pending' THEN")).toBeLessThan(sql.indexOf('coalesce(invitation_attempt_count, 0) + 1'))
    expect(sql).toContain('p_verified_emails TEXT[]')
    expect(sql).toContain('lower(btrim(verified_email)) = lower(btrim(v_application.email))')
    expect(sql.indexOf('activation_principal_mismatch')).toBeLessThan(sql.indexOf('PERFORM miyagi_bind_partner_identity'))
    expect(sql).toContain('REVOKE ALL ON FUNCTION miyagi_activate_founding_operator(TEXT, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated')
  })

  test('one server resolver gates the recruiting route and operator intake, 404ing while the program is closed', () => {
    const resolver = fs.readFileSync(path.join(ROOT, 'lib/recruiting-v3.ts'), 'utf8')
    const page = fs.readFileSync(path.join(ROOT, 'app/(us-site)/us/operators/page.tsx'), 'utf8')
    const route = fs.readFileSync(path.join(ROOT, 'app/api/promoter/apply/route.ts'), 'utf8')
    const form = fs.readFileSync(path.join(ROOT, 'app/(us-site)/us/operators/OperatorApplication.tsx'), 'utf8')
    const partnerPage = fs.readFileSync(path.join(ROOT, 'app/(shell)/partner/page.tsx'), 'utf8')
    const relationshipAccess = fs.readFileSync(path.join(ROOT, 'lib/relationship-access.ts'), 'utf8')
    const rejectRoute = fs.readFileSync(path.join(ROOT, 'app/api/admin/promoter/applications/[id]/reject/route.ts'), 'utf8')
    const directMcp = fs.readFileSync(path.join(ROOT, 'app/api/ucp/mcp/route.ts'), 'utf8')
    const connectorMcp = fs.readFileSync(path.join(ROOT, 'app/api/ucp/mcp/p/[slug]/route.ts'), 'utf8')
    expect(resolver).toContain("isEnabled('partners.recruiting_v3_enabled')")
    // Recruiting lives at /us/operators, not /us: the market root is the US marketplace home
    // and flipping this flag must never close it. Flag off is a 404 — the program has not
    // opened — never a page implying the marketplace itself is unavailable.
    expect(page).toContain('if (!(await recruitingV3Enabled())) notFound()')
    // The page renders through the shared brand shell, not a bespoke local layout.
    expect(page).toContain('SellerAcquisitionPage')
    expect(page).toContain("export const dynamic = 'force-dynamic'")
    expect(route).toContain('if (operatorTrack && !(await recruitingV3Enabled()))')
    expect(route.indexOf('await req.json()')).toBeLessThan(route.indexOf('if (operatorTrack && !(await recruitingV3Enabled()))'))
    expect(route.indexOf('if (operatorTrack && !(await recruitingV3Enabled()))')).toBeLessThan(route.indexOf("checkRateLimit('promoter_apply'"))
    expect(route).toContain("if (result.reason === 'honeypot') return NextResponse.json(operatorTrack ? { ok: true, received: true } : { ok: true })")
    expect(route).toContain("operatorTrack ? { ok: true, received: true } : { ok: true }")
    expect(route).not.toContain('duplicate:')
    expect(form).not.toContain('data.duplicate')
    expect(form).not.toContain('data.error ??')
    expect(form).toContain('copy.validation.rateLimited')
    expect(partnerPage).toContain("import { recruitingV3Enabled } from '@/lib/recruiting-v3'")
    expect(partnerPage).toContain('recruitingV3Enabled()')
    expect(partnerPage).not.toContain("isEnabled('partners.recruiting_v3_enabled')")
    expect(partnerPage).toContain("partnerWorkspaceAdmitted(promoter.program_track ?? 'promoter', partnerMcpEnabled, recruitingEnabled)")
    expect(partnerPage).toContain("promoter.program_track === 'founding_operator'")
    expect(partnerPage).toContain('operatorUi!.trackLabel')
    expect(partnerPage).toContain('operatorUi!.zeroShops')
    expect(partnerPage).toContain("let grantsState: 'available' | 'unavailable' = 'available'")
    expect(partnerPage).toContain('grantError')
    expect(partnerPage).toContain('shopError')
    expect(partnerPage).toContain('missingShopIds')
    expect(partnerPage).toContain("missingShopIds.length > 0")
    expect(partnerPage).toContain("grantsState === 'unavailable'")
    expect(partnerPage).toContain('operatorUi!.shopsUnavailable')
    expect(partnerPage).toContain('const showPortfolio = portfolioEnabled && !foundingOperator')
    expect(partnerPage).toContain('{!foundingOperator &&')
    const legacyPartnerHeader = partnerPage.slice(partnerPage.indexOf('{!foundingOperator && promoter ?'), partnerPage.indexOf(') : !promoter ?', partnerPage.indexOf('{!foundingOperator && promoter ?')))
    expect(legacyPartnerHeader).not.toContain('{foundingOperator ?')
    expect(partnerPage.indexOf('getPartnerIdentityByClerkId(user.id)')).toBeLessThan(partnerPage.indexOf(".from('partner_grants')"))
    expect(relationshipAccess).toContain("actor.programTrack === 'founding_operator' && !(await recruitingV3Enabled())")
    expect(relationshipAccess.indexOf("actor.programTrack === 'founding_operator'")).toBeLessThan(relationshipAccess.indexOf("checkRateLimit('relationship'"))
    expect(rejectRoute).toContain("application?.program_track === 'founding_operator' && !(await recruitingV3Enabled())")
    expect(rejectRoute.indexOf('getPromoterApplication(id)')).toBeLessThan(rejectRoute.indexOf('rejectPromoterApplication(id)'))
    const ratePeek = directMcp.indexOf("await peekRateLimit('mcp'")
    const bodyParse = directMcp.indexOf('await req.json()')
    const directPreflight = directMcp.indexOf('await partnerRecruitingPreflight(')
    const peekDenial = directMcp.indexOf('if (!ratePeek.allowed)')
    const rateConsume = directMcp.indexOf("await checkRateLimit('mcp'")
    expect(ratePeek).toBeGreaterThan(-1)
    expect(bodyParse).toBeGreaterThan(-1)
    expect(directPreflight).toBeGreaterThan(-1)
    expect(rateConsume).toBeGreaterThan(-1)
    expect(ratePeek).toBeLessThan(directPreflight)
    expect(bodyParse).toBeLessThan(directPreflight)
    expect(directPreflight).toBeLessThan(peekDenial)
    expect(peekDenial).toBeLessThan(rateConsume)
    expect(directPreflight).toBeLessThan(rateConsume)
    expect(connectorMcp).not.toContain('checkRateLimit(')
    expect(connectorMcp).not.toContain('partnerRecruitingPreflight(')
    expect(connectorMcp).toContain('return baseMcpPost(forwarded)')
    const partnerAuth = fs.readFileSync(path.join(ROOT, 'lib/partner-auth.ts'), 'utf8')
    expect(partnerAuth).toContain('if (byHashError) throw new Error(\'partner_identity_unavailable\'')
    expect(partnerAuth).toContain('if (bySlugError) throw new Error(\'partner_identity_unavailable\'')
    expect(partnerAuth).toContain("program_track: 'promoter'")
    expect(partnerAuth).toContain('isLegacyPartnerTrackSchemaError(byHashError)')
    expect(partnerAuth).toContain('isLegacyPartnerTrackSchemaError(bySlugError)')
    expect(directMcp).toContain("checkRateLimit('mcp_partner_preflight', ip)")
    expect(directMcp).toContain("partnerPreflight.kind === 'partner_preflight_limited'")
    expect(directMcp).not.toContain("partnerPreflight.kind === 'partner_mcp_disabled' ||")
    expect(directMcp).toContain("partnerPreflight.kind !== 'partner_mcp_disabled'")
    expect(directMcp).toContain('const partnerToolCall = requests.some(isPartnerSellerToolCall)')
    expect(directMcp).toContain("partnerToolCall ? await partnerRecruitingPreflight(")
  })

  test('the English-default US recruiting journey is dictionary-backed and exposes Spanish', () => {
    const page = fs.readFileSync(path.join(ROOT, 'app/(us-site)/us/operators/page.tsx'), 'utf8')
    const form = fs.readFileSync(path.join(ROOT, 'app/(us-site)/us/operators/OperatorApplication.tsx'), 'utf8')
    const bilingual = fs.readFileSync(path.join(ROOT, 'lib/bilingual-namespaces.ts'), 'utf8')
    const email = fs.readFileSync(path.join(ROOT, 'lib/email.ts'), 'utf8')
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en.json'), 'utf8'))
    const es = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/es.json'), 'utf8'))
    expect(bilingual).toContain("'partnersRecruiting'")
    expect(en.partnersRecruiting.landing.heroTitle).toContain('Open the store')
    expect(es.partnersRecruiting.landing.heroTitle).toContain('Abre la tienda')
    expect(en.partnersRecruiting.application.submit).toBe('Send application')
    expect(es.partnersRecruiting.application.submit).toBe('Enviar solicitud')
    expect(en.partnersRecruiting.application.validation.rateLimited).toBeTruthy()
    expect(es.partnersRecruiting.application.validation.rateLimited).toBeTruthy()
    // Read through the override layer, so an /admin/contenido edit to a key this page
    // already advertises actually changes the page.
    expect(page).toContain('getOverriddenDictionary(locale)')
    expect(page).toContain("locale: 'en' | 'es'")
    expect(form).toContain('copy: OperatorApplicationCopy')
    const rejectionEmail = email.slice(email.indexOf('export async function sendFoundingOperatorApplicationRejected'), email.indexOf('// ══', email.indexOf('export async function sendFoundingOperatorApplicationRejected')))
    expect(rejectionEmail).toContain("ctx.locale ? [ctx.locale] : ['en', 'es']")
    expect(en.partnersRecruiting.email.rejectionHeading).toContain('Thanks for applying')
    expect(es.partnersRecruiting.email.rejectionHeading).toContain('Gracias por aplicar')
    for (const hardcodedEnglish of [
      'Open the store. Close in person.',
      'What you are actually selling',
      'Tell us who you are.',
      'Send application',
    ]) {
      expect(page, hardcodedEnglish).not.toContain(hardcodedEnglish)
      expect(form, hardcodedEnglish).not.toContain(hardcodedEnglish)
    }
  })

  test('the retired "here is what is honestly true" framing is gone from both locales', () => {
    // Every one of these shipped on this page at some point. They are the reason the
    // rewrite happened: a landing page that spends its hero disclaiming itself does not
    // sell anything. Banning the exact strings keeps a future pass from reintroducing them.
    // Scoped to the namespace, not the whole dictionary: "90 días" is legitimate copy
    // elsewhere on the platform (warranty and returns windows), and a guard that fires on
    // correct copy is one people learn to delete.
    const en = JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en.json'), 'utf8')).partnersRecruiting)
    const es = JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/es.json'), 'utf8')).partnersRecruiting)
    for (const [locale, blob] of [['en', en], ['es', es]] as const) {
      for (const banned of [
        'What is true today', 'Lo que es cierto hoy',
        'no-cutover', 'sin migración forzada',
        // #387 corrected a factually WRONG claim in the panel this rewrite deletes: the page
        // said the United States has no open marketplace, which stopped being true when /us
        // opened. That panel is gone, so the claim cannot return through it — but the claim
        // itself stays banned here so it cannot reappear anywhere in the namespace, which is
        // the protection #387's assertions on `truthBody` were providing before that key
        // ceased to exist.
        'no open marketplace', 'no tiene un marketplace abierto',
        'grants no marketplace admission', 'no otorga admisión al marketplace',
        '90-day', '90 días',
        'Not this program', 'Este programa no es',
        'not accepted yet', 'aún no está aceptado',
        'granted no permission', 'no otorgó permisos',
        'Founding Commerce Operator',
      ]) {
        expect(blob.includes(banned), `${locale}: "${banned}" is back`).toBe(false)
      }
    }
  })

  test('operator intake and review cannot create grants/consent or expose activation hashes', () => {
    const intake = fs.readFileSync(path.join(ROOT, 'lib/promoter-applications.ts'), 'utf8')
    const admin = fs.readFileSync(path.join(ROOT, 'app/(shell)/admin/promoter/PromoterAdminClient.tsx'), 'utf8')
    const form = fs.readFileSync(path.join(ROOT, 'app/(us-site)/us/operators/OperatorApplication.tsx'), 'utf8')
    expect(intake).not.toContain("from('partner_grants')")
    expect(intake).not.toMatch(/relationship|consent/i)
    expect(admin).toContain('rel="noopener noreferrer"')
    expect(admin).toContain('merchantAwarenessLabel(shop.merchant_awareness)')
    expect(admin).toContain('platformLabel(shop.platform)')
    expect(admin).not.toContain('{shop.platform} ·')
    const resendInvitation = admin.slice(admin.indexOf('async function resendInvitation'), admin.indexOf('\n  }', admin.indexOf('async function resendInvitation')))
    expect(resendInvitation).toContain('} catch {')
    expect(resendInvitation).toContain('No se pudo rotar la invitación.')
    for (const hardcodedEnglish of ['Practice', 'Active shops', 'Confirmed', 'Request conversation', 'Nomination is not merchant consent.']) {
      expect(admin, hardcodedEnglish).not.toContain(hardcodedEnglish)
    }
    // The intake collects contact details and a territory — never a merchant's shop URL,
    // which is what made the old dossier a nomination surface in the first place.
    expect(form).not.toContain('candidate_shops')
    expect(form).not.toContain('shop_url')
    expect(form).toContain('operator_details_version: 2')
    expect(admin).not.toContain('activation_token_hash')
  })

  test('the exact legacy identity/economic callsite inventory is classified and track-safe', () => {
    const promoter = fs.readFileSync(path.join(ROOT, 'lib/promoter.ts'), 'utf8')
    const autoGrant = fs.readFileSync(path.join(ROOT, 'lib/partner-grant-server.ts'), 'utf8')
    const applications = fs.readFileSync(path.join(ROOT, 'lib/promoter-applications.ts'), 'utf8')
    const functionBlocks = [...promoter.matchAll(/export async function (\w+)[\s\S]*?(?=\nexport (?:async )?function |\nexport (?:interface|type|const) |$)/g)]
      .filter((match) => match[0].includes(".from('marketplace_promoters')"))
    expect(promoter.match(/\.from\('marketplace_promoters'\)/g) ?? []).toHaveLength(functionBlocks.length)
    expect(functionBlocks.map((match) => match[1]).sort()).toEqual([
      'accrueCommissionForAttribution', 'createPromoter', 'getPromoterByClerkId',
      'getPartnerIdentityByClerkId', 'getPartnerIdentityById', 'getPromoterByCode', 'getPromoterById', 'listPromoters',
    ].sort())
    for (const [name, body] of functionBlocks.map((match) => [match[1], match[0]] as const)) {
      if (name === 'createPromoter') expect(body).toContain(".insert({ code, name: cleanName, program_track: 'promoter' })")
      else if (name === 'getPartnerIdentityByClerkId' || name === 'getPartnerIdentityById') {
        expect(body).toContain(".select('id, code, name, clerk_user_id, program_track, created_at')")
        expect(body).not.toContain(".eq('program_track', 'promoter')")
      } else expect(body, name).toContain(".eq('program_track', 'promoter')")
    }

    const resolverCalls = /\b(?:getPartnerIdentityByClerkId|getPromoterByClerkId|getPartnerIdentityById|getPromoterById)\s*\(/
    const consumerFiles = [...sourceFilesBelow('app'), ...sourceFilesBelow('lib')]
      .filter((file) => file !== 'lib/promoter.ts')
      .filter((file) => resolverCalls.test(fs.readFileSync(path.join(ROOT, file), 'utf8')))
      .sort()
    expect(consumerFiles).toEqual([
      ...PARTNER_IDENTITY_BY_CLERK_ID_CONSUMERS,
      ...PROMOTER_IDENTITY_BY_CLERK_ID_CONSUMERS,
      ...PARTNER_IDENTITY_BY_ID_CONSUMERS,
      ...PROMOTER_IDENTITY_BY_ID_CONSUMERS,
    ].sort())
    for (const file of PARTNER_IDENTITY_BY_CLERK_ID_CONSUMERS) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
      expect(source, file).toMatch(/\bgetPartnerIdentityByClerkId\s*\(/)
      expect(source, file).not.toMatch(/\bgetPromoterByClerkId\s*\(/)
    }
    for (const file of PROMOTER_IDENTITY_BY_CLERK_ID_CONSUMERS) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
      expect(source, file).toMatch(/\bgetPromoterByClerkId\s*\(/)
      expect(source, file).not.toMatch(/\bgetPartnerIdentityByClerkId\s*\(/)
    }
    for (const file of PARTNER_IDENTITY_BY_ID_CONSUMERS) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
      expect(source, file).toMatch(/\bgetPartnerIdentityById\s*\(/)
      expect(source, file).not.toMatch(/\bgetPromoterById\s*\(/)
    }
    for (const file of PROMOTER_IDENTITY_BY_ID_CONSUMERS) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
      expect(source, file).toMatch(/\bgetPromoterById\s*\(/)
      expect(source, file).not.toMatch(/\bgetPartnerIdentityById\s*\(/)
    }
    const bindBlock = promoter.slice(
      promoter.indexOf('export async function bindPromoterClerkId'),
      promoter.indexOf('/** All promoters', promoter.indexOf('export async function bindPromoterClerkId')),
    )
    expect(bindBlock).toContain('getPartnerIdentityByClerkId(clerkUserId)')
    expect(bindBlock).toContain("db.rpc('miyagi_bind_partner_identity'")
    expect(bindBlock).not.toContain('.update({ clerk_user_id:')
    expect(autoGrant).toContain(".eq('program_track', 'promoter')")
    expect(applications.indexOf("program_track === 'founding_operator'")).toBeLessThan(applications.indexOf('createPromoter(claimed.name)'))
    expect(applications).toContain("reason: 'operator_approval_unavailable'")
  })

  test('commission economics fail closed when the promoter-track identity is absent', () => {
    expect(isPromoterEconomicIdentity(null)).toBe(false)
    expect(isPromoterEconomicIdentity({ clerk_user_id: null, program_track: 'founding_operator' })).toBe(false)
    expect(isPromoterEconomicIdentity({ clerk_user_id: null, program_track: 'promoter' })).toBe(true)
  })
})
