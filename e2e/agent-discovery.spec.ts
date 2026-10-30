import { test, expect } from '@playwright/test'

/**
 * Agent-facing discovery surface (epic 07 · Agent Connection).
 * Guards the public docs against drifting from the real API again — the exact
 * checks we used to run by hand with curl. All read-only (no mutations).
 */
test.describe('Agent discovery surface', () => {
  test('UCP manifest advertises real capabilities + all MCP tools incl. seller tools', async ({ request }) => {
    const res = await request.get('/api/ucp/manifest')
    expect(res.ok()).toBeTruthy()
    const m = await res.json()
    expect(m.capabilities).toEqual(
      expect.arrayContaining(['seller_configuration', 'scheduling', 'buyer_trust', 'support_widget', 'mcp_server']),
    )
    const tools: string[] = m.endpoints.mcp.mcp_tools
    expect(tools).toEqual(expect.arrayContaining(['get_store_configuration', 'patch_store_configuration', 'get_support_options', 'create_support_checkout']))
    expect(tools.length).toBeGreaterThanOrEqual(13)
    expect(m.endpoints.seller_configuration).toBeTruthy()
    expect(m.endpoints.support_widget.checkout_url).toContain('/api/embed/support/checkout')
  })

  test('/agent briefing uses the real MCP URL and no stale endpoints', async ({ request }) => {
    const res = await request.get('/agent')
    expect(res.ok()).toBeTruthy()
    const html = await res.text()
    expect(html).toContain('/api/ucp/mcp')
    expect(html).toContain('/api/ucp/catalog')
    // The bugs this epic fixed must never come back.
    expect(html).not.toContain('/api/ucp/listings')
    expect(html).not.toContain('/api/mcp')
  })

  test('/agent points the seller CTA at the seller landing, the root — the promoted evaluation target (agent-discovery S1.2)', async ({ request }) => {
    const res = await request.get('/agent')
    expect(res.ok()).toBeTruthy()
    const html = await res.text()
    expect(html).toContain('href="https://miyagisanchez.com/"')
    expect(html).not.toContain('href="https://miyagisanchez.com/mx/vende"')
  })

  test('/agent renders es-MX body copy + a valid, key-English JSON-LD block (agent-discovery S1.1)', async ({ request }) => {
    const res = await request.get('/agent')
    expect(res.ok()).toBeTruthy()
    const html = await res.text()

    // es-MX markers on the page's own authored prose (headings/labels).
    expect(html).toContain('Ficha para agentes')
    expect(html).toContain('¿Qué es este marketplace?')
    expect(html).toContain('Tipos de producto compatibles')
    expect(html).toContain('Métodos de pago')
    expect(html).toContain('Configuración del servidor MCP')

    // Known English sentences from before the translation must not come back.
    expect(html).not.toContain('Agent Briefing')
    expect(html).not.toContain('What is this marketplace?')
    expect(html).not.toContain('Supported product types')
    expect(html).not.toContain('Payment methods</h2>')
    expect(html).not.toContain('For sellers — /mx/vende')

    // The JSON-LD block still parses; schema.org keys stay English (API contract).
    const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
    expect(match).toBeTruthy()
    const jsonLd = JSON.parse(match![1])
    expect(jsonLd['@context']).toBe('https://schema.org')
    expect(jsonLd['@type']).toBe('WebAPI')
    expect(typeof jsonLd.description).toBe('string')
    expect(jsonLd.disambiguatingDescription).toContain('in their own language')
  })

  test('.well-known/ucp resolves to the manifest', async ({ request }) => {
    const res = await request.get('/.well-known/ucp')
    expect(res.ok()).toBeTruthy()
    const m = await res.json()
    expect(m.name).toBe('miyagisanchez-ucp')
  })

  test('MCP tools/list lists seller tools; the seller tool rejects calls without a token', async ({ request }) => {
    const list = await request.post('/api/ucp/mcp', {
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(list.ok()).toBeTruthy()
    const names: string[] = (await list.json()).result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(expect.arrayContaining(['get_store_configuration', 'patch_store_configuration', 'get_support_options', 'create_support_checkout']))

    const call = await request.post('/api/ucp/mcp', {
      data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_store_configuration', arguments: {} } },
    })
    const text: string = (await call.json()).result.content[0].text
    expect(text).toContain('Unauthorized')
  })
})
