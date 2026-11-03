/**
 * The kind of business a merchant runs (business-infrastructure D1, D2) — the ONE enum and every map that hangs off
 * it. Prompt-to-shop's identity call returns a shape; everything downstream (the catalog's listing type, the copy's
 * nouns, which cobros/entregas the keep pre-selects and which the chooser offers) reads it from here and nowhere else.
 *
 * Six shapes, each mapped onto a listing type that ALREADY exists (`IMPORT_LISTING_TYPES`): no new listing type and no
 * new checkout path. A missing or unknown shape is `products`, which is exactly what prompt-to-shop did before shapes
 * existed — an old draft and a model that forgets the field both keep working.
 *
 * Pure: no I/O, no `next/*`.
 */

import type { ImportListingType } from './catalog-import'
import type { CategoryKey } from './types'

export const BUSINESS_SHAPES = ['products', 'services', 'food', 'made_to_order', 'rentals', 'digital'] as const
export type BusinessShape = (typeof BUSINESS_SHAPES)[number]
export const DEFAULT_SHAPE: BusinessShape = 'products'

export function isBusinessShape(value: unknown): value is BusinessShape {
  return typeof value === 'string' && (BUSINESS_SHAPES as readonly string[]).includes(value)
}

/** The shape a stored or generated identity carries, with the documented default. */
export function shapeOf(identity: { shape?: unknown } | null | undefined): BusinessShape {
  return isBusinessShape(identity?.shape) ? identity.shape : DEFAULT_SHAPE
}

export interface ShapeDefaults {
  /** What every generated example row becomes. */
  listingType: ImportListingType
  /** es-MX, for the canvas's "Tipo de negocio" line and its picker. */
  label: string
  /** The noun the canvas uses for one offer and for several ("Producto de ejemplo" → "Servicio de ejemplo"). */
  noun: { one: string; many: string }
  /** Keep pre-selects «Entrega acordada» (`shipping.local_pickup`): the merchant meets the buyer or goes to them. */
  handDelivery: boolean
  /** Whether a parcel service makes sense at all; when false the chooser does not offer Correos. */
  ships: boolean
  /** One line for the model: how this kind of business sells, so the examples look like it. */
  catalogHint: string
  /** The category the deterministic fallback examples use (a real `CATALOG_CATEGORY_KEYS` key; there is no food one). */
  fallbackCategory: CategoryKey
}

export const SHAPE_DEFAULTS: Record<BusinessShape, ShapeDefaults> = {
  products: {
    listingType: 'product',
    label: 'Productos',
    noun: { one: 'producto', many: 'productos' },
    handDelivery: false,
    ships: true,
    catalogHint: 'Vende productos físicos ya hechos o de reventa: cada ejemplo es un producto con su precio.',
    fallbackCategory: 'otros',
  },
  services: {
    listingType: 'service',
    label: 'Servicios',
    noun: { one: 'servicio', many: 'servicios' },
    handDelivery: true,
    ships: false,
    catalogHint:
      'Vende servicios (clases, citas, reparaciones, sesiones): cada ejemplo es un servicio con lo que incluye y su duración en la descripción, y un precio por sesión o por trabajo.',
    fallbackCategory: 'servicios',
  },
  food: {
    listingType: 'product',
    label: 'Comida',
    noun: { one: 'platillo', many: 'platillos' },
    handDelivery: true,
    ships: false,
    catalogHint:
      'Vende comida o bebidas preparadas: cada ejemplo es un platillo, paquete o pedido con su porción en la descripción. Se recoge o se entrega en mano, no se envía por paquetería.',
    fallbackCategory: 'otros',
  },
  made_to_order: {
    listingType: 'product',
    label: 'Sobre pedido',
    noun: { one: 'pieza', many: 'piezas' },
    handDelivery: true,
    ships: true,
    catalogHint:
      'Hace piezas sobre pedido (pasteles, muebles, ropa, artesanía): cada ejemplo es una pieza con su tiempo de elaboración en la descripción y un precio desde.',
    fallbackCategory: 'creatividad',
  },
  rentals: {
    listingType: 'rental',
    label: 'Rentas',
    noun: { one: 'renta', many: 'rentas' },
    handDelivery: true,
    ships: false,
    catalogHint: 'Renta cosas (equipo, mobiliario, inflables, vestidos): cada ejemplo es algo que se renta, con el periodo en la descripción y el precio por periodo.',
    fallbackCategory: 'otros',
  },
  digital: {
    listingType: 'digital',
    label: 'Digital',
    noun: { one: 'producto digital', many: 'productos digitales' },
    handDelivery: false,
    ships: false,
    catalogHint: 'Vende productos digitales (plantillas, cursos, archivos, ebooks): cada ejemplo es un archivo o acceso que se entrega en línea.',
    fallbackCategory: 'creatividad',
  },
}

/**
 * Whether the cobros chooser offers Correos to this shop. A business that sends no parcels is not offered it — unless
 * it is already on, so the merchant can still switch it off where they see it.
 */
export function offersCorreos(shape: BusinessShape, alreadyOn: boolean): boolean {
  return SHAPE_DEFAULTS[shape].ships || alreadyOn
}

/**
 * The shape a re-run («Otra versión») asks for: the merchant's new pick, or else the shape the shop HAS — never
 * nothing. Sending nothing would let the model decide again from the same sentence and quietly undo a correction the
 * merchant already made (and the keep's delivery defaults with it). Review finding on PR #466.
 */
export function rerunShape(picked: string, current: BusinessShape): BusinessShape {
  return isBusinessShape(picked) ? picked : current
}

/** One line per shape for the identity prompt: the model picks the key that fits. */
export function shapeChoicesForPrompt(): string {
  return BUSINESS_SHAPES.map((s) => `"${s}" (${SHAPE_DEFAULTS[s].label.toLowerCase()})`).join(', ')
}
