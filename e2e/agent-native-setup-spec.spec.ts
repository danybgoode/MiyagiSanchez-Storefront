import { test, expect } from '@playwright/test'
import {
  validateSetup,
  buildSetupPrompt,
  EXAMPLE_SETUP,
  SETUP_SPEC_VERSION,
  SETUP_LANGUAGE_DIRECTIVE,
} from '../lib/setup-spec'

/**
 * Agent-native setup (Onboarding 0) · Sprint 1 — published versioned setup spec.
 *
 * The pure blocks prove the composed contract works without forking a third schema:
 * validateSetup just splits the file and delegates to the two shipped validators.
 * The API blocks prove the spec is actually discoverable (manifest block, JSON
 * endpoint, MCP tool). No auth, no mutations.
 */

// ── Story 1.1 — validateSetup (pure) ────────────────────────────────────────────
test.describe('setup-spec · validateSetup (1.1)', () => {
  test('the example file round-trips clean', () => {
    const r = validateSetup(EXAMPLE_SETUP)
    expect(r.ok).toBe(true)
    expect(r.version).toBe(SETUP_SPEC_VERSION)
    // config delegated to validateConfig → at least one applied block, no nulls
    expect(r.config).not.toBeNull()
    expect(r.counts.config_blocks_applied).toBeGreaterThan(0)
    // catalog delegated to validateRows → every example row valid
    expect(r.counts.catalog_rows).toBe(EXAMPLE_SETUP.catalog!.length)
    expect(r.counts.catalog_rows_with_errors).toBe(0)
    expect(r.counts.catalog_rows_valid).toBe(r.counts.catalog_rows)
  })

  test('a missing version is a clear error, not a silent partial parse', () => {
    const r = validateSetup({ config: {}, catalog: [] })
    expect(r.ok).toBe(false)
    expect(r.version).toBeNull()
    expect(r.version_error).toBeTruthy()
    expect(r.config).toBeNull()
    expect(r.catalog).toEqual([])
  })

  test('an unknown version is rejected (no partial parse)', () => {
    const r = validateSetup({ miyagi_setup_version: '999', catalog: EXAMPLE_SETUP.catalog })
    expect(r.ok).toBe(false)
    expect(r.version).toBe('999')
    expect(r.version_error).toContain(SETUP_SPEC_VERSION)
    expect(r.config).toBeNull()
  })

  test('a non-object is rejected', () => {
    expect(validateSetup(null).ok).toBe(false)
    expect(validateSetup([]).ok).toBe(false)
    expect(validateSetup('x').ok).toBe(false)
  })

  test('valid version + invalid catalog row is reported per-row (file still ok)', () => {
    const r = validateSetup({ miyagi_setup_version: SETUP_SPEC_VERSION, catalog: [{ title: 'x' }] })
    expect(r.ok).toBe(true)
    expect(r.counts.catalog_rows).toBe(1)
    expect(r.counts.catalog_rows_with_errors).toBe(1)
  })
})

// ── Story 1.2 — buildSetupPrompt (pure) ─────────────────────────────────────────
test.describe('setup-spec · buildSetupPrompt (1.2)', () => {
  const prompt = buildSetupPrompt()

  test('emits the combined shape keys', () => {
    for (const key of ['miyagi_setup_version', 'profile', 'config', 'catalog']) {
      expect(prompt).toContain(`"${key}"`)
    }
  })

  test('carries the mirror-the-seller-language directive', () => {
    expect(prompt).toContain(SETUP_LANGUAGE_DIRECTIVE)
    // robust apostrophe-free phrase that survives escaping
    expect(SETUP_LANGUAGE_DIRECTIVE).toContain('en el mismo idioma que está usando el vendedor')
  })

  test('keeps the safety line + the manual-sections caveat', () => {
    expect(prompt).toContain('SEGURIDAD')
    expect(prompt.toLowerCase()).toContain('paso manual')
    expect(prompt).toContain('Mercado Pago')
  })

  test('states the objective of helping the seller, not just reformatting input', () => {
    expect(prompt).toContain('OBJETIVO')
    expect(prompt).toContain('Ayuda a este vendedor a abrir una tienda completa')
  })

  test('instructs the agent to read Miyagi context before asking or emitting', () => {
    expect(prompt).toContain('PASO 1')
    expect(prompt).toContain('/api/ucp/setup-spec')
    expect(prompt).toContain('https://miyagisanchez.com — qué es Miyagi Sánchez')
    expect(prompt).not.toContain('/mx/vende')
    expect(prompt).toContain('/acerca')
  })

  test('instructs the agent to interview on thin input instead of emitting the bare skeleton', () => {
    expect(prompt).toContain('PASO 2')
    expect(prompt).toContain('ENTREVISTA')
    expect(prompt).toContain('NO generes el esqueleto vacío')
    expect(prompt).toContain('Qué vende')
  })

  test('still ends in the JSON-only final-output contract', () => {
    expect(prompt).toContain('Devuelve ÚNICAMENTE el objeto JSON válido')
    expect(prompt).toContain('sin markdown, sin comentarios, sin texto antes o después')
  })
})

// ── Story 1.3 — published surface (API) ─────────────────────────────────────────
test.describe('setup-spec · published surface (1.3)', () => {
  test('manifest advertises a non-empty seller_onboarding block + capability', async ({ request }) => {
    const res = await request.get('/api/ucp/manifest')
    expect(res.ok()).toBeTruthy()
    const m = await res.json()
    expect(m.capabilities).toEqual(expect.arrayContaining(['seller_onboarding']))
    const block = m.endpoints.seller_onboarding
    expect(block).toBeTruthy()
    expect(block.spec_url).toContain('/api/ucp/setup-spec')
    expect(block.mcp_tools).toEqual(expect.arrayContaining(['get_setup_spec']))
  })

  test('the JSON spec endpoint returns version + prompt + example', async ({ request }) => {
    const res = await request.get('/api/ucp/setup-spec')
    expect(res.ok()).toBeTruthy()
    const spec = await res.json()
    expect(spec.version).toBe(SETUP_SPEC_VERSION)
    expect(typeof spec.prompt).toBe('string')
    expect(spec.prompt).toContain('miyagi_setup_version')
    expect(spec.example.miyagi_setup_version).toBe(SETUP_SPEC_VERSION)
    expect(Array.isArray(spec.catalog_fields)).toBe(true)
    expect(Array.isArray(spec.config_blocks)).toBe(true)
  })

  test('MCP exposes get_setup_spec and returns the spec', async ({ request }) => {
    const list = await request.post('/api/ucp/mcp', {
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    const names: string[] = (await list.json()).result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(expect.arrayContaining(['get_setup_spec']))

    const call = await request.post('/api/ucp/mcp', {
      data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_setup_spec', arguments: {} } },
    })
    const text: string = (await call.json()).result.content[0].text
    expect(text).toContain('miyagi_setup_version')
    expect(text).toContain(SETUP_SPEC_VERSION)
  })

  test('/agent briefing documents the setup spec and does not over-claim a first-run apply', async ({ request }) => {
    const res = await request.get('/agent')
    expect(res.ok()).toBeTruthy()
    const html = await res.text()
    expect(html).toContain('/api/ucp/setup-spec')
    expect(html).toContain('get_setup_spec')
    expect(html).toContain('próximamente')
  })
})
