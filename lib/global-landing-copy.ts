/**
 * `/en` — the English shop builder, for both markets (epic one-front-door-both-markets D16).
 *
 * Its own copy, not the Mexican anchor's English twin: that twin promises Mercado Pago, SPEI and MXN prices, which
 * are Mexico's money truth. This page belongs to no market yet — the merchant chooses one when the shop becomes
 * theirs (D13) — so every line here is true in BOTH, and the two markets' differences are said in one place
 * («Where you'll sell»), each pointing at its own page. Kept in a module rather than `locales/en.json` because it has
 * no Spanish twin: `/` is the Spanish telling and keeps its own Mexico copy.
 */

export const GLOBAL_LANDING_EN = {
  metadata: {
    title: 'Open your online shop from one sentence — Miyagi Sánchez',
    description:
      'Describe your business, or drop a photo, your product list or your store link. In seconds you have your own shop, ready to take payments in Mexico or the United States, with no commission.',
  },
  eyebrow: 'For sellers in Mexico and the United States',
  heroTitle: 'Describe your business. In seconds you have your online shop, ready to take payments and share — no commission.',
  heroLead: 'Your shop at your own address, payments straight to your own account, and your catalog ready to share. Sell in Mexico or the United States.',
  heroValues: [
    { value: '0%', label: 'platform commission', icon: 'iconoir-percentage' },
    { value: 'AI', label: 'start from a sentence, a photo, a file or your store link', icon: 'iconoir-sparks' },
    { value: '2', label: 'markets: Mexico in pesos, the United States in dollars', icon: 'iconoir-globe' },
  ],
  proofTitle: 'What you get',
  proofLead: 'Everything a small business needs to sell online, set up for you.',
  proofPoints: [
    { title: 'Your shop, at your address', body: 'A free address of your own, and your own domain when you want one.', icon: 'iconoir-home-simple' },
    { title: 'Payments straight to you', body: 'Money goes to your own account. We take no commission on your sales.', icon: 'iconoir-hand-cash' },
    { title: 'A catalog to share', body: 'A link for WhatsApp, a PDF to send or print, and your catalog on Instagram and Facebook.', icon: 'iconoir-share-android' },
    { title: 'A step-by-step guide', body: 'Profile, products, payments, delivery and sharing: you always know what is left before you can sell.', icon: 'iconoir-list' },
    { title: 'Built for AI', body: 'Claude, Gemini and ChatGPT can read your shop, recommend it and help you run it.', icon: 'iconoir-sparks' },
  ],
  whereTitle: "Where you'll sell",
  whereLead: 'You choose when your shop is ready. Each market has its own currency and its own ways to get paid.',
  where: [
    {
      eyebrow: 'Pesos (MXN)',
      title: 'Mexico',
      body: 'Card, bank transfer (SPEI), Mercado Pago or cash on delivery, and national shipping.',
      icon: 'iconoir-map-pin',
      href: '/',
      testId: 'en-where-mx',
    },
    {
      eyebrow: 'US dollars (USD)',
      title: 'United States',
      body: 'Card payments straight into your own Stripe account. Pickup, local delivery or your own carrier.',
      icon: 'iconoir-map-pin',
      href: '/us/sell',
      testId: 'en-where-us',
    },
  ],
  closingTitle: 'Open your shop, and leave if you do not like it.',
  closingBody: 'No contract and no commission. Describe your business and see your shop before you sign up.',
  closingCta: 'Build my shop',
} as const
