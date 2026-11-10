/**
 * Promoter Program — the commissionable SKU vocabulary, isolated in a tiny
 * dependency-free module so both lib/promoter.ts (DB + discount) and
 * lib/promoter-commission.ts (accrual) import it WITHOUT importing each other
 * (no ESM initialization cycle). Add a new SKU here (e.g. 'subdomain') in one place.
 */

/** The paid SKUs a promoter can enroll a shop on (S1: custom domain; S2: print ad;
 *  subdomain-pricing S2: subdomain; mercadolibre-sync S5: ml_sync; platform-migrations
 *  S2: migration — a white-glove consultant migration, flat-or-quoted). */
export const PROMOTER_SKUS = [
  'custom_domain', 'print_ad', 'subdomain', 'ml_sync', 'migration',
  // plans-gratis-negocio S4 (D12, D13): the three promoter packages and the year-2 renewal share.
  'negocio_anual', 'negocio_arranque', 'setup_gratis', 'negocio_renewal',
  // plan-tienda-three-free-months S4 (D11–D14): two new packages, the Tienda renewal share and the upgrade share.
  // `negocio_arranque` and `setup_gratis` stay: retired from sale, still read (lib/promoter-packages.ts).
  'tienda_anual', 'negocio_semestral', 'tienda_renewal', 'negocio_upgrade',
] as const
export type PromoterSku = (typeof PROMOTER_SKUS)[number]

export function isPromoterSku(raw: string | null | undefined): raw is PromoterSku {
  return !!raw && (PROMOTER_SKUS as readonly string[]).includes(raw)
}
