/**
 * Onboarding three-doors path predicate — pure, next-free.
 *
 * `app/(shell)/layout.tsx` reads this to decide whether to drop the buyer
 * chrome (header / search / cart) for the pre-shop first-run screens (S1
 * Bienvenida, S2 Tres puertas, S3 drop-anything intake), mirroring the
 * existing `isSellerModePath`/`isSellShellCandidatePath` suppression
 * branches. Deliberately a SEPARATE file — this predicate is NOT an
 * extension of either of those (seller-portal-onboarding-three-doors Sprint
 * 1): `isSellerModePath` stays scoped to `/shop/manage`, and
 * `isSellShellCandidatePath`/`sellShellEligible` stay scoped to the
 * owner-aware `/sell`+`/sell/setup` case. This flow is pre-shop (a merchant
 * with no seller yet), so it needed its own additive OR-term rather than
 * folding into either existing gate.
 *
 * Matches only the exact three Sprint-1 onboarding routes — never a prefix,
 * so a future `/sell/onboarding/xyz` addition must extend this set
 * deliberately, not fall in by accident.
 */

// `/sell/bienvenida` and `/sell/puertas` only redirect to `/sell` since prompt-to-shop S3.3. They stay in the set so
// the chrome decision for the one request that hits them does not change; nothing renders there any more.
const ONBOARDING_PATHS = new Set(['/sell/bienvenida', '/sell/puertas', '/sell/agente'])

export function isOnboardingPath(pathname: string): boolean {
  if (!pathname) return false
  return ONBOARDING_PATHS.has(pathname)
}
