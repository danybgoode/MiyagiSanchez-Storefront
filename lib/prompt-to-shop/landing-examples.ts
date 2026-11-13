/**
 * The describe box's example chips, per landing page (epic one-front-door-both-markets S3.1).
 *
 * A merchant who arrived on the food page should tap «Tamales», not «Muebles»: the chips are the fastest proof that
 * the box is for THEM. Keyed by the page's `pageId`; a page with no entry shows the general set from `copy.ts`.
 * Each text is a whole description a merchant could send as is.
 */

export type LandingExample = { label: string; text: string }

export const LANDING_EXAMPLES: Readonly<Record<string, readonly LandingExample[]>> = {
  creadores: [
    { label: 'Ilustración', text: 'Hago ilustraciones y prints de edición limitada, y los envío a todo México' },
    { label: 'Música', text: 'Vendo mis discos, playeras de la banda y boletos para nuestros conciertos' },
    { label: 'Cursos', text: 'Doy clases de fotografía en línea y vendo mis presets para editar' },
  ],
  negocios: [
    { label: 'Tienda de ropa', text: 'Tengo una tienda de ropa para dama en Guadalajara y quiero vender en línea' },
    { label: 'Papelería', text: 'Tengo una papelería en Puebla con útiles escolares, regalos y copias' },
    { label: 'Abarrotes', text: 'Tengo una tienda de abarrotes y quiero recibir pedidos por WhatsApp para entregar en la colonia' },
  ],
  servicios: [
    { label: 'Belleza', text: 'Soy estilista: cortes, tintes y peinados para eventos, con cita en mi estética de Monterrey' },
    { label: 'Clases', text: 'Doy clases particulares de matemáticas e inglés en línea y a domicilio' },
    { label: 'Reparaciones', text: 'Reparo celulares y computadoras en la Ciudad de México, con diagnóstico gratis' },
  ],
  autos: [
    { label: 'Seminuevos', text: 'Vendo autos seminuevos con garantía en Querétaro, con crédito y a cuenta' },
    { label: 'Refacciones', text: 'Vendo refacciones y accesorios para autos japoneses, con envío a todo México' },
    { label: 'Taller', text: 'Tengo un taller mecánico: afinaciones, frenos y suspensión, con cita' },
  ],
  migracion: [
    { label: 'Desde Shopify', text: 'Ya vendo en Shopify ropa deportiva y quiero mi tienda aquí sin comisión' },
    { label: 'Desde Mercado Libre', text: 'Vendo artículos de cocina en Mercado Libre y quiero mi propia tienda' },
  ],
  mundial: [
    { label: 'Playeras', text: 'Vendo playeras y jerseys de la selección para el Mundial, tallas de niño y adulto' },
    { label: 'Botanas', text: 'Preparo botanas y pedidos para ver los partidos, con entrega a domicilio' },
  ],
  comida: [
    { label: 'Tamales', text: 'Vendo tamales de masa madre en Puebla, por pedido' },
    { label: 'Postres', text: 'Hago pasteles y postres por pedido para fiestas, con entrega en la colonia' },
    { label: 'Comida corrida', text: 'Tengo una cocina económica con menú del día y entregas en la oficina' },
  ],
  bazar: [
    { label: 'Ropa de segunda', text: 'Vendo ropa de segunda mano en buen estado, tallas S a XL' },
    { label: 'Antigüedades', text: 'Vendo antigüedades, discos de vinilo y objetos de colección' },
  ],
  inmuebles: [
    { label: 'Renta', text: 'Rento departamentos amueblados por mes en Mérida' },
    { label: 'Venta', text: 'Vendo casas y terrenos en Querétaro, con visita agendada' },
  ],
  imprentas: [
    { label: 'Impresión', text: 'Tengo una imprenta: tarjetas, lonas, volantes y etiquetas, con entrega en 48 horas' },
    { label: 'Playeras', text: 'Estampo playeras y sudaderas personalizadas desde una pieza' },
  ],
  plomeria: [
    { label: 'Plomería', text: 'Soy plomero en Puebla: fugas, destapes y calentadores, servicio a domicilio' },
    { label: 'Electricista', text: 'Hago instalaciones eléctricas y reparaciones en casas y negocios' },
  ],
  'vestidos-de-novia': [
    { label: 'Novias', text: 'Hago vestidos de novia a la medida, con pruebas en mi taller de Guadalajara' },
    { label: 'XV años', text: 'Vendo y rento vestidos de XV años y de fiesta' },
  ],
  'materiales-e-interiorismo': [
    { label: 'Pisos', text: 'Vendo pisos, azulejos y recubrimientos, con asesoría e instalación' },
    { label: 'Interiorismo', text: 'Diseño interiores y fabrico muebles a la medida para casas y oficinas' },
  ],
  'ropa-interior-mayoreo': [
    { label: 'Mayoreo', text: 'Vendo ropa interior al mayoreo para tiendas, con envíos a todo México' },
    { label: 'Lencería', text: 'Vendo lencería y pijamas al menudeo y mayoreo' },
  ],
  us: [
    { label: 'Bakery', text: 'I bake sourdough bread and pastries in Austin, pickup on weekends' },
    { label: 'Candles', text: 'I hand-pour soy candles and ship nationwide' },
    { label: 'Services', text: 'I do house cleaning and organizing in Phoenix, by appointment' },
  ],
  'us-vende': [
    { label: 'Panadería', text: 'Hago pan dulce y pasteles en Houston, con entrega local' },
    { label: 'Comida', text: 'Vendo tamales y comida mexicana por pedido en Los Ángeles' },
    { label: 'Servicios', text: 'Hago limpieza de casas y oficinas en Chicago, con cita' },
  ],
}

/** Pages that recruit promoters or operators, not merchants: they carry no shop builder. */
export const NO_BUILDER_PAGES: ReadonlySet<string> = new Set(['promotor', 'us-operators'])
