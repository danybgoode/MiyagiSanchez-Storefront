import { test, expect } from '@playwright/test'
import {
  buildClerkPrompt,
  buildClerkHandoff,
  SELLER_MCP_TOOLS,
  CLERK_PROMPT_VERSION,
  MIYAGI_MCP_URL,
  SETUP_LANGUAGE_DIRECTIVE,
} from '../lib/setup-spec'

/**
 * Agent-native setup (Onboarding 0) · Sprint 3 — shop-clerk handoff prompt.
 *
 * Pure-logic coverage of the canonical operate-prompt: it names every already-live
 * seller MCP tool, mirrors the seller's language (one shared directive), frames the
 * CEO/CMO/COO working modes as prompt text, points at the MCP endpoint, and stays
 * es-MX copy-complete (no orphan placeholders). No auth, no network.
 */

const prompt = buildClerkPrompt()

// ── Story 3.1 — names every live MCP tool ──────────────────────────────────────
test.describe('clerk-prompt · names the live seller MCP tools (3.1)', () => {
  test('the toolset is the 9 live seller tools (get_share_kit added by share-kit S3.3)', () => {
    expect(SELLER_MCP_TOOLS.map((t) => t.name)).toEqual([
      'get_store_configuration',
      'patch_store_configuration',
      'create_listing',
      'list_my_listings',
      'get_share_kit',
      'update_listing',
      'set_listing_status',
      'list_offers',
      'respond_to_offer',
    ])
  })

  test('the prompt names every tool in SELLER_MCP_TOOLS', () => {
    expect(prompt.length).toBeGreaterThan(0)
    for (const tool of SELLER_MCP_TOOLS) {
      expect(prompt, `prompt should name ${tool.name}`).toContain(tool.name)
    }
  })
})

// ── Story 3.1 — language-mirroring instruction is present ───────────────────────
test.describe('clerk-prompt · language-mirroring (3.1)', () => {
  test('carries the shared language directive', () => {
    expect(prompt).toContain(SETUP_LANGUAGE_DIRECTIVE)
  })

  test('contains the stable apostrophe-free mirror phrase', () => {
    expect(prompt).toContain('el mismo idioma que está usando el vendedor')
  })
})

// ── Story 3.1 — CEO/CMO/COO working modes (prompt guidance, not a feature) ──────
test.describe('clerk-prompt · CEO/CMO/COO working modes (3.1)', () => {
  test('mentions all three modes as suggested working modes', () => {
    expect(prompt).toContain('CEO')
    expect(prompt).toContain('CMO')
    expect(prompt).toContain('COO')
  })
})

// ── Story 3.1 — connection + MCP endpoint ───────────────────────────────────────
test.describe('clerk-prompt · MCP connection (3.1)', () => {
  test('points at the MCP endpoint', () => {
    expect(prompt).toContain('/api/ucp/mcp')
    expect(prompt).toContain(MIYAGI_MCP_URL)
  })

  test('the handoff snapshot is self-describing + versioned', () => {
    const h = buildClerkHandoff()
    expect(h.version).toBe(CLERK_PROMPT_VERSION)
    expect(h.mcp_url).toBe(MIYAGI_MCP_URL)
    expect(h.tools).toEqual(SELLER_MCP_TOOLS)
    expect(h.prompt).toBe(prompt)
  })
})

// ── Story 3.1 — es-MX copy-completeness (no orphan/placeholder strings) ─────────
test.describe('clerk-prompt · es-MX copy-completeness (3.1)', () => {
  test('no leftover placeholder tokens in the canonical prompt', () => {
    // NB: "TODO" is legit Spanish ("todo el texto") — assert only true placeholders.
    expect(prompt).not.toContain('PEGA_TU_TOKEN')
    expect(prompt).not.toContain('XXX')
    expect(prompt).not.toContain('undefined')
    expect(prompt).not.toContain('null')
  })

  test('every tool description is non-empty', () => {
    for (const tool of SELLER_MCP_TOOLS) {
      expect(tool.desc.trim().length, `${tool.name} desc`).toBeGreaterThan(0)
    }
  })
})
