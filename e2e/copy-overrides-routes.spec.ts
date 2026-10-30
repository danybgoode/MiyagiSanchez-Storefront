import { expect, test } from '@playwright/test'
import { routeForKey, routeForNamespaceSection, namespaceLabel, NO_SINGLE_PAGE_LABEL } from '../lib/copy-overrides-routes'
import esDictionary from '../locales/es.json' with { type: 'json' }

// Pure-seam coverage for the namespace/section → page/URL lookup (epic 08 ·
// cms-contenido-restore-and-polish, Story 2.1). No browser, no network.

test.describe('routeForKey / routeForNamespaceSection', () => {
  test('simple single-page namespaces resolve to their real route', () => {
    expect(routeForKey('home', 'hero.heading')).toEqual({ label: 'Inicio', path: '/mx' })
    expect(routeForKey('terms', 'title')).toEqual({ label: 'Términos', path: '/terminos' })
    expect(routeForKey('acerca', 'intro')).toEqual({ label: 'Acerca (plataforma)', path: '/acerca' })
  })

  test('sellerAcquisition fans out per-section to the real /mx/vende/* page', () => {
    expect(routeForKey('sellerAcquisition', 'anchor.heroTitle')).toEqual({ label: 'Vende (portada)', path: '/' })
    expect(routeForKey('sellerAcquisition', 'autos.heroTitle')).toEqual({ label: 'Vende — Autos', path: '/mx/vende/autos' })
    expect(routeForKey('sellerAcquisition', 'migracionShopify.heroTitle')).toEqual({
      label: 'Vende — Migración Shopify',
      path: '/mx/vende/migracion/shopify',
    })
  })

  // Sprint 4 — sweepstakes/events each fan into 3 sections on 3 DIFFERENT
  // real surfaces; before this fix all 3 incorrectly resolved to the public
  // route alone (confirmed against the real getDictionary() call sites).
  test('sweepstakes fans out per-section — public page, seller-portal page, and email are all different destinations', () => {
    expect(routeForKey('sweepstakes', 'public.notFound')).toEqual({ label: 'Sorteos — público', path: '/g/[slug]' })
    expect(routeForKey('sweepstakes', 'seller.killSwitch')).toEqual({
      label: 'Sorteos — panel de tienda',
      path: '/shop/manage/sweepstakes',
    })
    expect(routeForKey('sweepstakes', 'email.verificationSubject')).toEqual({
      label: 'Sorteos — correos',
      path: '(correo transaccional, no es una página web)',
    })
  })

  test('events fans out per-section the same way sweepstakes does', () => {
    expect(routeForKey('events', 'public.notFound')).toEqual({ label: 'Eventos — público', path: '/e/[slug]' })
    expect(routeForKey('events', 'seller.roster')).toEqual({
      label: 'Eventos — panel de tienda',
      path: '/shop/manage/eventos',
    })
    expect(routeForKey('events', 'email.confirmationSubject')).toEqual({
      label: 'Eventos — correos',
      path: '(correo transaccional, no es una página web)',
    })
  })

  test('partners recruiting fans out to activation, workspace and transactional email', () => {
    expect(routeForNamespaceSection('partnersRecruiting', 'activation')).toEqual({
      label: 'Miyagi Partners — activación', path: '/partner/activate/[token]',
    })
    expect(routeForNamespaceSection('partnersRecruiting', 'workspace')).toEqual({
      label: 'Miyagi Partners — espacio de trabajo', path: '/partner',
    })
    expect(routeForNamespaceSection('partnersRecruiting', 'email')).toEqual({
      label: 'Miyagi Partners — correos', path: '(correo transaccional, no es una página web)',
    })
  })

  test('every KNOWN no-single-page case (shared /mx/vende/* copy, site-wide config, email templates) is a real RouteInfo, not null', () => {
    expect(routeForNamespaceSection('sellerAcquisition', 'shared')).not.toBeNull()
    expect(routeForNamespaceSection('platformTheme', 'toggle')).not.toBeNull()
    expect(routeForNamespaceSection('pwaSearch', 'title')).not.toBeNull()
    expect(routeForNamespaceSection('sweepstakes', 'email')).not.toBeNull()
    expect(routeForNamespaceSection('events', 'email')).not.toBeNull()
  })

  test('mundial, promotorMigracion, and aiChannel — the 3 sections a review pass found missing — now resolve', () => {
    expect(routeForNamespaceSection('sellerAcquisition', 'mundial')).toEqual({
      label: 'Vende — Mundial',
      path: '/mx/vende/mundial',
    })
    expect(routeForNamespaceSection('sellerAcquisition', 'promotorMigracion')).toEqual({
      label: 'Vende — Promotor Migración',
      path: '/mx/vende/promotor/migracion',
    })
    expect(routeForNamespaceSection('sellerAcquisition', 'aiChannel')).toEqual({
      label: 'Vende (portada)',
      path: '/',
    })
  })

  test('EVERY real sellerAcquisition section in the compiled dictionary resolves to a deliberate entry — not an accidental fallback', () => {
    const realSections = Object.keys((esDictionary as { sellerAcquisition: Record<string, unknown> }).sellerAcquisition)
    const unmapped = realSections.filter(
      (section) => section !== 'shared' && routeForNamespaceSection('sellerAcquisition', section) === null,
    )
    expect(unmapped).toEqual([])
  })

  test('an unrecognized namespace/section resolves to null — the ONLY case that does, since Sprint 4', () => {
    expect(routeForNamespaceSection('doesNotExist', 'x')).toBeNull()
    expect(routeForNamespaceSection('sweepstakes', 'doesNotExist')).toBeNull()
  })

  test('NO_SINGLE_PAGE_LABEL is a non-empty es-MX fallback string', () => {
    expect(NO_SINGLE_PAGE_LABEL.length).toBeGreaterThan(0)
  })
})

test.describe('namespaceLabel', () => {
  test('sellerAcquisition gets a distinct "todas las páginas" label (it fans out per-section)', () => {
    expect(namespaceLabel('sellerAcquisition')).toBe('Vende (todas las páginas)')
  })

  test('a simple single-page namespace reuses its route label', () => {
    expect(namespaceLabel('home')).toBe('Inicio')
    expect(namespaceLabel('terms')).toBe('Términos')
  })

  test('an unrecognized namespace falls back to the raw key', () => {
    expect(namespaceLabel('doesNotExist')).toBe('doesNotExist')
  })
})
