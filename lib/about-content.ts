/**
 * Original-authored bilingual (es/en) content for the "about / why-sell" surface — the
 * literal reference values this module was seeded from, still regression-tested here
 * by `e2e/about-content.spec.ts`.
 *
 * Sprint 2 of admin-content-and-announcements (2026-07-08) migrated the LIVE, admin-
 * overridable copy into a new `acerca` namespace in `locales/{es,en}.json` (seeded
 * identically to the values below) — every real render path (the human `/acerca` page,
 * `/agent`, `/api/ucp/manifest`, `/llms.txt`, the MCP `about_miyagi` resource) now reads
 * that dictionary copy through `lib/about-content-overrides.ts`'s
 * `getOverriddenAboutPage()` / `getOverriddenAboutSections()`, NOT the constants below
 * directly — so an admin edit in `/admin/contenido` reaches every one of those surfaces.
 * This module stays a plain, literal, next/*-free data module (so it keeps importing
 * cleanly under the Playwright `api` runner) and is the "author once" origin + the
 * regression-tested defaults; `locales/*.json`'s `acerca` namespace is the "render many,
 * override-able" copy. Keep the two in sync by hand when editing shipped copy in code.
 *
 * Language policy (agent-relay model): es-MX is the canonical source of truth; `en` is a faithful
 * translation and the lingua-franca second locale. We deliberately hold ONLY es + en — the long tail
 * of user languages is covered in Sprint 2 by instructing the reading agent to relay our content in
 * the user's own language. `/acerca` is the one deliberate human page on the bilingual allow-list
 * (AGENTS rule 5) — see `lib/bilingual-namespaces.ts`.
 *
 * Grounding: every section is written from real, verifiable facts — no invented claims. `founder`
 * (the /acerca mobile+content refresh) is grounded from the founder's own CV; no section is a
 * `stub: true` placeholder any more. `pricing` publishes the live custom-subdomain/custom-domain
 * prices.
 *
 * Pure data + tiny accessors. No DB, no Medusa, no Supabase, no `next/*` imports — so the Playwright
 * `api` runner can unit-test it directly.
 */

import { SELLER_LANDING_PATHS } from './seller-acquisition'
import { buildPricingCatalog, fillPricingTokens, type PricingCatalog } from './pricing-catalog'
import { processorRatesFromDataset, type ComparatorDataset } from './cost-comparator-dataset'
import comparatorDataset from './cost-comparator-dataset.json' with { type: 'json' }

export type AboutLocale = 'es' | 'en'

export type AboutSectionId =
  | 'what_is'
  | 'why_sell'
  | 'how_to_start'
  | 'cost_transparency'
  | 'pricing'
  | 'founder'
  | 'philosophy'

export type AboutPoint = {
  title: string
  body: string
  /** Optional Iconoir class, rendered above the point card's title — same
   * treatment as /vende's ProofSection cards (only use a glyph already
   * confirmed present in the loaded Iconoir bundle elsewhere in the app). */
  icon?: string
}

export type AboutCopy = {
  /** Section heading — rendered as a real <h2>. */
  heading: string
  /** Optional one-line lead under the heading. */
  lead?: string
  /** Body paragraphs (real text, agent-fetchable — never image-baked). */
  body: string[]
  /** Optional supporting points / feature list. */
  points?: AboutPoint[]
}

export type AboutSection = {
  id: AboutSectionId
  /** `true` only for the `founder` placeholder, which renders as "próximamente". */
  stub: boolean
  es: AboutCopy
  en: AboutCopy
}

export type AboutPageCopy = {
  eyebrow: string
  title: string
  lead: string
  primaryCtaLabel: string
  secondaryCtaLabel: string
  /** Badge shown on stub sections. */
  stubBadge: string
  /** The pricing section's link to /mx/precios (pricing-page D7). */
  pricingLinkLabel: string
  /** Label for the language-toggle link. */
  langToggleLabel: string
  /**
   * The words around the contact address in the closing CTA.
   *
   * It lives in THIS model — the one `?lang=en` already switches — because it
   * did not, and the English page rendered a Spanish sentence. The address
   * itself is still not copy: it is a fact, and it comes from `lib/contact.ts`
   * so it cannot disagree with the email transport's Reply-To.
   */
  contactPrompt: string
  metaTitle: string
  metaDescription: string
}

/** Canonical ordered list of section ids. */
export const ABOUT_SECTION_IDS: AboutSectionId[] = [
  'what_is',
  'why_sell',
  'how_to_start',
  'cost_transparency',
  'pricing',
  'founder',
  'philosophy',
]

/**
 * CTA target — where the shop builder starts (`/`, since root-shop-builder-home). It was `/sell?from=acerca`, the
 * classifieds publish form: «Abrir mi tienda» must open a SHOP, not post an ad (own-shop-positioning D2).
 */
export const ABOUT_CTA_HREF = '/'
/** Cross-link to the #6 seller-acquisition funnel. */
export const ABOUT_SELLERS_HREF = SELLER_LANDING_PATHS.mx
/** Secondary CTA («Ver precios») — the public price list. */
export const ABOUT_PRICING_HREF = '/mx/precios'

export const ABOUT_PAGE: Record<AboutLocale, AboutPageCopy> = {
  es: {
    eyebrow: 'Acerca de',
    title: '¿Qué es miyagisanchez.com y por qué vender aquí?',
    lead: 'Tu propia tienda en línea, armada contigo y sin comisión por venta. No nos creas: pregúntale a tu propia IA.',
    primaryCtaLabel: 'Abrir mi tienda',
    secondaryCtaLabel: 'Ver precios',
    stubBadge: 'Próximamente',
    pricingLinkLabel: 'Ver todos los precios',
    langToggleLabel: 'English',
    contactPrompt: '¿Dudas? Escríbenos a',
    metaTitle: 'Acerca de miyagisanchez.com — qué es y por qué vender aquí',
    metaDescription:
      'Miyagi Sánchez es tu propia tienda en línea, armada contigo, sin comisión por venta. Qué incluye, cómo empezar y cuánto cuesta.',
  },
  en: {
    eyebrow: 'About',
    title: 'What miyagisanchez.com is — and why sell here',
    lead: 'Your own online shop, built with you, with no commission on sales. Don’t take our word for it — ask your own AI.',
    primaryCtaLabel: 'Open my shop',
    secondaryCtaLabel: 'See prices',
    stubBadge: 'Coming soon',
    pricingLinkLabel: 'See every price',
    langToggleLabel: 'Español',
    contactPrompt: 'Questions? Write to us at',
    metaTitle: 'About miyagisanchez.com — what it is and why sell here',
    metaDescription:
      'Miyagi Sánchez is your own online shop, built with you, with no commission on sales. What it includes, how to start, and what it costs.',
  },
}

const ABOUT_SECTION_TEMPLATES: AboutSection[] = [
  {
    id: 'what_is',
    stub: false,
    es: {
      heading: '¿Qué es miyagisanchez.com?',
      lead: 'Tu tienda con tu dirección, tus cobros y tu catálogo — y tu propio asistente de IA para entenderla, recorrerla y operarla contigo.',
      body: [
        'Miyagi Sánchez es tu propia tienda en línea, armada contigo, sin comisión por venta.',
        'Tú describes tu negocio y la tienda se arma contigo: tu dirección, tus fotos, tus formas de cobro y tu catálogo listo para compartir por WhatsApp e Instagram. El dinero llega directo a tu cuenta.', 'Tus productos también aparecen en el Vecindario de Miyagi Sánchez: una vitrina más para que te encuentren, sin costo extra.', 'Está construida sobre Medusa (el motor de comercio) y cumple los estándares abiertos UCP y MCP, así que un asistente de IA puede leer tu tienda, recomendarla y ayudarte a operarla sin necesidad de un navegador.',
      ],
      points: [
        { title: 'Tu propia tienda', body: 'Con tu dirección, tu marca y el dinero directo a tu cuenta.', icon: 'iconoir-shop-four-tiles' },
        { title: 'Para México', body: 'Pagos y métodos locales: SPEI, efectivo, DiMo, MercadoPago y Stripe.', icon: 'iconoir-map-pin' },
        { title: 'Hecha para la IA', body: 'Tu IA puede leer tu tienda y operarla por ti vía UCP y MCP.', icon: 'iconoir-sparks' },
      ],
    },
    en: {
      heading: 'What is miyagisanchez.com?',
      lead: 'Your shop with your own address, your own payments and your own catalog — and your own AI assistant to understand it, browse it, and run it with you.',
      body: [
        'Miyagi Sánchez is your own online shop, built with you, with no commission on sales.',
        'You describe your business and the shop is built with you: your address, your photos, your ways of getting paid, and a catalog ready to share on WhatsApp and Instagram. The money goes straight to your account.', 'Your products also appear in the Miyagi Sánchez Vecindario (neighborhood): one more window for people to find you, at no extra cost.', 'It is built on Medusa (the commerce engine) and follows the open UCP and MCP standards, so an AI assistant can read your shop, recommend it, and help you run it without needing a browser.',
      ],
      points: [
        { title: 'Your own shop', body: 'With your own address, your brand, and the money going straight to your account.', icon: 'iconoir-shop-four-tiles' },
        { title: 'Built for Mexico', body: 'Local payments and methods: SPEI, cash, DiMo, MercadoPago, and Stripe.', icon: 'iconoir-map-pin' },
        { title: 'Made for AI', body: 'Your AI can read your shop and act on your behalf via UCP and MCP.', icon: 'iconoir-sparks' },
      ],
    },
  },
  {
    id: 'why_sell',
    stub: false,
    es: {
      heading: '¿Por qué vender aquí?',
      lead: 'Sin comisiones, en todos tus canales, y con tu propio asistente de IA haciendo el trabajo pesado.',
      body: [
        'Cobramos 0% de comisión por venta: te quedas con lo que vendes. Empiezas sin pagar y sin tarjeta, y los precios de los planes son públicos.',
        'Tu catálogo vive una sola vez y aparece en muchos lugares: tu tienda, tu propio dominio de marca, un widget que pegas en cualquier sitio, el Vecindario de Miyagi Sánchez, y una API/agente para compras programáticas.',
      ],
      points: [
        { title: '0% de comisión', body: 'No cobramos por venta: lo que vendes es tuyo.', icon: 'iconoir-hand-cash' },
        { title: 'Multicanal', body: 'Tu tienda, dominio propio, widget embebible, Vecindario y API/agentes — un solo catálogo.', icon: 'iconoir-share-android' },
        { title: 'Comercio con IA', body: 'Compradores y agentes pueden explorar y negociar ofertas de forma nativa.', icon: 'iconoir-chat-bubble' },
        { title: 'Migración exprés', body: 'Importa tu catálogo desde un archivo, texto pegado o JSON; la IA lo estructura por ti.', icon: 'iconoir-cloud-upload' },
      ],
    },
    en: {
      heading: 'Why sell here?',
      lead: 'No commission, on every one of your channels, with your own AI assistant doing the heavy lifting.',
      body: [
        'We charge 0% commission per sale: you keep what you sell. You start without paying and without a card, and the plan prices are public.',
        'Your catalog lives once and appears in many places: your shop, your own branded domain, a widget you paste on any site, the Miyagi Sánchez Vecindario, and an API/agent for programmatic purchases.',
      ],
      points: [
        { title: '0% commission', body: 'We don’t charge per sale: what you sell is yours.', icon: 'iconoir-hand-cash' },
        { title: 'Multi-channel', body: 'Your shop, own domain, embeddable widget, Vecindario, and API/agents — one catalog.', icon: 'iconoir-share-android' },
        { title: 'AI commerce', body: 'Buyers and agents can browse and negotiate offers natively.', icon: 'iconoir-chat-bubble' },
        { title: 'Express migration', body: 'Import your catalog from a file, pasted text, or JSON; the AI structures it for you.', icon: 'iconoir-cloud-upload' },
      ],
    },
  },
  {
    id: 'how_to_start',
    stub: false,
    es: {
      heading: 'Cómo empezar',
      lead: 'De cero a tienda con catálogo en minutos — y tu agente puede hacer casi todo.',
      body: [
        'Crea tu cuenta (unos 20 segundos con Google) y entra al onboarding. Importa tu catálogo subiendo un archivo, pegando texto o cargando un JSON: la IA lo interpreta y crea tus productos. Revisas todo en una vista previa antes de que se cree nada, y una guía paso a paso te ayuda a configurar cómo vas a cobrar.',
        '¿Tienes un asistente de IA? Pídele que lea miyagisanchez.com y prepare tu tienda: la imagen de la marca y los productos listos para importar. Tú revisas y publicas.',
      ],
      points: [
        { title: '1. Regístrate', body: 'Unos 20 segundos con Google.' },
        { title: '2. Importa', body: 'Archivo, texto pegado o JSON → la IA estructura tu catálogo.' },
        { title: '3. Publica', body: 'Revisa, ajusta y abre tu tienda.' },
      ],
    },
    en: {
      heading: 'How to start',
      lead: 'From zero to a stocked shop in minutes — and your agent can do almost all of it.',
      body: [
        'Create your account (about 20 seconds with Google) and enter onboarding. Import your catalog by uploading a file, pasting text, or loading a JSON: the AI parses it and creates your products. You review everything in a preview before anything is created, and a step-by-step guide helps you set up how you get paid.',
        'Have an AI assistant? Ask it to read miyagisanchez.com and prepare your shop: the brand dressing and products ready to import. You review and publish.',
      ],
      points: [
        { title: '1. Sign up', body: 'About 20 seconds with Google.' },
        { title: '2. Import', body: 'File, pasted text, or JSON → the AI structures your catalog.' },
        { title: '3. Publish', body: 'Review, tweak, and open your shop.' },
      ],
    },
  },
  {
    id: 'cost_transparency',
    stub: false,
    es: {
      heading: 'Cómo (y por qué) mantenemos los costos bajos',
      lead: 'Tú y tu agente hacen el trabajo creativo; nosotros corremos rieles delgados.',
      body: [
        'Los asistentes de IA de los vendedores hacen gran parte del trabajo: catalogar, redactar, fijar precios y mantener la tienda. Nosotros aportamos los rieles.',
        'Construimos sobre primitivas de Medusa y reutilizamos antes de reconstruir, con superficies para agentes (UCP/MCP) en lugar de herramientas a la medida. Eso mantiene bajo nuestro costo de infraestructura — y por eso podemos cobrar 0% de comisión por venta.',
      ],
    },
    en: {
      heading: 'How (and why) we keep costs low',
      lead: 'You and your agent do the creative work; we run thin rails.',
      body: [
        'Sellers’ AI assistants do much of the work: cataloging, copywriting, pricing, and maintaining the shop. We provide the rails.',
        'We build on Medusa primitives and reuse before rebuilding, with agent surfaces (UCP/MCP) instead of bespoke tooling. That keeps our infrastructure cost low — and that is why we can charge 0% commission per sale.',
      ],
    },
  },
  {
    id: 'pricing',
    stub: false,
    // Prices are `{token}`s filled from the pricing catalog (pricing-page D7) — the same templates
    // as `locales/*.json → acerca.sections.pricing`, which is what the live surfaces render. The
    // hand-typed copy this replaced had already drifted from the locales (`/s/` vs `/mx/s/`).
    es: {
      heading: 'Precios',
      lead: 'Abrir tu tienda no cuesta: empiezas con {trialLength} del Plan Negocio gratis, sin tarjeta y con 0% de comisión. Después hay dos planes, el Plan Tienda y el Plan Negocio, y todos los precios, con IVA incluido, son públicos en miyagisanchez.com/mx/precios.',
      body: [
        'Plan Tienda: {tiendaFrom} ({tiendaYearly} en un solo pago, o {tiendaMonthly}). Tu tienda y su URL en miyagisanchez.com/mx/s/tu-tienda, tu subdominio, 0% de comisión, todos los métodos de pago, tu lugar en el Vecindario, ofertas y mensajes, agentes de IA (UCP/MCP), la IA que arma tu tienda y respuestas de chat cada mes, con un pequeño enlace «Tienda impulsada por Miyagi Sánchez».',
        'Plan Negocio: {negocioMonthly}, o {negocioYearly} (también a meses sin intereses). Suma dominio propio, sincronización con Mercado Libre, tu tienda sin el enlace de la plataforma, más respuestas de chat y más fotos al mes, y el chequeo mensual. Toda tienda nueva empieza con {trialLength} gratis (el dominio propio se activa al contratar).',
        'Cuando terminan tus {trialLength} gratis eliges un plan; si no, tu tienda se pausa sin borrar nada y vuelve en cuanto pagas. Las tiendas que ya existían antes de los planes de pago siguen en el Plan Gratis.',
        'Servicio aparte: migración con consultor, {migrationPrice}.',
        'Tu pasarela de pago (Stripe o Mercado Pago) cobra su propia comisión, no nosotros, y el dinero llega directo a tu cuenta. Todos los precios, con sus fuentes: miyagisanchez.com/mx/precios.',
      ],
    },
    en: {
      heading: 'Pricing',
      lead: 'Opening your shop costs nothing: you start with {trialLength} of the Negocio plan free, with no card and 0% commission. After that there are two plans, the Tienda plan and the Negocio plan, and every price, IVA (VAT) included, is public at miyagisanchez.com/mx/precios.',
      body: [
        'Tienda plan: {tiendaFrom} ({tiendaYearly} in one payment, or {tiendaMonthly}). Your shop and its URL at miyagisanchez.com/mx/s/your-shop, your subdomain, 0% commission, every payment method, your place in the Vecindario, offers and messages, AI agents (UCP/MCP), the AI that builds your shop and chat answers every month, with a small «Shop powered by Miyagi Sánchez» link.',
        'Negocio plan: {negocioMonthly}, or {negocioYearly} (interest-free installments available). It adds your own domain, Mercado Libre sync, your shop without the platform link, more chat answers and more photos a month, and the monthly check-in. Every new shop starts with {trialLength} free (the custom domain turns on when you sign up).',
        'When your {trialLength} free end you choose a plan; if you don\'t, your shop is paused with nothing deleted and comes back as soon as you pay. Shops that existed before the paid plans stay on the Free plan.',
        'A separate service: assisted migration, {migrationPrice}.',
        'Your payment processor (Stripe or Mercado Pago) charges its own fee, not us, and the money goes straight to your account. Every price, with its sources: miyagisanchez.com/mx/precios.',
      ],
    },
  },
  {
    id: 'founder',
    stub: false,
    es: {
      heading: 'Quién está detrás',
      lead: 'Miyagi Sánchez lo construyó una sola persona, con experiencia real dirigiendo comercio a gran escala y levantando negocios propios desde cero.',
      body: [
        'Daniel Vásquez es el fundador. Antes de este proyecto dirigió producto a nivel global en AB InBev, la mayor corporativa de consumo masivo del mundo, liderando un equipo de más de 70 personas y presupuestos de capital por encima de $70M USD. Antes de eso, como gerente senior de producto en Linio, dirigió la integración técnica cuando Falabella adquirió la empresa.',
        'También ha sido fundador dos veces. En Bicimensajero.com construyó él mismo, de cero, toda la arquitectura de software de un servicio de logística bajo demanda, y llegó a operar una red de más de 100 mensajeros en bicicleta antes de negociar su venta. Tiene una maestría en Finanzas — la razón por la que este proyecto está diseñado para operar con costos mínimos, lo que hace posible cobrar 0% de comisión de verdad.',
        'Si quieres platicar del proyecto, escribe a daniel@miyagisanchez.com.',
      ],
      points: [
        { title: '+70 personas', body: 'Equipo de producto e ingeniería dirigido en AB InBev.', icon: 'iconoir-community' },
        { title: '+$70M USD', body: 'Presupuesto de capital gestionado en AB InBev.', icon: 'iconoir-coins' },
        { title: '2 startups fundadas', body: 'Construidas y operadas de cero: Bicimensajero.com y Pokapok.mx.', icon: 'iconoir-shop' },
        { title: 'MSc en Finanzas', body: 'University of Aberdeen, 2024.', icon: 'iconoir-graduation-cap' },
      ],
    },
    en: {
      heading: 'Who is behind this',
      lead: 'Miyagi Sánchez was built by one person, with real experience running large-scale commerce and building businesses from zero.',
      body: [
        'Daniel Vásquez is the founder. Before this project he led product globally at AB InBev, the largest consumer-goods corporation in the world, directing a team of more than 70 people and capital budgets exceeding $70M USD. Before that, as a senior product manager at Linio, he led the technical integration when Falabella acquired the company.',
        'He has also been a founder twice. At Bicimensajero.com he built the entire software architecture of an on-demand logistics service himself, from scratch, and went on to operate a network of more than 100 bike messengers before negotiating its sale. He holds a Master’s in Finance — the reason this project is designed to run on minimal costs, which is what makes a genuine 0% commission possible.',
        'Want to talk about the project? Write to daniel@miyagisanchez.com.',
      ],
      points: [
        { title: '70+ people', body: 'Product and engineering team led at AB InBev.', icon: 'iconoir-community' },
        { title: '$70M+ USD', body: 'Capital budget managed at AB InBev.', icon: 'iconoir-coins' },
        { title: '2 startups founded', body: 'Built and operated from zero: Bicimensajero.com and Pokapok.mx.', icon: 'iconoir-shop' },
        { title: 'MSc in Finance', body: 'University of Aberdeen, 2024.', icon: 'iconoir-graduation-cap' },
      ],
    },
  },
  {
    id: 'philosophy',
    stub: false,
    es: {
      heading: 'Filosofía',
      lead: 'Llevar las mejores prácticas del ecommerce a todos, al más alto nivel y sin comisiones.',
      body: [
        'Creemos que el asistente de IA es el canal de distribución y el motor de onboarding. En lugar de pedirte que confíes en nosotros, te decimos que le preguntes a tu propio Claude, Gemini o ChatGPT sobre miyagisanchez.com: tu agente nos lee, lo explica en tus términos y, si tiene sentido, prepara tu tienda.',
        'Nosotros ponemos los rieles; tú te enfocas en lo creativo y la estrategia. La misión es democratizar las mejores prácticas del comercio — confianza, negociación de ofertas y compra con IA — para que cualquiera venda con la calidad de los grandes, sin comisiones.',
      ],
    },
    en: {
      heading: 'Philosophy',
      lead: 'Bring ecommerce best practices to everyone — at the highest level and with no commission.',
      body: [
        'We believe the AI assistant is the distribution channel and the onboarding engine. Instead of asking you to trust us, we tell you to ask your own Claude, Gemini, or ChatGPT about miyagisanchez.com: your agent reads us, explains it in your terms, and — if it makes sense — sets up your shop.',
        'We provide the rails; you focus on the creative and the strategy. The mission is to democratize commerce best practices — trust, offer negotiation, and AI-native shopping — so anyone can sell at the quality of the giants, with no commission.',
      ],
    },
  },
]

/**
 * Fill the pricing section's `{token}`s from `catalog` (pricing-page D7). Every other section
 * passes through untouched. Pure — the live read path (`about-content-overrides.ts`) calls it
 * with the live catalog; the defaults below use a catalog with no admin prices set.
 */
export function fillAboutSectionsPricing(sections: readonly AboutSection[], catalog: PricingCatalog): AboutSection[] {
  return sections.map((s) => {
    if (s.id !== 'pricing') return s
    const fill = (copy: AboutCopy, locale: AboutLocale): AboutCopy => ({
      ...copy,
      lead: copy.lead == null ? copy.lead : fillPricingTokens(copy.lead, catalog, locale),
      body: copy.body.map((b) => fillPricingTokens(b, catalog, locale)),
    })
    return { ...s, es: fill(s.es, 'es'), en: fill(s.en, 'en') }
  })
}

/** The catalog with no admin price set (print ad / migration read «Precio a cotizar») — the
 * honest default for a module that cannot read the database. */
export const DEFAULT_PRICING_CATALOG: PricingCatalog = buildPricingCatalog({
  migrationPriceMxn: null,
  printAdTiersCents: null,
  processors: processorRatesFromDataset(comparatorDataset as ComparatorDataset),
})

export const ABOUT_SECTIONS: AboutSection[] = fillAboutSectionsPricing(ABOUT_SECTION_TEMPLATES, DEFAULT_PRICING_CATALOG)

/** Look up a section by id. */
export function getAboutSection(id: AboutSectionId): AboutSection {
  const section = ABOUT_SECTIONS.find((s) => s.id === id)
  if (!section) {
    throw new Error(`Unknown about section: ${id}`)
  }
  return section
}

/** Resolve a section's copy for a locale. */
export function aboutCopy(section: AboutSection, locale: AboutLocale): AboutCopy {
  return section[locale]
}
