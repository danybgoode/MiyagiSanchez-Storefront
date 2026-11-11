/**
 * The six things a Miyagi Sánchez shop already does and merchants rarely see — said once, in our own words
 * (own-shop-positioning S2.1).
 *
 * ONE source, four readers:
 *   - `/` (the shop-builder landing, formerly `/mx/vende`) renders them as six story cards, each linking to the real
 *     feature (`featureStoriesSection` in the page config);
 *   - `lib/about-content.ts` builds the `features` about-section from them, so `/acerca`, `/agent`, `llms.txt`, the
 *     UCP manifest and the MCP `about_miyagi` resource all repeat them;
 *   - `/mx/precios` shows the short «Qué incluye tu tienda» list (title + tagline + link).
 *   - `locales/{es,en}.json → acerca.sections.features` is the admin-overridable mirror of the about-section;
 *     `e2e/shop-features.spec.ts` fails if it drifts from this file.
 *
 * Grounding rules (a claim that is not true is the one failure copy cannot afford):
 *   - every sentence names something the app does today. The AI story is bounded by what the merchant's own agent can
 *     really call over MCP: `about_miyagi`, `compare_costs`, `send_feedback` plus the listing, offer, plan and
 *     settings tools (`MCP_BUYER_TOOLS` / `MCP_SELLER_TOOLS`);
 *   - NO peso figure is typed here. Prices come from `lib/pricing-catalog.ts` and live on `/mx/precios`; a spec fails on
 *     a hand-typed MXN amount.
 *
 * Pure data, no `next/*` imports, so the Playwright `api` runner can load it.
 */

export type ShopFeatureId = 'omnichannel' | 'finanzas' | 'ofertas' | 'ia' | 'sorteos' | 'en-linea'

export type ShopFeatureLink = { label: string; href: string }

export type ShopFeatureCopy = {
  title: string
  /** One line — what the merchant gets. Used by the short list on /mx/precios and as the card's lead. */
  tagline: string
  /** The story itself, in the merchant's words. */
  body: string
}

export type ShopFeature = {
  id: ShopFeatureId
  icon: string
  /** The real feature pages — `/shop/manage/*` sends a signed-out visitor to sign in, then lands on the page. */
  links: ShopFeatureLink[]
  es: ShopFeatureCopy
  en: ShopFeatureCopy
}

export const SHOP_FEATURES: readonly ShopFeature[] = [
  {
    id: 'omnichannel',
    icon: 'iconoir-share-android',
    links: [{ label: 'Ver tus canales', href: '/shop/manage/canal-propio' }],
    es: {
      title: 'Un inventario para cada mostrador',
      tagline: 'Cargas tus productos una vez y salen a todos los lugares donde vendes.',
      body:
        'Subes tus productos una sola vez. De ahí salen tu tienda con tu propia dirección, el link de catálogo para WhatsApp, un PDF para mandar o imprimir, el catálogo de Meta para Instagram y Facebook, el Vecindario de Miyagi Sánchez, Mercado Libre (con el Plan Negocio) y el mostrador de tu local, para cobrar en persona desde tu celular. Un solo catálogo, sin copiar y pegar en cada lado.',
    },
    en: {
      title: 'One inventory for every counter',
      tagline: 'Load your products once and they reach every place you sell.',
      body:
        'You upload your products once. From there they feed your shop at your own address, the catalog link for WhatsApp, a PDF to send or print, the Meta catalog for Instagram and Facebook, the Miyagi Sánchez Vecindario, Mercado Libre (with the Negocio plan), and the counter at your store, to take payment in person from your phone. One catalog, no copying and pasting into each one.',
    },
  },
  {
    id: 'finanzas',
    icon: 'iconoir-stats-report',
    links: [
      { label: 'Abrir Tu plan', href: '/shop/manage/plan' },
      { label: 'Ver Analíticas', href: '/shop/manage/analytics' },
    ],
    es: {
      title: 'Cuánto ganas, no sólo cuánto vendes',
      tagline: 'Tu plan, tus analíticas y tus ganancias en un solo lugar, con sus números a la vista.',
      body:
        'Tu plan junta los números de tu negocio y te dice de dónde salió cada uno; lo que no pudo leer, lo dice en vez de poner un cero. Analíticas te muestra cómo se mueve tu tienda. Y Ganancias descuenta lo que te cuesta cada producto, para que veas tu margen real y no solo el total vendido.',
    },
    en: {
      title: 'What you earn, not just what you sell',
      tagline: 'Your plan, your analytics and your profit in one place, with every number in view.',
      body:
        'Your plan gathers your business numbers and tells you where each one came from; what it could not read, it says so instead of showing a zero. Analytics shows how your shop is moving. And Profit subtracts what each product costs you, so you see your real margin and not just the total sold.',
    },
  },
  {
    id: 'ofertas',
    icon: 'iconoir-hand-cash',
    links: [{ label: 'Ver tus ofertas', href: '/shop/manage/offers' }],
    es: {
      title: 'Regatea sin perder la tarde',
      tagline: 'Tus compradores te hacen ofertas; tú respondes o dejas reglas que responden por ti.',
      body:
        'Tus compradores te mandan ofertas y contraofertas desde la ficha del producto, sin salirse a un chat. Tú respondes cuando puedas, o fijas reglas: aceptar solas las ofertas buenas, contraofertar a un porcentaje que tú elijas y rechazar las que no te convienen. También puedes pedir que solo ofrezcan compradores con cierto nivel de confianza.',
    },
    en: {
      title: 'Haggle without losing your afternoon',
      tagline: 'Buyers make you offers; you answer, or set rules that answer for you.',
      body:
        'Buyers send you offers and counteroffers from the product page, without leaving for a chat. You answer when you can, or set rules: accept good offers automatically, counter at a percentage you choose, and turn down the ones that do not work for you. You can also require buyers to have a certain level of trust before they can offer.',
    },
  },
  {
    id: 'ia',
    icon: 'iconoir-sparks',
    links: [
      { label: 'Importar tu catálogo', href: '/shop/manage/import' },
      { label: 'Conectar tu agente', href: '/shop/manage/settings' },
    ],
    es: {
      title: 'IA que trabaja para tu tienda',
      tagline: 'Un chat que contesta a tus compradores, una importación que arma tu catálogo y tu propio agente.',
      body:
        'El chat de tu tienda contesta a tus compradores con lo que tú publicaste (envíos, pagos, devoluciones y tus productos con su precio); si no sabe, deja el mensaje en tus Preguntas en vez de inventar. Importar convierte un archivo, un texto pegado o un JSON en productos, y tú los revisas antes de que se cree nada. Y puedes conectar tu propio Claude, ChatGPT o Gemini a tu tienda con tu dirección personal, en los ajustes: pídele que publique un producto, cambie un precio, responda una oferta, te diga cómo va tu plan o cuánto pagarías en otra plataforma.',
    },
    en: {
      title: 'AI that works for your shop',
      tagline: 'A chat that answers your buyers, an import that builds your catalog, and your own agent.',
      body:
        'Your shop’s chat answers buyers using what you published (shipping, payments, returns, and your products with their price); if it does not know, it leaves the message in your Questions instead of making something up. Import turns a file, pasted text or a JSON into products, and you review them before anything is created. And you can connect your own Claude, ChatGPT or Gemini to your shop with your personal address, in settings: ask it to publish a product, change a price, answer an offer, tell you how your plan is going, or what you would pay on another platform.',
    },
  },
  {
    id: 'sorteos',
    icon: 'iconoir-gift',
    links: [{ label: 'Armar un sorteo', href: '/shop/manage/sweepstakes' }],
    es: {
      title: 'Un sorteo para el Buen Fin y la Navidad',
      tagline: 'Arma tu sorteo desde tu tienda y haz crecer tu audiencia en las fechas fuertes.',
      body:
        'Arma un sorteo desde tu tienda para el Buen Fin o la Navidad. Cada participante confirma su correo con un código, tú haces el sorteo cuando termina y la tienda le avisa por correo a quien gana. Sin pagar otra herramienta aparte.',
    },
    en: {
      title: 'A giveaway for Buen Fin and Christmas',
      tagline: 'Set up your giveaway from your shop and grow your audience in the busy weeks.',
      body:
        'Set up a giveaway from your shop for Buen Fin or Christmas. Each participant confirms their email with a code, you run the draw when it ends, and the shop emails the winner. No separate tool to pay for.',
    },
  },
  {
    id: 'en-linea',
    icon: 'iconoir-map-pin',
    links: [{ label: 'Describir mi negocio', href: '/' }],
    es: {
      title: 'Pon tu negocio en línea',
      tagline: 'Si hoy solo estás en Google Maps, en una frase tienes tu tienda.',
      body:
        'Si hoy tu negocio solo existe en Google Maps o en un grupo de WhatsApp, empieza con una frase: describe qué vendes y en segundos ves tu tienda con nombre, textos y productos de ejemplo. No necesitas cuenta para verla. Si te gusta, es tuya, con tu propia dirección y tu dinero directo a tu cuenta.',
    },
    en: {
      title: 'Put your business online',
      tagline: 'If today you are only on Google Maps, one sentence gets you a shop.',
      body:
        'If today your business only exists on Google Maps or in a WhatsApp group, start with one sentence: describe what you sell and in seconds you see your shop with a name, text and sample products. You do not need an account to look. If you like it, it is yours, with your own address and your money straight to your account.',
    },
  },
]

export const SHOP_FEATURE_IDS: ShopFeatureId[] = SHOP_FEATURES.map((f) => f.id)

/** The about-section heading + lead, es / en. Kept beside the stories so one file is the whole claim. */
export const SHOP_FEATURES_HEADING = {
  es: {
    heading: 'Lo que tu tienda ya hace',
    lead: 'Seis cosas que vienen con tu tienda y que casi nadie ve a primera vista.',
    intro: 'Todo esto ya está en tu tienda; cada historia lleva a la página donde lo usas.',
  },
  en: {
    heading: 'What your shop already does',
    lead: 'Six things that come with your shop and that almost nobody sees at first glance.',
    intro: 'All of this is already in your shop; each story points to the page where you use it.',
  },
} as const

/** The short list on `/mx/precios`: what a plan's price already includes, one line each, linked to the feature. */
export const SHOP_INCLUDES_HEADING = {
  title: 'Qué incluye tu tienda',
  lead: 'Seis cosas que ya hace tu tienda, sin herramientas aparte.',
} as const
