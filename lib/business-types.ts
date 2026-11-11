/**
 * One page per business type (own-shop-positioning S3.1, D6).
 *
 * A promoter standing in front of a print shop, a bridal boutique or a plumber needs ONE link that speaks to that
 * business. Ten pages live at `/mx/vende/<slug>`:
 *   - `autos` and `servicios` already existed as persona pages (their copy stays in `locales/es.json`; `autos` got a
 *     rewrite). Here they only gain the demo shop and the proof slot, so all ten look and work alike;
 *   - the other eight (`inmuebles`, `comida`, `imprentas`, `vestidos-de-novia`, `plomeria`, `ropa-interior-mayoreo`,
 *     `materiales-e-interiorismo`, `bazar`) are written here and rendered by the single `[tipo]` route from this data.
 *
 * Rules this file keeps:
 *   - NO real merchant is named and no real shop's words are used. Every demo shop is invented, says «ejemplo» on its
 *     face, and carries no price — a typed MXN figure would be a hand-typed price (`e2e/pricing-source-sweep.spec.ts`).
 *   - A page claims only what the app does today: buyer-entered personalization with artwork upload, priced options and
 *     quantity tiers, offers, appointment booking for services, the catalog link/PDF/Meta feed, the shop chat.
 *   - `BUSINESS_PROOF` is EMPTY on purpose. A real shop appears there only with its written consent; until then the
 *     proof slot renders nothing (Daniel, 2026-11-11).
 *
 * Pure data, no `next/*` imports, so the Playwright `api` runner can load it. es-MX only (these are the `/mx/vende`
 * family, like `/mx/precios`).
 */

export const BUSINESS_TYPE_SLUGS = [
  'inmuebles',
  'servicios',
  'comida',
  'autos',
  'imprentas',
  'vestidos-de-novia',
  'plomeria',
  'ropa-interior-mayoreo',
  'materiales-e-interiorismo',
  'bazar',
] as const

export type BusinessTypeSlug = (typeof BUSINESS_TYPE_SLUGS)[number]

/** The slugs this file writes in full. `autos` and `servicios` keep their copy in the dictionary. */
export const NEW_BUSINESS_TYPE_SLUGS = [
  'inmuebles',
  'comida',
  'imprentas',
  'vestidos-de-novia',
  'plomeria',
  'ropa-interior-mayoreo',
  'materiales-e-interiorismo',
  'bazar',
] as const satisfies readonly BusinessTypeSlug[]

export type NewBusinessTypeSlug = (typeof NEW_BUSINESS_TYPE_SLUGS)[number]

export function isNewBusinessTypeSlug(slug: string): slug is NewBusinessTypeSlug {
  return (NEW_BUSINESS_TYPE_SLUGS as readonly string[]).includes(slug)
}

export function isBusinessTypeSlug(slug: string): slug is BusinessTypeSlug {
  return (BUSINESS_TYPE_SLUGS as readonly string[]).includes(slug)
}

export function businessTypePath(slug: BusinessTypeSlug): string {
  return `/mx/vende/${slug}`
}

// ── The demo shop ────────────────────────────────────────────────────────────

export type DemoShopItem = { name: string; note: string }

export type DemoShop = {
  name: string
  tagline: string
  items: DemoShopItem[]
}

/** What every demo shop says about itself, so no visitor can take it for a real business. */
export const DEMO_SHOP_COPY = {
  badge: 'Ejemplo',
  title: 'Así se ve una tienda como la tuya',
  disclaimer: 'Es una tienda de ejemplo, inventada para mostrarte cómo se vería. No es un negocio real.',
} as const

export const DEMO_SHOPS: Record<BusinessTypeSlug, DemoShop> = {
  inmuebles: {
    name: 'Inmobiliaria Ejemplo',
    tagline: 'Rentas y ventas en tu colonia',
    items: [
      { name: 'Departamento de 2 recámaras', note: 'Renta · fotos y ubicación' },
      { name: 'Casa con jardín', note: 'Venta · recibe ofertas' },
      { name: 'Local comercial en esquina', note: 'Renta · pregunta por mensaje' },
      { name: 'Terreno para construir', note: 'Venta · datos del predio' },
    ],
  },
  servicios: {
    name: 'Consultorio Ejemplo',
    tagline: 'Sesiones y paquetes con cita',
    items: [
      { name: 'Primera consulta', note: 'Reserva en el horario que te quede' },
      { name: 'Sesión de seguimiento', note: 'Con tu cita confirmada' },
      { name: 'Paquete de cuatro sesiones', note: 'Un solo cobro, tú eliges las fechas' },
      { name: 'Consulta a domicilio', note: 'Dime dónde y a qué hora' },
    ],
  },
  comida: {
    name: 'Fonda Ejemplo',
    tagline: 'Comida casera, pide y recoge',
    items: [
      { name: 'Comida corrida del día', note: 'Elige tu guisado' },
      { name: 'Tacos de guisado', note: 'Por orden · con extras' },
      { name: 'Aguas frescas', note: 'Chica o grande' },
      { name: 'Pastel por encargo', note: 'Pídelo con tu mensaje' },
    ],
  },
  autos: {
    name: 'Autos Ejemplo',
    tagline: 'Seminuevos con ficha completa',
    items: [
      { name: 'Sedán compacto', note: 'Ficha técnica e inspección' },
      { name: 'Camioneta familiar', note: 'Con historial verificado' },
      { name: 'Auto económico de ciudad', note: 'Financiamiento a la vista' },
      { name: 'Pick-up de trabajo', note: 'Recibe ofertas' },
    ],
  },
  imprentas: {
    name: 'Imprenta Ejemplo',
    tagline: 'Impresos listos para tu negocio',
    items: [
      { name: 'Tarjetas de presentación', note: 'Tu cliente sube su diseño' },
      { name: 'Volantes y folletos', note: 'Tamaño y cantidad a tu medida' },
      { name: 'Lonas y viniles', note: 'Medidas y acabado a elegir' },
      { name: 'Sellos personalizados', note: 'Con el texto que pide tu cliente' },
    ],
  },
  'vestidos-de-novia': {
    name: 'Boutique Nupcial Ejemplo',
    tagline: 'Vestidos y accesorios para tu día',
    items: [
      { name: 'Vestido corte sirena', note: 'Agenda tu cita de prueba' },
      { name: 'Vestido de línea A', note: 'Tallas y medidas en la ficha' },
      { name: 'Velo y accesorios', note: 'Combínalo con tu vestido' },
      { name: 'Ajustes a la medida', note: 'Reserva tu cita' },
    ],
  },
  plomeria: {
    name: 'Plomería Ejemplo',
    tagline: 'Plomería y baños, con cita',
    items: [
      { name: 'Reparación de fugas', note: 'Agenda tu visita' },
      { name: 'Destape de drenajes', note: 'Dinos qué pasa' },
      { name: 'Instalación de baño completo', note: 'Visita de revisión primero' },
      { name: 'Mantenimiento de calentador', note: 'Con cita en tu horario' },
    ],
  },
  'ropa-interior-mayoreo': {
    name: 'Mayoreo Íntimo Ejemplo',
    tagline: 'Ropa interior por paquete',
    items: [
      { name: 'Bóxer de algodón', note: 'Mejor precio entre más piezas' },
      { name: 'Pantaleta tipo bikini', note: 'Por paquete, en tallas surtidas' },
      { name: 'Brasier sin varilla', note: 'Elige tallas y colores' },
      { name: 'Calcetas básicas', note: 'Por docena' },
    ],
  },
  'materiales-e-interiorismo': {
    name: 'Materiales y Diseño Ejemplo',
    tagline: 'Acabados para tu obra',
    items: [
      { name: 'Pisos de cerámica', note: 'Por caja, con medidas' },
      { name: 'Pintura para interiores', note: 'Elige color y cubeta' },
      { name: 'Cocinas integrales', note: 'Pide tu cotización por mensaje' },
      { name: 'Muebles a medida', note: 'Cuéntanos tu espacio' },
    ],
  },
  bazar: {
    name: 'Bazar Ejemplo',
    tagline: 'Piezas únicas hechas a mano',
    items: [
      { name: 'Jarrón de barro pintado', note: 'Pieza única' },
      { name: 'Rebozo tejido a mano', note: 'Pocas piezas, con su historia' },
      { name: 'Aretes de plata', note: 'Hechos por encargo' },
      { name: 'Cuadro bordado', note: 'Recibe ofertas' },
    ],
  },
}

// ── The index cards on `/` ───────────────────────────────────────────────────

export const BUSINESS_TYPE_CARDS: Record<BusinessTypeSlug, { title: string; body: string; icon: string }> = {
  inmuebles: { title: 'Inmuebles', body: 'Rentas y ventas con ficha, ofertas y una liga para WhatsApp.', icon: 'iconoir-home' },
  servicios: { title: 'Servicios con cita', body: 'Consultas, sesiones y paquetes que se reservan en línea.', icon: 'iconoir-calendar' },
  comida: { title: 'Comida', body: 'Tu menú con opciones y pedidos directos, sin comisión.', icon: 'iconoir-shop' },
  autos: { title: 'Autos', body: 'Lote, agencia o venta particular, con ficha técnica e inspección.', icon: 'iconoir-car' },
  imprentas: { title: 'Imprentas', body: 'Tu cliente elige, sube su diseño y paga.', icon: 'iconoir-upload' },
  'vestidos-de-novia': { title: 'Vestidos de novia', body: 'Vitrina de tus vestidos y citas de prueba.', icon: 'iconoir-media-image' },
  plomeria: { title: 'Plomería y baños', body: 'Tus servicios con citas de visita y cobro directo.', icon: 'iconoir-wrench' },
  'ropa-interior-mayoreo': { title: 'Ropa interior por mayoreo', body: 'Paquetes, tallas surtidas y precio por cantidad.', icon: 'iconoir-list' },
  'materiales-e-interiorismo': { title: 'Materiales e interiorismo', body: 'Catálogo grande y cotizaciones por mensaje.', icon: 'iconoir-view-grid' },
  bazar: { title: 'Bazar y artesanos', body: 'Piezas únicas con su historia y ofertas.', icon: 'iconoir-gift' },
}

// ── The proof slot ───────────────────────────────────────────────────────────

/** A real shop that agreed, in writing, to be shown. */
export type RealShopProof = {
  /** The shop's public name, exactly as it asked to be shown. */
  shopName: string
  /** The shop's public address on Miyagi Sánchez, e.g. `/mx/s/<slug>`. */
  href: string
  /** One sentence, in the shop's own words, that the shop approved. */
  quote?: string
}

/**
 * Real-shop proof per business type. EMPTY until a shop consents in writing — and a slot with nothing in it renders
 * NOTHING (no heading, no placeholder, no «próximamente»): an empty promise on a sales page is worse than silence.
 */
export const BUSINESS_PROOF: Partial<Record<BusinessTypeSlug, readonly RealShopProof[]>> = {}

export function businessProofFor(
  slug: BusinessTypeSlug,
  source: Partial<Record<BusinessTypeSlug, readonly RealShopProof[]>> = BUSINESS_PROOF,
): readonly RealShopProof[] {
  return source[slug] ?? []
}

export const BUSINESS_PROOF_COPY = {
  title: 'Negocios como el tuyo ya venden aquí',
} as const

// ── The eight written pages ──────────────────────────────────────────────────

export type BusinessTypePoint = { icon: string; title: string; body: string }

export type BusinessTypePage = {
  slug: NewBusinessTypeSlug
  eyebrow: string
  metaTitle: string
  metaDescription: string
  ogAlt: string
  /** Three short tags printed on the share card. */
  ogTags: [string, string, string]
  heroTitle: string
  heroLead: string
  heroStats: [{ value: string; label: string }, { value: string; label: string }, { value: string; label: string }]
  proofTitle: string
  proofLead: string
  proofPoints: BusinessTypePoint[]
  closingTitle: string
  closingBody: string
}

/** Copy every business-type page shares: the steps are the same flow whatever the business sells. */
export const BUSINESS_TYPE_COMMON = {
  primaryCta: 'Abrir mi tienda',
  secondaryCta: 'Ver cuánto cuesta',
  closingCta: 'Abrir mi tienda',
  stepsTitle: 'Así se arma tu tienda',
  steps: [
    { title: 'Cuéntanos qué vendes', body: 'En una frase o con tus fotos. En segundos ves tu tienda tomar forma.' },
    { title: 'Ajusta lo tuyo', body: 'Tu nombre, tus productos, tus precios y cómo quieres cobrar. Nada se publica sin que lo revises.' },
    { title: 'Compártela', body: 'Manda tu liga por WhatsApp o tu catálogo en PDF, y cobra directo a tu cuenta.' },
  ],
  trustLine: (url: string) =>
    `Compruébalo tú mismo: pídele a tu IA que evalúe ${url} y te diga si te conviene.`,
} as const

export const BUSINESS_TYPE_PAGES: Record<NewBusinessTypeSlug, BusinessTypePage> = {
  inmuebles: {
    slug: 'inmuebles',
    eyebrow: 'Para inmobiliarias y dueños directos',
    metaTitle: 'Tienda en línea para rentar y vender inmuebles, sin comisión — Miyagi Sánchez',
    metaDescription:
      'Tus propiedades en una tienda propia: fichas con fotos y ubicación, ofertas de los interesados y una liga para mandar por WhatsApp. 0% de comisión.',
    ogAlt: 'Miyagi Sánchez para inmuebles: tus propiedades en una tienda propia, con ofertas y 0% de comisión.',
    ogTags: ['Fichas con fotos', 'Ofertas', '0% comisión'],
    heroTitle: 'Tus propiedades en una tienda propia, no perdidas entre cientos de anuncios.',
    heroLead:
      'Rentas y ventas con fotos, ubicación y tus condiciones, en una dirección que es tuya. Los interesados te escriben o te mandan su oferta, y tú decides.',
    heroStats: [
      { value: '0%', label: 'comisión por rentar o vender' },
      { value: '1 liga', label: 'con todas tus propiedades, para WhatsApp' },
      { value: 'Ofertas', label: 'los interesados proponen y tú respondes' },
    ],
    proofTitle: 'Lo que tu inmobiliaria se lleva',
    proofLead: 'Una vitrina propia para cada propiedad, sin pagar por cada anuncio ni compartir tus contactos con nadie.',
    proofPoints: [
      { icon: 'iconoir-home', title: 'Cada propiedad, con su ficha', body: 'Fotos, precio o renta, ubicación y lo que incluye, en una ficha que se ve bien en el celular.' },
      { icon: 'iconoir-share-android', title: 'Una liga con todo', body: 'Un link de catálogo para mandar por WhatsApp, o un PDF para imprimir y llevar a la visita.' },
      { icon: 'iconoir-hand-cash', title: 'Ofertas sin vueltas', body: 'Quien quiere rentar o comprar te manda su oferta; aceptas, contraofertas o rechazas, o dejas reglas que respondan por ti.' },
      { icon: 'iconoir-shop', title: 'Tu propia dirección', body: 'Tu tienda con tu nombre y, con el Plan Negocio, con tu propio dominio.' },
    ],
    closingTitle: 'Pon tus propiedades donde tú las mandas.',
    closingBody: 'Cuéntanos qué rentas o vendes y mira tu tienda en segundos. Es tuya, con 0% de comisión.',
  },
  comida: {
    slug: 'comida',
    eyebrow: 'Para fondas, cocinas y negocios de comida',
    metaTitle: 'Tienda en línea para negocios de comida, sin comisión — Miyagi Sánchez',
    metaDescription:
      'Tu menú en una tienda propia: platillos con opciones y extras, pedidos directos y cobro en tu cuenta. Una liga para WhatsApp. 0% de comisión.',
    ogAlt: 'Miyagi Sánchez para comida: tu menú en una tienda propia, con pedidos directos y 0% de comisión.',
    ogTags: ['Tu menú', 'Pedidos directos', '0% comisión'],
    heroTitle: 'Tu menú en una tienda propia, sin que una app se quede con tu comisión.',
    heroLead:
      'Platillos con sus opciones y extras, pedidos que te llegan directo y un link para mandar por WhatsApp. Tú cobras como te acomode y entregas o te recogen.',
    heroStats: [
      { value: '0%', label: 'comisión por pedido' },
      { value: 'Tu menú', label: 'con tamaños, extras y opciones' },
      { value: 'Directo', label: 'el dinero llega a tu cuenta' },
    ],
    proofTitle: 'Lo que tu cocina se lleva',
    proofLead: 'Un lugar propio para tu menú, en el que tus clientes piden sin intermediarios.',
    proofPoints: [
      { icon: 'iconoir-shop', title: 'Un menú que se arma solo', body: 'Cada platillo con sus tamaños, extras y precio por opción. Describe tu menú y la tienda lo ordena; tú lo revisas.' },
      { icon: 'iconoir-share-android', title: 'Tu liga para WhatsApp', body: 'Manda tu catálogo en un link o en PDF a tus clientes de siempre, y que ellos pidan desde ahí.' },
      { icon: 'iconoir-credit-card', title: 'Cobras como prefieras', body: 'Tarjeta, transferencia o efectivo, según lo que actives. El dinero llega directo a tu cuenta.' },
      { icon: 'iconoir-chat-bubble', title: 'Un chat que contesta por ti', body: 'Contesta lo que ya publicaste, como tu horario o dónde entregas, y te deja los mensajes que no supo responder.' },
    ],
    closingTitle: 'Que pidan directo contigo.',
    closingBody: 'Cuéntanos qué cocinas y mira tu menú en línea en segundos. Es tuyo, sin comisión por pedido.',
  },
  imprentas: {
    slug: 'imprentas',
    eyebrow: 'Para imprentas y papelerías',
    metaTitle: 'Tienda en línea para imprentas, con diseños de tus clientes — Miyagi Sánchez',
    metaDescription:
      'Vende impresos en línea: tu cliente elige tamaño y cantidad, sube su diseño y paga. Opciones, precios por cantidad y 0% de comisión.',
    ogAlt: 'Miyagi Sánchez para imprentas: tu cliente elige, sube su diseño y paga. 0% de comisión.',
    ogTags: ['Sube su diseño', 'Precio por cantidad', '0% comisión'],
    heroTitle: 'Que tu cliente elija, suba su diseño y pague sin escribirte cinco veces.',
    heroLead:
      'Tarjetas, volantes, lonas, sellos: cada producto con sus tamaños, acabados y precio por cantidad. Tu cliente sube su archivo y tú recibes el pedido completo.',
    heroStats: [
      { value: '0%', label: 'comisión por pedido' },
      { value: 'Su diseño', label: 'png, jpg, pdf, ai o svg' },
      { value: 'Por cantidad', label: 'precio según cuántas piezas' },
    ],
    proofTitle: 'Lo que tu imprenta se lleva',
    proofLead: 'El pedido llega con todo lo que necesitas para imprimirlo, y sin la ida y vuelta de mensajes.',
    proofPoints: [
      { icon: 'iconoir-upload', title: 'El diseño llega con el pedido', body: 'Tu cliente sube su archivo (png, jpg, pdf, ai o svg) al comprar, y escribe el texto que lleva su sello o su tarjeta.' },
      { icon: 'iconoir-list', title: 'Tamaños, acabados y cantidades', body: 'Cada producto con sus opciones y su precio por cantidad: entre más piezas, mejor precio, sin que tú lo calcules.' },
      { icon: 'iconoir-share-android', title: 'Tu catálogo para mandar', body: 'Un link y un PDF con todo lo que imprimes, para tus clientes de siempre y para quien te llega por WhatsApp.' },
      { icon: 'iconoir-percentage', title: 'Cobras directo, sin comisión', body: 'El dinero llega a tu cuenta. Tu pasarela cobra lo suyo; nosotros no tomamos nada por venta.' },
    ],
    closingTitle: 'Menos mensajes, más pedidos listos para imprimir.',
    closingBody: 'Cuéntanos qué imprimes y mira tu tienda en segundos. Es tuya, con 0% de comisión.',
  },
  'vestidos-de-novia': {
    slug: 'vestidos-de-novia',
    eyebrow: 'Para boutiques de novias y vestidos',
    metaTitle: 'Tienda en línea para vestidos de novia y eventos, sin comisión — Miyagi Sánchez',
    metaDescription:
      'Muestra tus vestidos como merecen, agenda citas de prueba y recibe apartados en línea. Tu propia tienda, con 0% de comisión.',
    ogAlt: 'Miyagi Sánchez para vestidos de novia: vitrina propia, citas de prueba y 0% de comisión.',
    ogTags: ['Citas de prueba', 'Apartados', '0% comisión'],
    heroTitle: 'Tu boutique, con la vitrina que tus vestidos merecen y las citas de prueba en orden.',
    heroLead:
      'Fotos grandes, tallas y medidas en cada ficha, y una agenda para que la novia reserve su prueba. Tú atiendes a quien sí viene.',
    heroStats: [
      { value: '0%', label: 'comisión por venta' },
      { value: 'Citas', label: 'la novia reserva su prueba' },
      { value: 'A medida', label: 'tallas y medidas en cada ficha' },
    ],
    proofTitle: 'Lo que tu boutique se lleva',
    proofLead: 'Una tienda que se siente como entrar a tu local, y menos tiempo contestando lo mismo.',
    proofPoints: [
      { icon: 'iconoir-media-image', title: 'Una ficha que presume el vestido', body: 'Varias fotos, descripción, tallas y lo que incluye. Se ve bien en el celular, donde la novia lo mira.' },
      { icon: 'iconoir-calendar', title: 'Citas de prueba con agenda', body: 'La novia reserva el horario que te quede, con tu agenda de citas, y tú dejas de coordinar por mensajes.' },
      { icon: 'iconoir-edit-pencil', title: 'Medidas y detalles del pedido', body: 'Pide las medidas y las notas que necesitas al comprar, para que el pedido llegue completo.' },
      { icon: 'iconoir-hand-cash', title: 'Apartados y ofertas', body: 'Cobras directo a tu cuenta y, si quieres, dejas que te propongan precio y tú respondes.' },
    ],
    closingTitle: 'Que la novia llegue a la prueba ya enamorada del vestido.',
    closingBody: 'Cuéntanos qué vendes y mira tu boutique en línea en segundos. Es tuya, con 0% de comisión.',
  },
  plomeria: {
    slug: 'plomeria',
    eyebrow: 'Para plomeros y servicios para el baño',
    metaTitle: 'Tienda en línea para plomería y baños, con citas — Miyagi Sánchez',
    metaDescription:
      'Tus servicios de plomería y baños en una página propia: lo que haces, citas para tu visita y cobro directo. 0% de comisión.',
    ogAlt: 'Miyagi Sánchez para plomería y baños: tus servicios con citas y 0% de comisión.',
    ogTags: ['Citas de visita', 'Cobro directo', '0% comisión'],
    heroTitle: 'Que te encuentren, te agenden y te paguen, sin contestar llamadas a toda hora.',
    heroLead:
      'Tus servicios de plomería y baños en una página propia, con lo que haces, lo que cubre cada uno y un calendario para que el cliente reserve su visita.',
    heroStats: [
      { value: '0%', label: 'comisión por servicio' },
      { value: 'Citas', label: 'el cliente agenda su visita' },
      { value: 'Directo', label: 'cobras a tu cuenta' },
    ],
    proofTitle: 'Lo que tu negocio se lleva',
    proofLead: 'Una cara profesional para tu oficio, sin tener que armar una página web.',
    proofPoints: [
      { icon: 'iconoir-wrench', title: 'Cada servicio, bien explicado', body: 'Fugas, drenajes, instalaciones, calentadores: lo que haces, lo que incluye y desde cuánto, en lenguaje que se entiende.' },
      { icon: 'iconoir-calendar', title: 'Citas en tu horario', body: 'El cliente reserva el día y la hora que tienes libres; tú llegas con la visita ya acordada.' },
      { icon: 'iconoir-share-android', title: 'Tu liga para dar en cada trabajo', body: 'Una dirección con tu nombre para mandar por WhatsApp, imprimir en una tarjeta o pegar en tu camioneta.' },
      { icon: 'iconoir-sparks', title: 'Tu agente de IA ayuda', body: 'Le preguntas cómo va tu tienda o le pides que cambie un precio, sin abrir ningún panel.' },
    ],
    closingTitle: 'Que el siguiente cliente te agende en lugar de llamar.',
    closingBody: 'Cuéntanos qué haces y mira tu página en segundos. Es tuya, con 0% de comisión.',
  },
  'ropa-interior-mayoreo': {
    slug: 'ropa-interior-mayoreo',
    eyebrow: 'Para mayoristas de ropa interior',
    metaTitle: 'Tienda en línea para ropa interior por mayoreo, sin comisión — Miyagi Sánchez',
    metaDescription:
      'Vende ropa interior por paquete: tallas y colores surtidos, precio por cantidad y pedidos directos de tus clientes. 0% de comisión.',
    ogAlt: 'Miyagi Sánchez para ropa interior por mayoreo: precio por cantidad y 0% de comisión.',
    ogTags: ['Precio por cantidad', 'Tallas y colores', '0% comisión'],
    heroTitle: 'Tu mayoreo en línea, con el precio que baja entre más piezas se llevan.',
    heroLead:
      'Tallas y colores surtidos, paquetes y escalas de precio por cantidad, en un catálogo que tus clientes de mostrador ven cuando quieren y piden sin esperar tu respuesta.',
    heroStats: [
      { value: '0%', label: 'comisión por pedido' },
      { value: 'Por cantidad', label: 'escalas de precio por piezas' },
      { value: 'Surtido', label: 'tallas y colores en cada ficha' },
    ],
    proofTitle: 'Lo que tu mayoreo se lleva',
    proofLead: 'Un catálogo que trabaja mientras tú atiendes el mostrador.',
    proofPoints: [
      { icon: 'iconoir-list', title: 'Precio por cantidad', body: 'Fijas tus escalas (media docena, docena, caja) y la tienda muestra el precio que le toca al pedido.' },
      { icon: 'iconoir-view-grid', title: 'Tallas y colores, ordenados', body: 'Cada producto con sus variantes, para que el cliente arme su pedido sin preguntarte qué hay.' },
      { icon: 'iconoir-cloud-upload', title: 'Importa tu catálogo de una vez', body: 'Sube un archivo o pega tu lista y la tienda arma los productos; tú los revisas antes de que se cree nada.' },
      { icon: 'iconoir-share-android', title: 'Catálogo en PDF y por WhatsApp', body: 'Manda tu catálogo completo a tus clientes de siempre, siempre actualizado.' },
    ],
    closingTitle: 'Que tus clientes pidan por su cuenta y tú surtas.',
    closingBody: 'Cuéntanos qué vendes por mayoreo y mira tu catálogo en línea en segundos. Es tuyo, con 0% de comisión.',
  },
  'materiales-e-interiorismo': {
    slug: 'materiales-e-interiorismo',
    eyebrow: 'Para materiales, acabados e interiorismo',
    metaTitle: 'Tienda en línea para materiales e interiorismo, sin comisión — Miyagi Sánchez',
    metaDescription:
      'Tu catálogo de materiales y acabados en una tienda propia: productos con medidas y opciones, cotizaciones por mensaje y 0% de comisión.',
    ogAlt: 'Miyagi Sánchez para materiales e interiorismo: catálogo propio, cotizaciones y 0% de comisión.',
    ogTags: ['Catálogo grande', 'Cotiza por mensaje', '0% comisión'],
    heroTitle: 'Tu catálogo de materiales y acabados, completo y a la mano de quien va a construir.',
    heroLead:
      'Pisos, pinturas, cocinas, muebles a medida: cada producto con sus medidas y opciones, y un mensaje directo para cotizar lo que no tiene precio de lista.',
    heroStats: [
      { value: '0%', label: 'comisión por venta' },
      { value: 'Catálogo', label: 'grande, ordenado en colecciones' },
      { value: 'Cotiza', label: 'por mensaje, sin salir de tu tienda' },
    ],
    proofTitle: 'Lo que tu negocio se lleva',
    proofLead: 'Un catálogo que no necesita que estés para mostrar lo que tienes.',
    proofPoints: [
      { icon: 'iconoir-cloud-upload', title: 'Sube tu catálogo de una vez', body: 'Con un archivo o una lista pegada, la tienda arma los productos. Revisas todo antes de que se cree nada.' },
      { icon: 'iconoir-view-grid', title: 'Colecciones que se explican solas', body: 'Pisos, pinturas, cocinas, muebles: agrupa tus productos para que el cliente llegue directo a lo que busca.' },
      { icon: 'iconoir-chat-bubble', title: 'Cotiza por mensaje', body: 'Lo que no tiene precio de lista se cotiza hablando con el cliente dentro de tu tienda, y ahí queda guardado.' },
      { icon: 'iconoir-hand-cash', title: 'Ofertas para pedidos grandes', body: 'Quien compra volumen te manda su oferta; tú respondes o dejas reglas que respondan por ti.' },
    ],
    closingTitle: 'Que tu catálogo trabaje cuando tú estás en la obra.',
    closingBody: 'Cuéntanos qué vendes y mira tu tienda en segundos. Es tuya, con 0% de comisión.',
  },
  bazar: {
    slug: 'bazar',
    eyebrow: 'Para bazares, artesanas y artesanos',
    metaTitle: 'Tienda en línea para bazares y artesanos, sin comisión — Miyagi Sánchez',
    metaDescription:
      'Vende tus piezas únicas con su historia: tienda propia, ofertas de quien las quiere y una liga para compartir. 0% de comisión.',
    ogAlt: 'Miyagi Sánchez para bazares y artesanos: piezas únicas con su historia y 0% de comisión.',
    ogTags: ['Piezas únicas', 'Tu historia', '0% comisión'],
    heroTitle: 'Tus piezas únicas, con su historia, en una tienda que también es tuya.',
    heroLead:
      'Cada pieza con sus fotos y de qué está hecha, y ofertas de quien la quiere. Lo que vendes en el bazar, ahora también cuando no estás ahí.',
    heroStats: [
      { value: '0%', label: 'comisión por pieza' },
      { value: 'Única', label: 'cada pieza con su ficha y su historia' },
      { value: 'Tu marca', label: 'tu nombre y tu estilo, no el de otro' },
    ],
    proofTitle: 'Lo que tu taller se lleva',
    proofLead: 'Una vitrina propia para lo que haces, sin competir por un lugar entre mil publicaciones iguales.',
    proofPoints: [
      { icon: 'iconoir-media-image', title: 'Cada pieza, con su historia', body: 'Fotos, de qué está hecha y cómo se hizo. Quien la mira entiende por qué vale lo que vale.' },
      { icon: 'iconoir-hand-cash', title: 'Ofertas de quien la quiere', body: 'Quien se enamora de una pieza te manda su oferta; aceptas, contraofertas o dejas reglas.' },
      { icon: 'iconoir-instagram', title: 'Tu catálogo para Instagram y WhatsApp', body: 'Un link, un PDF y el catálogo de Meta para que lo que subes aquí llegue a donde ya te siguen.' },
      { icon: 'iconoir-gift', title: 'Sorteos para tus fechas fuertes', body: 'Arma un sorteo para el Buen Fin o la Navidad y haz crecer tu audiencia.' },
    ],
    closingTitle: 'Que tus piezas se vendan también cuando el bazar cierra.',
    closingBody: 'Cuéntanos qué haces y mira tu tienda en segundos. Es tuya, con 0% de comisión.',
  },
}
