/**
 * The panel shell (promoter-panel S4.2/S4.3, D12): four steps on one page, «Cobra» and «Entrégala» on the site's own
 * components, and /admin/promoter with buttons that read as buttons (Daniel: «the buttons don't seem clickable»).
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import es from '../locales/es.json' with { type: 'json' }
import en from '../locales/en.json' with { type: 'json' }

const PANEL = 'app/(shell)/promotor/cerrar'
const FILES = [
  `${PANEL}/PromoterCloseClient.tsx`,
  `${PANEL}/NegocioStep.tsx`,
  `${PANEL}/ProductosStep.tsx`,
  `${PANEL}/CobraStep.tsx`,
  `${PANEL}/EntregaStep.tsx`,
  `${PANEL}/PreviewStep.tsx`,
  'app/(shell)/admin/promoter/PromoterAdminClient.tsx',
  'app/(shell)/admin/promoter/activacion/ActivacionScorecardClient.tsx',
]

/** The `<button …>` opening tag starting at `i`: up to the first `>` outside `{…}` (an arrow's `=>` is inside braces). */
function openingTag(src: string, i: number): string {
  let depth = 0
  for (let j = i; j < src.length; j++) {
    const ch = src[j]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '>' && depth === 0) return src.slice(i, j + 1)
  }
  return src.slice(i)
}

/** Every `<button …>` opening tag's class, or null when it has none (a child's class never counts). */
function buttonClasses(src: string): Array<string | null> {
  const out: Array<string | null> = []
  let i = src.indexOf('<button')
  while (i > -1) {
    const tag = openingTag(src, i)
    const m = tag.match(/className=(?:"([^"]*)"|\{([\s\S]*?)\}\s*(?:\n|\/?>|[a-zA-Z-]+=))/)
    out.push(m ? (m[1] ?? m[2]) : null)
    i = src.indexOf('<button', i + 1)
  }
  return out
}

test('every button in the panel and /admin/promoter is a .btn variant', () => {
  for (const file of FILES) {
    const classes = buttonClasses(readFileSync(file, 'utf8'))
    expect(classes.length, file).toBeGreaterThan(0)
    for (const c of classes) expect(c ?? '(no class)', file).toMatch(/btn btn-/)
  }
})

test('the shell renders the four steps; the old close and handoff cards are gone', () => {
  const client = readFileSync(`${PANEL}/PromoterCloseClient.tsx`, 'utf8')
  expect(client).toContain('<CobraStep ')
  expect(client).toContain('<EntregaStep ')
  expect(client).not.toMatch(/function (CloseStep|HandoffStep|SplitLine|Card)\(/)
  expect(client).not.toContain('let n =')
})

test('«Cobra» keeps transfer first: it is the default and its button comes before the card', () => {
  const cobra = readFileSync(`${PANEL}/CobraStep.tsx`, 'utf8')
  expect(cobra).toContain("useState<'card' | 'transfer'>(transferEnabled ? 'transfer' : 'card')")
  expect(cobra.indexOf('{t.byTransfer}')).toBeGreaterThan(-1)
  expect(cobra.indexOf('{t.byTransfer}')).toBeLessThan(cobra.indexOf('{t.byCard}'))
  // The receipt sits in «Cobra», for a package, before any payment of our share.
  expect(cobra.indexOf('<ReceiptBlock')).toBeLessThan(cobra.indexOf('{transfer ? ('))
})

test('«Entrégala» shows «Ver su tienda», «Mandar por WhatsApp» and «Copiar enlace»', () => {
  const entrega = readFileSync(`${PANEL}/EntregaStep.tsx`, 'utf8')
  for (const key of ['{t.see}', '{t.sendLink}', ': t.copyLink}']) expect(entrega).toContain(key)
  expect(entrega).toContain("fetch('/api/promoter/claim/link'")
  expect(es.promotorPanel.entrega.see).toBe('Ver su tienda')
  expect(es.promotorPanel.entrega.sendLink).toBe('Mandar por WhatsApp')
  expect(es.promotorPanel.entrega.copyLink).toBe('Copiar enlace')
})

test('the new copy blocks match in Spanish and English and never say «cerrar»', () => {
  for (const block of ['cobra', 'entrega', 'recibo'] as const) {
    expect(Object.keys(en.promotorPanel[block]).sort(), block).toEqual(Object.keys(es.promotorPanel[block]).sort())
    expect(JSON.stringify(es.promotorPanel[block]), block).not.toMatch(/cerrar|cierre/i)
  }
  // Every visible string in «Cobra» and «Entrégala» comes from the copy block.
  for (const f of ['CobraStep.tsx', 'EntregaStep.tsx']) {
    expect(readFileSync(`${PANEL}/${f}`, 'utf8'), f).not.toMatch(/>\s*[A-ZÁÉÍÓÚ¿][a-záéíóúñ]+ [a-záéíóúñ]+[^<{]*</)
  }
})
