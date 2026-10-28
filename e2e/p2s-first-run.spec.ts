import { expect, test } from '@playwright/test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import es from '../locales/es.json' with { type: 'json' }

// Prompt-to-shop S3.3 — Bienvenida and Puertas leave the main path. The first run is `/sell`'s describe box; the two
// old addresses only redirect there, and a source sweep proves nothing in the app still sends anyone to them.

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const OLD = /\/sell\/(bienvenida|puertas)\b/

test('the two old routes are redirects to /sell and render nothing else', () => {
  for (const file of ['app/(shell)/sell/(onboarding)/bienvenida/page.tsx', 'app/(shell)/sell/(onboarding)/puertas/page.tsx']) {
    const src = strip(read(file))
    expect(src, file).toContain("redirect('/sell')")
    expect(src, file).not.toMatch(/<[A-Z]|return\s*\(/)
  }
  expect(existsSync(join(ROOT, 'app/(shell)/sell/(onboarding)/bienvenida/BienvenidaClient.tsx'))).toBe(false)
  expect(existsSync(join(ROOT, 'app/(shell)/sell/(onboarding)/puertas/PuertasClient.tsx'))).toBe(false)
})

test('source sweep: no link, push or redirect to /sell/bienvenida or /sell/puertas remains', () => {
  // The two redirect pages are the old addresses themselves; `onboarding-path` only names them for the chrome
  // decision. Everything else under app/, lib/ and components/ must not send anyone there.
  const allowed = new Set(['lib/onboarding-path.ts'])
  const hits: string[] = []
  let scanned = 0
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, name)
      if (name === 'node_modules' || name === '.next') continue
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel)
      else if (/\.(ts|tsx)$/.test(name)) {
        scanned++
        if (OLD.test(strip(read(rel))) && !allowed.has(relative('.', rel))) hits.push(relative('.', rel))
      }
    }
  }
  for (const dir of ['app', 'lib', 'components']) walk(dir)
  hits.push(...(OLD.test(strip(read('middleware.ts'))) ? ['middleware.ts'] : []))
  expect(scanned).toBeGreaterThan(500)
  expect(hits).toEqual([])
  // The sweep can fail: the shapes the old code used are caught.
  expect(OLD.test(strip("router.push('/sell/puertas')"))).toBe(true)
  expect(OLD.test(strip("redirect('/sell/bienvenida')"))).toBe(true)
  expect(OLD.test(strip('// /sell/puertas in a comment'))).toBe(false)
})

test('/sell keeps the file import and the manual wizard one tap from the describe box', () => {
  const sell = read('app/(shell)/sell/page.tsx')
  expect(sell).toContain('href="/sell/setup"')
  expect(sell).toContain('¿Ya tienes tu catálogo en un archivo?')
  expect(sell).toContain('{!existingShop && <AgentSetupNudge />}')
  expect(sell).toContain('<SellWizard')
  expect(sell).not.toMatch(/getTenantIntake|onboarding_skip|three_doors_enabled/)
  // The file import's back link returns to the first run, not to the chooser that left.
  expect(read('app/(shell)/sell/(onboarding)/agente/AgenteIntakeClient.tsx')).toContain('<Link href="/sell"')
})

test('/mx/vende prints the brand once in its title', () => {
  const page = read('app/(shell)/mx/vende/page.tsx')
  expect(page).toContain('title: { absolute: meta.title }')
  // The template would append « | Miyagi Sánchez» to a title that already ends with the brand.
  expect(es.sellerAcquisition.anchor.metadata.title).toMatch(/Miyagi Sánchez$/)
})
