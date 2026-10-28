/**
 * Prompt-to-shop — merchant-facing copy for the describe box, the taking-shape screen and the canvas (es-MX only,
 * AGENTS rule 5).
 *
 * One module so `e2e/p2s-copy.spec.ts` can scan every string a merchant reads on screens 1-3 for the words the
 * seed's UX contract bans (the merchant has never heard of a «prompt», a «slug» or a «SKU»). Numbers come from
 * `P2S_LIMITS` via `versionsLeftCopy`, never retyped here (D6).
 */

import { MAX_DESCRIPTION_CHARS } from './constants'

export const DESCRIBE_COPY = {
  label: 'Cuéntanos qué vendes',
  placeholder: 'Por ejemplo: vendo tamales de masa madre en Puebla, por pedido',
  examplesHint: 'O toca un ejemplo',
  examples: [
    { label: 'Tamales', text: 'Vendo tamales de masa madre en Puebla, por pedido' },
    { label: 'Velas', text: 'Hago velas de soya con aromas de la región en Guadalajara y las envío a todo México' },
    { label: 'Ropa', text: 'Vendo ropa de segunda mano en buen estado, tallas S a XL, en la Ciudad de México' },
  ],
  submit: 'Armar mi tienda',
  fileLink: '¿Ya tienes tu catálogo en un archivo?',
  manualLink: 'Armar a mano',
  /** No site key in this environment: the box cannot be verified, so it says so instead of looking broken. */
  unverifiable: 'No pudimos verificar que eres tú. Recarga la página e inténtalo de nuevo.',
} as const

export function characterCounter(length: number): string {
  return `${length}/${MAX_DESCRIPTION_CHARS}`
}

// ── Taking-shape screen (S2.3) ────────────────────────────────────────────────────────────────────────────────
//
// Four narration lines for three blocks: the identity block brings the name AND the colours, so those two lines
// fill together. «Nombre ✓» is the contract's wording.

export const NARRATION = [
  { key: 'identity', label: 'Nombre' },
  { key: 'identity', label: 'Colores' },
  { key: 'words', label: 'Textos' },
  { key: 'catalog', label: 'Productos de ejemplo' },
] as const

export const SHAPING_COPY = {
  title: 'Estamos armando tu tienda',
  working: 'Trabajando…',
  done: 'Listo',
  /** A refusal shows the server's own message; this is only for a stream that died without one. */
  broken: 'Se cortó la conexión mientras armábamos tu tienda. Inténtalo de nuevo.',
  back: 'Volver a mi descripción',
} as const

/** What the merchant should do next when a block fell back to its provisional version. */
export const FALLBACK_NOTE = {
  identity: 'Usamos un nombre provisional; puedes cambiarlo',
  words: 'Usamos textos provisionales; prueba «Otra versión» para otros',
  catalog: 'Usamos productos de ejemplo genéricos; prueba «Otra versión» para otros',
} as const

// ── The canvas (S2.3 renders it empty-then-filling; S2.4 and S2.5 add the controls) ─────────────────────────────

export const CANVAS_COPY = {
  productsTitle: 'Productos',
  exampleNote: 'Son productos de ejemplo para que veas cómo se vería tu tienda. Después los cambias por los tuyos.',
  priceCaption: 'Precio sugerido',
  loading: 'Armando esta parte de tu tienda',
  viewerNote: 'Esta es una vista previa de una tienda en armado. Solo se puede ver.',
} as const

// ── The owner's canvas (S2.4) and the shared link (S2.5) ────────────────────────────────────────────────────────

export const OWNER_COPY = {
  nameLabel: 'Nombre de tu tienda',
  accentLabel: 'Color',
  accentOption: (position: number) => `Usar el color ${position}`,
  saving: 'Guardando…',
  saved: 'Guardado',
  /** Used when a save fails without the server saying why (offline, a proxy error). */
  saveFailed: 'No pudimos guardar ahora. Revisa tu conexión e inténtalo de nuevo.',
  anotherVersion: 'Otra versión',
  toneLabel: 'Tono',
  toneSame: 'El mismo',
  tones: [
    { value: 'cercano', label: 'Cercano' },
    { value: 'formal', label: 'Formal' },
    { value: 'divertido', label: 'Divertido' },
  ],
  share: 'Compartir vista previa',
  shareCopied: 'Enlace copiado',
  shareHint: 'Quien tenga este enlace podrá ver tu tienda, pero no cambiarla.',
  shareManual: 'Copia este enlace',
  verifyNeeded: 'Espera un momento: estamos verificando que eres tú.',
} as const

export const GONE_COPY = {
  title: 'Esta tienda en armado ya no está aquí',
  message: 'Las tiendas en armado se guardan unos días en el teléfono donde se empezaron. Puedes armar una nueva en segundos.',
  action: 'Armar una tienda nueva',
} as const

// ── «Quedármela» — the keep sheet over the canvas (S3.1) ─────────────────────────────────────────────────────────

export const KEEP_COPY = {
  keep: 'Quedármela',
  sheetTitle: (name: string | null) => (name ? `Quédate con ${name}` : 'Quédate con tu tienda'),
  sheetLead: 'Crea tu cuenta con Google o con tu correo. Al terminar, tu tienda ya es tuya.',
  close: 'Cerrar',
  haveAccount: '¿Ya tienes cuenta? Inicia sesión',
  later: '¿Ahora no? Mándame el enlace',
  emailLabel: 'Tu correo',
  emailPlaceholder: 'tucorreo@ejemplo.com',
  send: 'Mandar enlace',
  sending: 'Mandando…',
  mailHint: 'Te mandamos el enlace para volver a tu tienda. Para quedártela, ábrelo en este teléfono.',
  /** Only for a request that died without the server saying why. */
  mailFailed: 'No pudimos mandar el correo ahora. Revisa tu conexión e inténtalo de nuevo.',
  waitShaping: 'Espera a que terminemos de armarla para quedártela.',
} as const

/** The server's answers to «Mándame el enlace». */
export const MAIL_LINK_COPY = {
  invalid: 'Revisa tu correo: parece que le falta algo.',
  limited: 'Ya te mandamos varios enlaces. Inténtalo de nuevo en un rato.',
  gone: 'Esta tienda en armado ya no está en este teléfono.',
  failed: 'No pudimos mandar el correo ahora. Inténtalo de nuevo.',
  sent: 'Listo. Revisa tu correo.',
} as const

// ── Keeping it: the claim and the owner's first look (S3.2, /sell/armar) ─────────────────────────────────────────

/** Transient failures. Each says what is safe: nothing is lost, and trying again resumes where it stopped. */
export const CLAIM_RETRY = {
  lookup: 'No pudimos revisar tu cuenta ahora. Inténtalo de nuevo en un momento.',
  shop: 'No pudimos crear tu tienda ahora. Inténtalo de nuevo: tu tienda sigue guardada.',
  config: 'Tu tienda ya existe, pero no pudimos ponerle tus colores y textos. Inténtalo de nuevo.',
  save: 'Tu tienda ya existe, pero no pudimos terminar de guardarla. Inténtalo de nuevo.',
  draft: 'No pudimos abrir tu tienda en armado ahora. Inténtalo de nuevo en un momento.',
} as const

export const ARMAR_COPY = {
  metaTitle: 'Tu tienda',
  working: 'Guardando tu tienda…',
  keptTitle: (name: string | null) => (name ? `¡Listo! ${name} ya es tuya` : '¡Listo! Tu tienda ya es tuya'),
  keptLead: 'Ya tiene nombre, colores y textos. Los productos de ejemplo siguen aquí para guiarte: cámbialos por los tuyos.',
  address: 'Tu dirección',
  manage: 'Ir a mi panel',
  viewShop: 'Ver mi tienda',
  otherPhoneTitle: 'Esta tienda se armó en otro teléfono',
  otherPhoneLead: 'Para quedártela, ábrela en el teléfono donde la armaste. O arma una nueva aquí en segundos.',
  startNew: 'Armar una tienda nueva',
  hasShopTitle: 'Ya tienes una tienda',
  hasShopLead: 'Tu cuenta ya tiene una tienda, así que no la cambiamos por esta. Puedes seguir con la tuya.',
  incompleteTitle: 'Tu tienda todavía se está armando',
  incompleteLead: 'Espera a que tenga nombre y colores, y vuelve a tocar «Quedármela».',
  backToShop: 'Volver a mi tienda',
  retry: 'Intentar de nuevo',
  /** Only for a request that died without the server saying why. */
  failed: 'Se cortó la conexión mientras guardábamos tu tienda. Inténtalo de nuevo.',
} as const
