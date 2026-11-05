/**
 * The `metadata.kind` every Negocio Stripe checkout and subscription carries. Its own module so pure code (and its
 * specs) can read it without loading the server-only subscription bridge that re-exports it.
 */
export const NEGOCIO_CHECKOUT_KIND = 'negocio'
