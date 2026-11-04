import type { MarketCode, MarketplaceStatus } from './markets'
import type { PublicShopMetadata } from './public-shop-commerce'

export type Shop = {
  id: string
  slug: string
  name: string
  description: string | null
  location: string | null
  logo_url: string | null
  clerk_user_id: string | null
  verified: boolean
  source: string | null
  source_url: string | null
  metadata: PublicShopMetadata | null
  created_at: string
  /** Sanitized public operating-market projection. Raw metadata is not a contract. */
  market_code?: MarketCode
  country_code?: string
  currency_code?: string
  marketplace_status?: MarketplaceStatus
  // Federated commerce — own channel
  custom_domain: string | null
  custom_domain_verified: boolean
  /**
   * Name is legacy (dates from the Vercel-only era) — semantics are now
   * provider-neutral: "the domain provider (Vercel, then Cloudflare from
   * Sprint 4 of frontend-vercel-to-cloudrun) confirmed the domain/hostname is
   * registered." Kept as documented column-reuse rather than a rename/migration
   * — the value was never Vercel-shaped, only the name is a naming legacy, and
   * it has real blast radius (route.ts, domain-lapse-server.ts, seller
   * settings UI, admin tenant directory).
   */
  custom_domain_vercel_ok: boolean
}

export type Listing = {
  id: string
  shop_id: string
  medusa_product_id: string | null
  title: string
  description: string | null
  price_cents: number | null
  currency: string
  condition: 'new' | 'like_new' | 'good' | 'fair' | 'parts' | null
  listing_type: 'product' | 'service' | 'rental' | 'digital' | 'subscription'
  category: string | null
  /** Seller-defined collection handles this listing belongs to (own-shop-premium-presentation S2). */
  collections: string[]
  state: string | null
  municipio: string | null
  location: string | null
  attrs?: Record<string, unknown>
  metadata: Record<string, unknown>
  images: Array<{ url: string; alt?: string }>
  tags: string[]
  status: string
  /** Sellable variants when read from Medusa; >1 means `price_cents` is a «desde» price. */
  variant_count?: number
  source_platform: string | null
  source_url: string | null
  views: number
  /** Whether the variant tracks finite stock (physical products). */
  manage_inventory?: boolean
  /** Available units (stocked − reserved) for managed items; null = unlimited. */
  available_quantity?: number | null
  /** Reserved units (in-flight orders) for managed items; null = unlimited. */
  reserved_quantity?: number | null
  /** False only when a managed item has sold out. Absent ⇒ treat as in stock. */
  in_stock?: boolean
  /** Native Medusa "sobre pedido" flag (catalog-management epic, Sprint 2 · Story 2.1). */
  allow_backorder?: boolean
  /** Seller's estimated dispatch note for a backorder listing (e.g. '1-3d'). */
  dispatch_estimate?: string | null
  created_at: string
  shop?: Shop
}

export type SortOption =
  | 'reciente' | 'precio_asc' | 'precio_desc' | 'popular'
  // Autos-parity sorts (cars-vertical S1.2)
  | 'year_desc' | 'year_asc' | 'marca'

export type SearchParams = {
  q?: string
  category?: string
  state?: string
  municipio?: string
  condition?: string
  listing_type?: string  // product | service | rental | digital | subscription
  min_price?: string
  max_price?: string
  location?: string
  sort?: SortOption
  page?: string
  // Autos filters
  brand?: string
  model?: string
  year_from?: string
  year_to?: string
  km_from?: string
  km_to?: string
  transmission?: string
  fuel?: string
  // Inmuebles filters
  rooms_min?: string
  rooms_max?: string
  surface_min?: string
  surface_max?: string
  property_type?: string  // comma-separated: "casa,departamento"
}

// `icon` is an Iconoir glyph name (composed as `iconoir-${icon}` by renderers).
// All names verified to exist in the Iconoir build loaded in app/layout.tsx
// (handoff/HANDOFF.md §3). `mascotas` is provisional `fish` — Iconoir has no
// paw/dog/cat glyph. Keep these as bare names, never emoji.
export const CATEGORIES = [
  { key: 'autos', label: 'Autos y motos', icon: 'car' },
  { key: 'inmuebles', label: 'Inmuebles', icon: 'home' },
  { key: 'electronica', label: 'Electrónica', icon: 'smartphone-device' },
  { key: 'hogar', label: 'Hogar y jardín', icon: 'sofa' },
  { key: 'moda', label: 'Moda y ropa', icon: 'shirt' },
  { key: 'deportes', label: 'Deportes', icon: 'basketball' },
  { key: 'servicios', label: 'Servicios', icon: 'wrench' },
  { key: 'mascotas', label: 'Mascotas', icon: 'fish' },
  { key: 'herramientas', label: 'Herramientas', icon: 'hammer' },
  { key: 'negocios', label: 'Negocios B2B', icon: 'building' },
  // Digital creator categories
  { key: 'cursos', label: 'Cursos y talleres', icon: 'graduation-cap' },
  { key: 'comunidad', label: 'Membresía / comunidad', icon: 'group' },
  { key: 'creatividad', label: 'Arte y diseño', icon: 'palette' },
  { key: 'otros', label: 'Otros', icon: 'package' },
] as const

export type CategoryKey = typeof CATEGORIES[number]['key']

export const CITIES_BY_STATE: Record<string, readonly string[]> = {
  'Aguascalientes':   ['Aguascalientes', 'Calvillo', 'Jesús María', 'Pabellón de Arteaga', 'Rincón de Romos', 'San Francisco de los Romo', 'Tepezalá'],
  'Baja California':  ['Tijuana', 'Mexicali', 'Ensenada', 'Tecate', 'Playas de Rosarito', 'San Quintín', 'Valle de Mexicali', 'Punta Banderas'],
  'Baja California Sur': ['La Paz', 'San José del Cabo', 'Cabo San Lucas', 'Comondú', 'Loreto', 'Mulegé', 'Santa Rosalía', 'Ciudad Constitución'],
  'Campeche':         ['Campeche', 'Ciudad del Carmen', 'Champotón', 'Escárcega', 'Calkiní', 'Hopelchén', 'Palizada', 'Candelaria'],
  'Chiapas':          ['Tuxtla Gutiérrez', 'San Cristóbal de las Casas', 'Tapachula', 'Comitán', 'Ocosingo', 'Tonalá', 'Palenque', 'Villaflores', 'Arriaga', 'Pichucalco'],
  'Chihuahua':        ['Ciudad Juárez', 'Chihuahua', 'Delicias', 'Cuauhtémoc', 'Hidalgo del Parral', 'Nuevo Casas Grandes', 'Ojinaga', 'Jiménez', 'Camargo', 'Guachochi'],
  'Ciudad de México': ['Álvaro Obregón', 'Azcapotzalco', 'Benito Juárez', 'Coyoacán', 'Cuajimalpa', 'Cuauhtémoc', 'Gustavo A. Madero', 'Iztacalco', 'Iztapalapa', 'La Magdalena Contreras', 'Miguel Hidalgo', 'Milpa Alta', 'Tláhuac', 'Tlalpan', 'Venustiano Carranza', 'Xochimilco'],
  'Coahuila':         ['Saltillo', 'Torreón', 'Monclova', 'Piedras Negras', 'Acuña', 'Frontera', 'San Pedro de las Colonias', 'Ramos Arizpe', 'Múzquiz', 'Sabinas'],
  'Colima':           ['Colima', 'Manzanillo', 'Tecomán', 'Villa de Álvarez', 'Cuauhtémoc', 'Armería', 'Ixtlahuacán', 'Minatitlán'],
  'Durango':          ['Durango', 'Gómez Palacio', 'Lerdo', 'Pueblo Nuevo', 'Vicente Guerrero', 'El Salto', 'Cuencamé', 'Santiago Papasquiaro', 'Tamazula'],
  'Estado de México': ['Ecatepec', 'Toluca', 'Naucalpan', 'Nezahualcóyotl', 'Tlalnepantla', 'Chimalhuacán', 'Tultitlán', 'Nicolás Romero', 'Texcoco', 'Cuautitlán Izcalli', 'Metepec', 'Valle de Chalco', 'Ixtapaluca', 'Chalco', 'Atizapán de Zaragoza', 'Coacalco', 'Huixquilucan'],
  'Guanajuato':       ['León', 'Irapuato', 'Celaya', 'Salamanca', 'Guanajuato', 'Silao', 'San Luis de la Paz', 'Dolores Hidalgo', 'Pénjamo', 'San Miguel de Allende', 'Acámbaro', 'Cortázar'],
  'Guerrero':         ['Acapulco', 'Chilpancingo', 'Zihuatanejo', 'Iguala', 'Taxco', 'Chilapa', 'Coyuca de Catalán', 'Huitzuco', 'Teloloapan'],
  'Hidalgo':          ['Pachuca', 'Tulancingo', 'Tula de Allende', 'Huejutla de Reyes', 'Ixmiquilpan', 'Actopan', 'Apan', 'Tizayuca', 'Tepeapulco'],
  'Jalisco':          ['Guadalajara', 'Zapopan', 'San Pedro Tlaquepaque', 'Tonalá', 'Tlajomulco de Zúñiga', 'Puerto Vallarta', 'Lagos de Moreno', 'San Juan de los Lagos', 'Tepatitlán', 'Ocotlán', 'La Barca', 'Autlán', 'Ameca', 'Sayula', 'Zapotlanejo'],
  'Michoacán':        ['Morelia', 'Uruapan', 'Zamora', 'Lázaro Cárdenas', 'Apatzingán', 'Zitácuaro', 'Pátzcuaro', 'Sahuayo', 'Jacona', 'La Piedad'],
  'Morelos':          ['Cuernavaca', 'Jiutepec', 'Cuautla', 'Temixco', 'Yautepec', 'Emiliano Zapata', 'Jojutla', 'Zacatepec', 'Puente de Ixtla'],
  'Nayarit':          ['Tepic', 'Bahía de Banderas', 'Ixtlán del Río', 'Acaponeta', 'Santiago Ixcuintla', 'Xalisco', 'Compostela', 'El Nayar', 'Tuxpan'],
  'Nuevo León':       ['Monterrey', 'San Nicolás de los Garza', 'Guadalupe', 'San Pedro Garza García', 'Apodaca', 'Santa Catarina', 'Escobedo', 'Juárez', 'Linares', 'Montemorelos', 'Santiago', 'Cadereyta Jiménez'],
  'Oaxaca':           ['Oaxaca', 'Salina Cruz', 'Juchitán de Zaragoza', 'Huatulco', 'Tuxtepec', 'Puerto Escondido', 'Matías Romero', 'Tehuantepec', 'Miahuatlán', 'Pochutla'],
  'Puebla':           ['Puebla', 'Tehuacán', 'San Andrés Cholula', 'Atlixco', 'San Martín Texmelucan', 'Izúcar de Matamoros', 'Huauchinango', 'Chignahuapan', 'Teziutlán', 'Acatzingo'],
  'Querétaro':        ['Querétaro', 'San Juan del Río', 'El Marqués', 'Tequisquiapan', 'Corregidora', 'Cadereyta de Montes', 'Jalpan de Serra', 'Amealco'],
  'Quintana Roo':     ['Cancún', 'Playa del Carmen', 'Chetumal', 'Tulum', 'Cozumel', 'Bacalar', 'Isla Mujeres', 'Puerto Morelos', 'Felipe Carrillo Puerto'],
  'San Luis Potosí':  ['San Luis Potosí', 'Ciudad Valles', 'Matehuala', 'Soledad de Graciano Sánchez', 'Rioverde', 'Tamazunchale', 'Xilitla', 'Tamuín', 'Cedral'],
  'Sinaloa':          ['Culiacán', 'Mazatlán', 'Los Mochis', 'Guasave', 'Guamúchil', 'Navolato', 'El Fuerte', 'Escuinapa', 'Concordia'],
  'Sonora':           ['Hermosillo', 'Ciudad Obregón', 'Nogales', 'Guaymas', 'Navojoa', 'San Luis Río Colorado', 'Caborca', 'Agua Prieta', 'Puerto Peñasco', 'Ures'],
  'Tabasco':          ['Villahermosa', 'Cárdenas', 'Comalcalco', 'Huimanguillo', 'Macuspana', 'Paraíso', 'Balancán', 'Tenosique', 'Jonuta'],
  'Tamaulipas':       ['Reynosa', 'Matamoros', 'Tampico', 'Nuevo Laredo', 'Ciudad Victoria', 'Altamira', 'Ciudad Madero', 'Mante', 'Río Bravo', 'Valle Hermoso'],
  'Tlaxcala':         ['Tlaxcala', 'Apizaco', 'Chiautempan', 'Huamantla', 'Contla de Juan Cuamatzi', 'Calpulalpan', 'Nanacamilpa', 'Zacatelco'],
  'Veracruz':         ['Veracruz', 'Xalapa', 'Coatzacoalcos', 'Córdoba', 'Orizaba', 'Minatitlán', 'Tuxpan', 'Poza Rica', 'Boca del Río', 'Acayucan', 'Papantla', 'San Andrés Tuxtla'],
  'Yucatán':          ['Mérida', 'Valladolid', 'Tizimín', 'Progreso', 'Umán', 'Kanasín', 'Hunucmá', 'Motul', 'Izamal'],
  'Zacatecas':        ['Zacatecas', 'Fresnillo', 'Guadalupe', 'Jerez', 'Calera', 'Loreto', 'Tlaltenango', 'Sombrerete', 'Juchipila'],
}

export const MAJOR_MEXICAN_CITIES = [
  // CDMX
  'Ciudad de México', 'Iztapalapa', 'Gustavo A. Madero', 'Álvaro Obregón', 'Tlalpan', 'Coyoacán',
  // Estado de México
  'Ecatepec', 'Toluca', 'Naucalpan', 'Nezahualcóyotl', 'Tlalnepantla', 'Chimalhuacán',
  'Tultitlán', 'Nicolás Romero', 'Texcoco',
  // Jalisco
  'Guadalajara', 'Zapopan', 'San Pedro Tlaquepaque', 'Tonalá', 'Tlajomulco de Zúñiga', 'Puerto Vallarta',
  // Nuevo León
  'Monterrey', 'San Nicolás de los Garza', 'Guadalupe', 'San Pedro Garza García', 'Apodaca',
  'Santa Catarina', 'Escobedo',
  // Puebla
  'Puebla', 'Tehuacán', 'San Andrés Cholula',
  // Guanajuato
  'León', 'Irapuato', 'Celaya', 'Salamanca', 'Guanajuato',
  // Chihuahua
  'Ciudad Juárez', 'Chihuahua', 'Delicias', 'Cuauhtémoc',
  // Veracruz
  'Veracruz', 'Xalapa', 'Coatzacoalcos', 'Minatitlán', 'Córdoba', 'Orizaba',
  // Tamaulipas
  'Reynosa', 'Matamoros', 'Tampico', 'Nuevo Laredo', 'Ciudad Victoria',
  // Baja California
  'Tijuana', 'Mexicali', 'Ensenada', 'Tecate',
  // Sonora
  'Hermosillo', 'Ciudad Obregón', 'Nogales', 'Guaymas',
  // Coahuila
  'Saltillo', 'Torreón', 'Monclova', 'Piedras Negras',
  // Sinaloa
  'Culiacán', 'Mazatlán', 'Los Mochis',
  // Quintana Roo
  'Cancún', 'Playa del Carmen', 'Chetumal', 'Tulum', 'Cozumel',
  // Michoacán
  'Morelia', 'Uruapan', 'Zamora',
  // Oaxaca
  'Oaxaca', 'Salina Cruz',
  // Guerrero
  'Acapulco', 'Chilpancingo', 'Zihuatanejo',
  // Yucatán
  'Mérida', 'Valladolid',
  // Hidalgo
  'Pachuca', 'Tula',
  // Querétaro
  'Querétaro', 'San Juan del Río',
  // Tabasco
  'Villahermosa', 'Cárdenas',
  // Morelos
  'Cuernavaca', 'Jiutepec', 'Cuautla',
  // Aguascalientes
  'Aguascalientes',
  // Durango
  'Durango', 'Gómez Palacio',
  // Zacatecas
  'Zacatecas', 'Fresnillo',
  // San Luis Potosí
  'San Luis Potosí', 'Ciudad Valles',
  // Chiapas
  'Tuxtla Gutiérrez', 'San Cristóbal de las Casas', 'Tapachula',
  // Nayarit
  'Tepic', 'Bahía de Banderas',
  // Baja California Sur
  'La Paz', 'Los Cabos', 'Cabo San Lucas', 'San José del Cabo',
  // Tlaxcala
  'Tlaxcala',
  // Colima
  'Colima', 'Manzanillo',
  // Campeche
  'Campeche', 'Ciudad del Carmen',
] as const

export const MEXICAN_STATES = [
  'Aguascalientes', 'Baja California', 'Baja California Sur', 'Campeche',
  'Chiapas', 'Chihuahua', 'Ciudad de México', 'Coahuila', 'Colima', 'Durango',
  'Estado de México', 'Guanajuato', 'Guerrero', 'Hidalgo', 'Jalisco',
  'Michoacán', 'Morelos', 'Nayarit', 'Nuevo León', 'Oaxaca', 'Puebla',
  'Querétaro', 'Quintana Roo', 'San Luis Potosí', 'Sinaloa', 'Sonora',
  'Tabasco', 'Tamaulipas', 'Tlaxcala', 'Veracruz', 'Yucatán', 'Zacatecas',
] as const
