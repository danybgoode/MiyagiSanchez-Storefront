import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// merchant-features-surfaced-by-promoter-kit S3.1 (D8): the share tools live in Canales, the old URL redirects there.
const ROOT = path.resolve(import.meta.dirname, '..')
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8')
const MANAGE = 'app/(shell)/shop/manage'

test.describe('Comparte moved into Canales (D8)', () => {
  test('/shop/manage/comparte redirects to Canales — the target, not just a rendering page', () => {
    // A passing page spec cannot see a redirect (LEARNINGS). The route cannot be imported here (no next runtime in the
    // api runner), so pin the one redirect call in its source: its target, and that it is the only thing the page does.
    const source = read(`${MANAGE}/comparte/page.tsx`)
    const calls = [...source.matchAll(/\bredirect\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1])
    expect(calls).toEqual(['/shop/manage/canal-propio'])
    expect(source).not.toMatch(/db\.|currentUser|<[A-Z]/)
  })

  test('Canales renders the catalog link, PDF and Meta feed tiles', () => {
    const section = read(`${MANAGE}/canal-propio/ShareToolsSection.tsx`)
    for (const tile of ['<CatalogLinkTile', '<CatalogPdfTile', '<MetaFeedTile']) expect(section).toContain(tile)
    expect(read(`${MANAGE}/canal-propio/page.tsx`)).toContain('<ShareToolsSection')
    // the Meta feed keeps its claimed-shop condition
    expect(read(`${MANAGE}/canal-propio/page.tsx`)).toContain('const metaFeed = model?.shop.claimed')
  })

  test('the agent panel is not part of the share surface, and only Agentes and /sell/setup import it', () => {
    expect(read(`${MANAGE}/canal-propio/ShareToolsSection.tsx`)).not.toContain('ConnectAgentPanel')
    expect(read(`${MANAGE}/comparte/page.tsx`)).not.toContain('ConnectAgentPanel')
    expect(read(`${MANAGE}/settings/_sections/Agentes.tsx`)).toContain('ConnectAgentPanel')
    expect(read('app/(shell)/sell/setup/SetupClient.tsx')).toContain('ConnectAgentPanel')
  })

  test('nothing links to the old URL any more', () => {
    for (const f of ['lib/business-plan/engine.ts', 'lib/setup-guide.ts']) {
      expect(read(f), f).not.toContain('/shop/manage/comparte')
    }
  })
})
