/**
 * Prompt-to-shop — the English copy (epic one-front-door-both-markets D11). Same shapes as `copy.ts`, checked by
 * `satisfies`, so a key added in Spanish and forgotten here is a type error rather than a blank line on `/en`.
 */

import {
  ARMAR_COPY, CANVAS_COPY, CHECKLIST_COPY, CHECKLIST_LABELS, CLAIM_RETRY, COBROS_COPY, DESCRIBE_COPY, FALLBACK_NOTE, GONE_COPY, KEEP_COPY,
  MAIL_LINK_COPY, NARRATION, NUDGE_COPY, NUDGE_STEP_COPY, NUMBERS_COPY, OWNER_COPY, PHOTO_COPY, PUBLISH_COPY, SEED_COPY, SHAPING_COPY,
} from './copy'
import type { BlockKey } from './blocks'
import { SHAPE_DEFAULTS, type BusinessShape } from '../business-shape'
import type { P2sLocale } from './locale'

export type Widen<T> = T extends string ? string : T extends number ? number : T extends readonly (infer U)[] ? readonly Widen<U>[] : T extends (...a: infer A) => infer R ? (...a: A) => R : T extends object ? { [K in keyof T]: Widen<T[K]> } : T

export const DESCRIBE_COPY_EN = {
  label: 'Tell us what you sell',
  placeholder: 'For example: I make sourdough bread in Austin, pickup on weekends',
  rotatingExamples: [
    'I bake custom birthday cakes in Houston, with local delivery',
    'I make sterling silver jewelry by hand and ship across the US',
    'I run a sneaker and streetwear resale shop in Brooklyn',
    'I roast specialty coffee in Portland and sell it by the bag',
    'I build custom hardwood furniture to order in Denver',
    'I sell Korean skincare and makeup in Los Angeles, with same-day delivery',
    'I teach online Spanish lessons for kids and adults',
    'I sell dog treats, toys and beds for small breeds in Phoenix',
    'I make small-batch hot sauce and ship it nationwide',
  ],
  examplesHint: 'Or tap an example',
  examples: [
    { label: 'Bakery', text: 'I bake sourdough bread and pastries in Austin, pickup on weekends' },
    { label: 'Candles', text: 'I hand-pour soy candles with local scents in Asheville and ship nationwide' },
    { label: 'Clothing', text: 'I sell vintage clothing in great condition, sizes S to XL, in Chicago' },
    { label: 'Jewelry', text: 'I make silver and beaded earrings and necklaces by hand and ship across the US' },
    { label: 'Cakes', text: 'I make custom cakes and decorated cookies to order for birthdays and weddings in Houston' },
    { label: 'Beauty', text: 'I sell skincare, cosmetics and perfume in Miami, with local delivery' },
    { label: 'Crafts', text: 'I sell handmade pottery, woven textiles and painted folk art' },
    { label: 'Furniture', text: 'I build solid-wood furniture to order for living and dining rooms in Denver' },
    { label: 'Pets', text: 'I sell beds, leashes and natural treats for dogs and cats, with delivery in Phoenix' },
    { label: 'Coffee', text: 'I roast specialty coffee and sell it whole bean or ground, in 12 oz and 2 lb bags' },
  ],
  submit: 'Build my shop',
  fileLink: 'Already have your catalog in a file?',
  manualLink: 'Build it by hand',
  unverifiable: "We couldn't verify it's you. Reload the page and try again.",
  startWith: 'Or start with what you already have',
  photo: 'A photo',
  file: 'Your list in Excel or PDF',
  link: "Your store's link",
  linkLabel: "Your store's or page's address",
  linkPlaceholder: 'yourstore.myshopify.com',
  linkSubmit: 'Read',
  reading: 'Reading…',
  waitVerify: 'One moment, verifying…',
  seeded: (n: number, source: string | null) =>
    `${n === 1 ? 'One product' : `${n} products`}${source ? ` from ${source}` : ''}. They go into your shop once it's yours.`,
  seededPhoto: 'Your photo will be the first product in your shop.',
  remove: 'Remove',
  failed: "We couldn't read it. Try again or describe your business in a sentence.",
} satisfies Widen<typeof DESCRIBE_COPY>

export const NARRATION_EN: ReadonlyArray<{ key: BlockKey; label: string }> = [
  { key: 'identity', label: 'Name' },
  { key: 'identity', label: 'Colors' },
  { key: 'words', label: 'Text' },
  { key: 'catalog', label: 'Sample products' },
  { key: 'numbers', label: 'Your numbers' },
]

export const SHAPING_COPY_EN = {
  title: "We're building your shop",
  working: 'Working…',
  done: 'Done',
  broken: 'The connection dropped while we were building your shop. Please try again.',
  back: 'Back to my description',
} satisfies Widen<typeof SHAPING_COPY>

export const FALLBACK_NOTE_EN = {
  identity: 'We used a temporary name; you can change it',
  words: 'We used temporary text; try «Another version» for different wording',
  catalog: 'We used generic sample products; try «Another version» for different ones',
  numbers: "We haven't estimated your numbers yet; you can fill them in once the shop is yours",
} satisfies Widen<typeof FALLBACK_NOTE>

export const CANVAS_COPY_EN = {
  productsTitle: 'Products',
  exampleNote: "These are sample products so you can see how your shop could look. You'll swap them for your own.",
  priceCaption: 'Suggested price',
  loading: 'Building this part of your shop',
  viewerNote: 'This is a preview of a shop in progress. View only.',
} satisfies Widen<typeof CANVAS_COPY>

export const OWNER_COPY_EN = {
  nameLabel: 'Your shop name',
  accentLabel: 'Color',
  accentOption: (position: number) => `Use color ${position}`,
  saving: 'Saving…',
  saved: 'Saved',
  saveFailed: "We couldn't save right now. Check your connection and try again.",
  anotherVersion: 'Another version',
  toneLabel: 'Tone',
  toneSame: 'The same',
  tones: [
    { value: 'cercano', label: 'Friendly' },
    { value: 'formal', label: 'Formal' },
    { value: 'divertido', label: 'Playful' },
  ],
  shapeLabel: 'Type of business',
  shapeSame: (label: string) => `${label} (current)`,
  shapeHint: "If that's not your type of business, pick another and ask for another version: the shop is built for that type.",
  share: 'Share preview',
  shareCopied: 'Link copied',
  shareHint: 'Anyone with this link can see your shop, but not change it.',
  shareManual: 'Copy this link',
  verifyNeeded: "Hold on a moment: we're verifying it's you.",
} satisfies Widen<typeof OWNER_COPY>

export const GONE_COPY_EN = {
  title: 'This shop in progress is no longer here',
  message: 'Shops in progress are kept for a few days on the phone where they were started. You can build a new one in seconds.',
  action: 'Build a new shop',
} satisfies Widen<typeof GONE_COPY>

export const KEEP_COPY_EN = {
  keep: 'Keep it',
  sheetTitle: (name: string | null) => (name ? `Keep ${name}` : 'Keep your shop'),
  sheetLead: 'Create your account with Google or your email. When you finish, your shop is yours.',
  close: 'Close',
  haveAccount: 'Already have an account? Sign in',
  later: 'Not now? Email me the link',
  emailLabel: 'Your email',
  emailPlaceholder: 'you@example.com',
  send: 'Send link',
  sending: 'Sending…',
  mailHint: 'We emailed you a link back to your shop. To keep it, open the link on this phone.',
  mailFailed: "We couldn't send the email right now. Check your connection and try again.",
  waitShaping: "Wait until we finish building it, then you can keep it.",
} satisfies Widen<typeof KEEP_COPY>

export const MAIL_LINK_COPY_EN = {
  invalid: 'Check your email address: something seems to be missing.',
  limited: "We've already sent you several links. Try again in a while.",
  gone: 'This shop in progress is no longer on this phone.',
  failed: "We couldn't send the email right now. Please try again.",
  sent: 'Done. Check your email.',
} satisfies Widen<typeof MAIL_LINK_COPY>

export const CLAIM_RETRY_EN = {
  lookup: "We couldn't check your account right now. Try again in a moment.",
  shop: "We couldn't create your shop right now. Try again: your shop is still saved.",
  draft: "We couldn't open your shop in progress right now. Try again in a moment.",
} satisfies Widen<typeof CLAIM_RETRY>

export const SEED_COPY_EN = {
  title: (n: number) => (n === 1 ? 'Your product is ready to upload' : `Your ${n} products are ready to upload`),
  lead: "We brought them in from your photo, your list or your previous store. Upload them to your shop and review them in your dashboard before you sell.",
  run: (n: number) => (n === 1 ? 'Upload my product' : `Upload my ${n} products`),
  busy: 'Uploading…',
  again: 'Upload again',
  done: (created: number, failed: number) =>
    failed ? `We uploaded ${created}; ${failed} could not be uploaded. Check them in your dashboard, under Products.` : `Done: we uploaded ${created} to your shop.`,
  failed: "We couldn't upload them right now. Try again in a moment.",
} satisfies Widen<typeof SEED_COPY>

export const ARMAR_COPY_EN = {
  marketTitle: 'Where will you sell?',
  marketLead: "Your shop takes payments in its country's currency. Choose one; this can't be changed later.",
  marketMx: 'Mexico',
  marketMxBody: 'You get paid in pesos: card, SPEI bank transfer, Mercado Pago or cash, with national shipping.',
  marketUs: 'United States',
  marketUsBody: 'You get paid in dollars through your own Stripe account. Pickup, local delivery or your own carrier.',
  marketNote: 'To sell in both countries, open a second shop.',
  marketConfirm: 'Keep my shop',
  metaTitle: 'Your shop',
  working: 'Saving your shop…',
  keptTitle: (name: string | null) => (name ? `Done! ${name} is yours` : 'Done! Your shop is yours'),
  keptLead: 'It already has a name, colors and text. The sample products are still here to guide you: swap them for your own.',
  configFailedTitle: (name: string | null) => (name ? `${name} is yours` : 'Your shop is yours'),
  configFailedLead: "Your shop exists with its name, but we couldn't save its colors and text. Set them from your dashboard, under Settings.",
  settings: 'Go to Settings',
  address: 'Your address',
  manage: 'Go to my dashboard',
  viewShop: 'View my shop',
  otherPhoneTitle: 'This shop was built on another phone',
  otherPhoneLead: 'To keep it, open it on the phone where you built it. Or build a new one here in seconds.',
  startNew: 'Build a new shop',
  hasShopTitle: 'You already have a shop',
  hasShopLead: "Your account already has a shop, so we didn't replace it with this one. You can carry on with yours.",
  incompleteTitle: 'Your shop is still being built',
  incompleteLead: 'Wait until it has a name and colors, then tap «Keep it» again.',
  backToShop: 'Back to my shop',
  retry: 'Try again',
  failed: 'The connection dropped while we were saving your shop. Please try again.',
} satisfies Widen<typeof ARMAR_COPY>

export const CHECKLIST_LABELS_EN = {
  perfil: 'Profile',
  catalogo: 'Photos',
  pagos: 'Payments',
  envios: 'Delivery',
  comparte: 'Share',
} satisfies Widen<typeof CHECKLIST_LABELS>

export const CHECKLIST_COPY_EN = {
  title: 'Your shop',
  progress: (done: number, total: number, percent: number) => `${done} of ${total} · ${percent}%`,
  done: 'Done',
  todo: 'To do',
  open: 'Open',
  close: 'Close',
  noGuide: "We couldn't load your steps right now. Reload the page in a moment.",
  perfilTitle: 'Your profile',
  perfilLead: 'A clear name and description build trust with the people who buy from you.',
  nameLabel: 'Your shop name',
  descriptionLabel: 'Description',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  saveFailed: "We couldn't save right now. Please try again.",
  cobrosTitle: 'Payments',
  cobrosLead: 'Connect how you get paid: card or bank transfer. Without this, nobody can pay you.',
  cobrosLeadUs: 'Connect your Stripe account to take card payments in dollars. Without this, nobody can pay you.',
  entregasTitle: 'Delivery',
  entregasLead: 'Say how you deliver: in person, by shipping or for pickup.',
  goSettings: 'Set up now',
  comparteTitle: 'Share your shop',
  comparteLead: 'Send your link to your first buyers.',
  copyLink: 'Copy link',
  copied: 'Link copied',
  copyManual: 'Copy the link:',
  fotosTitle: 'Your photos',
  fotosLead: 'Take or pick a photo of what you sell and we will fill in the details for you.',
} satisfies Widen<typeof CHECKLIST_COPY>

export const PHOTO_COPY_EN = {
  prohibited: "We can't publish products that online payments don't accept (for example controlled medicines, weapons or replicas).",
  take: 'Take a photo',
  pick: 'Choose from my gallery',
  replace: 'Swap for my photo',
  uploading: 'Uploading your photo…',
  reading: 'Looking at your photo…',
  titleLabel: 'Name',
  descriptionLabel: 'Description',
  categoryLabel: 'Category',
  priceLabel: 'Price',
  priceHint: "It's a suggestion: set whatever price you like.",
  confirm: 'Confirm and add',
  confirming: 'Adding…',
  added: "Done, it's in your shop (not published yet).",
  another: 'Add another photo',
  unpublished: 'Not published',
  yourProducts: 'Your products',
  fillYourself: "We couldn't read this photo well. Fill in the details yourself and we'll add it.",
  badPhoto: "You didn't upload that photo here. Take it or choose it again.",
  noShop: 'Keep your shop first so you can add products.',
  signedOut: 'Sign in to add products to your shop.',
  unavailable: "We couldn't save right now. Try again in a moment: no photo was used up.",
  analysisDaily: "We've looked at a lot of photos today. Come back tomorrow.",
  analysisUnavailable: "We couldn't check your photo right now. Try again in a moment.",
  rateLimited: "You're going too fast. Wait a few minutes and try again.",
  invalid: "Something didn't arrive right. Please try again.",
  invalidCard: 'Check the details: the name needs at least 5 letters and the price must be more than zero.',
  inProgress: "We're already adding this product. Wait a moment.",
  createFailed: "We couldn't add the product right now. Tap «Confirm» again: this photo is already paid for and won't be charged twice.",
  uploadFailed: "We couldn't upload your photo. Check your connection and try again.",
  publish: 'Publish',
  publishNeedsProduct: 'Add at least one product of your own',
  publishUnknown: "We couldn't check your products right now. Reload the page.",
} satisfies Widen<typeof PHOTO_COPY>

export const COBROS_COPY_EN = {
  stripeName: 'Card payments with Stripe',
  stripeLead: 'Buyers pay by card in dollars and the money goes straight to your own Stripe account.',
  stripeConnect: 'Connect Stripe',
  pageTitle: 'Payments and delivery',
  pageLead: 'Choose how you get paid and how you deliver. Below you can see what your buyers will see.',
  payTitle: 'How you get paid',
  deliverTitle: 'How you deliver',
  on: 'On',
  off: 'Off',
  mpName: 'Mercado Pago',
  mpLead: 'Card, OXXO and installments. The money goes to your Mercado Pago account.',
  mpConnect: 'Connect Mercado Pago',
  mpConnected: 'Connected',
  mpManage: 'Manage',
  speiName: 'Bank transfer',
  speiLead: 'Buyers pay by bank transfer to your account. You confirm the payment before you deliver.',
  clabeLabel: 'Bank account number (18 digits)',
  clabeCount: (n: number) => `${n} of 18 digits`,
  bankLabel: 'Bank',
  bankPick: 'Choose your bank',
  bankOther: 'Name of your bank',
  holderLabel: 'Account holder',
  speiSave: 'Save account',
  speiOff: 'Remove bank transfer',
  cashName: 'Cash on delivery',
  cashLead: 'Buyers pay you in cash when you hand it over in person.',
  cashNeedsHand: 'Offered when you deliver in person.',
  handName: 'Arranged handoff',
  handLead: 'You agree with the buyer on where and when you hand it over in person.',
  correosName: 'Postal service',
  correosLead: 'Cheap and slow (4 to 10 days), for light items. You take the package to the post office.',
  correosUnavailable: "It's not available yet. We'll turn it on as soon as it's ready.",
  correosNeedsOrigin: 'To get a quote we need the address you ship from.',
  correosOrigin: 'Add my address',
  manualCarrierName: 'Ship it yourself',
  manualCarrierLead: 'You ship with your own carrier and share the tracking number. Already included for your shop.',
  turnOn: 'Turn on',
  turnOff: 'Turn off',
  saving: 'Saving…',
  saved: 'Saved',
  notSynced: "It was saved, but your shop doesn't show it yet. Try again.",
  previewTitle: 'What your buyers will see',
  previewPay: 'They can pay with',
  previewDeliver: 'They can receive it by',
  previewNoPay: 'Nobody can pay you yet. Turn on at least one way to get paid.',
  previewNoDeliver: "There's no way to deliver yet. Turn on at least one.",
  previewLoading: 'Checking your shop…',
  previewUnavailable: "We couldn't check what your buyers will see. Try again in a moment.",
  previewNoShop: 'Keep your shop first.',
  back: 'Back to my shop',
} satisfies Widen<typeof COBROS_COPY>

export const PUBLISH_COPY_EN = {
  publishing: 'Publishing…',
  done: (live: number) => (live === 1 ? 'Done: your product is now live.' : `Done: your ${live} products are now live.`),
  partial: (ok: number, failed: number) => `We published ${ok}. ${failed === 1 ? 'One could not be published' : `${failed} could not be published`}: try again.`,
  needsProduct: 'Add at least one product of your own',
  noShop: 'Keep your shop first.',
  signedOut: 'Sign in to publish your shop.',
  unavailable: "We couldn't check your products right now. Try again in a moment.",
  failed: "We couldn't publish right now. Try again.",
  publishedTitle: 'Your shop is now in the marketplace',
  publishedLead: 'This is how people searching on Miyagi Sánchez see you.',
  seeInMarket: 'View my shop',
  shareTitle: 'Tell your customers',
  whatsapp: 'WhatsApp',
  story: 'Image for your story',
  qr: 'QR code',
  shortLink: 'Short link',
  copied: 'Link copied',
  copyManual: 'Copy the link:',
  shareText: (name: string) => `${name} on Miyagi Sánchez`,
  noPrice: 'Price to be set',
} satisfies Widen<typeof PUBLISH_COPY>

export const NUDGE_STEP_COPY_EN = {
  perfil: { title: 'Complete your profile', lead: 'A clear name and description build trust with the people who buy from you.' },
  catalogo: { title: 'Upload a product photo', lead: 'Take a photo of what you sell and we will fill in the details for you.' },
  pagos: { title: 'Turn on how you get paid', lead: 'Connect Mercado Pago or add your bank account. Without this, nobody can pay you.' },
  envios: { title: 'Choose how you deliver', lead: 'In person or by shipping: say how it reaches your buyer.' },
  comparte: { title: 'Share your shop', lead: 'Send your link to your first buyers.' },
  publicar: { title: 'Publish your shop', lead: "Everything is ready. One tap on «Publish» and your shop goes live." },
} satisfies Widen<typeof NUDGE_STEP_COPY>

export const NUDGE_COPY_EN = {
  subject: (shopName: string, stepTitle: string) => `${shopName}: one step left — ${stepTitle.toLowerCase()}`,
  heading: (shopName: string) => `${shopName} is almost ready`,
  cta: 'Keep building my shop',
  footer: 'We are writing because you started building your shop. You can turn these reminders off in My shop → Settings → Notifications.',
  pushTitle: (shopName: string) => `${shopName}: one step left`,
} satisfies Widen<typeof NUDGE_COPY>

export const NUMBERS_COPY_EN = {
  title: 'Your numbers',
  privateNote: 'Only you can see them. They are starting estimates; you correct them.',
  estimated: 'estimated',
  offerLine: (cost: string, price: string | null, left: string | null, minutes: number) =>
    price && left
      ? `it costs you ${cost}, you sell it for ${price}: you keep ${left}. Takes ${minutes} min.`
      : `it costs you ${cost}. Takes ${minutes} min.`,
  capacity: (resource: string, hours: number) => `Your limit: ${resource}, about ${hours} hours a month.`,
  fixed: (list: string) => `Fixed monthly costs: ${list}.`,
  missing: "We haven't estimated your numbers yet. You fill them in once the shop is yours.",
  later: 'Once the shop is yours, you can change each number in «Your plan» and we will tell you how much to sell to earn what you want.',
} satisfies Widen<typeof NUMBERS_COPY>

/** The business-type picker's labels (the Spanish ones live in `SHAPE_DEFAULTS`, which the prompts also read). */
export const SHAPE_LABELS_EN: Record<BusinessShape, string> = {
  products: 'Products',
  services: 'Services',
  food: 'Food',
  made_to_order: 'Made to order',
  rentals: 'Rentals',
  digital: 'Digital',
}

function shapeLabels(en: boolean): Record<BusinessShape, string> {
  if (en) return SHAPE_LABELS_EN
  return Object.fromEntries(Object.entries(SHAPE_DEFAULTS).map(([k, v]) => [k, v.label])) as Record<BusinessShape, string>
}

/** The builder's whole copy for a locale. Anything that is not 'en' is Spanish (AGENTS rule 5). */
export function builderCopy(locale: P2sLocale | string | null | undefined) {
  const en = locale === 'en'
  return {
    DESCRIBE: en ? DESCRIBE_COPY_EN : DESCRIBE_COPY,
    NARRATION: (en ? NARRATION_EN : NARRATION) as ReadonlyArray<{ key: BlockKey; label: string }>,
    SHAPING: en ? SHAPING_COPY_EN : SHAPING_COPY,
    FALLBACK_NOTE: en ? FALLBACK_NOTE_EN : FALLBACK_NOTE,
    CANVAS: en ? CANVAS_COPY_EN : CANVAS_COPY,
    OWNER: en ? OWNER_COPY_EN : OWNER_COPY,
    GONE: en ? GONE_COPY_EN : GONE_COPY,
    KEEP: en ? KEEP_COPY_EN : KEEP_COPY,
    MAIL_LINK: en ? MAIL_LINK_COPY_EN : MAIL_LINK_COPY,
    CLAIM_RETRY: en ? CLAIM_RETRY_EN : CLAIM_RETRY,
    ARMAR: en ? ARMAR_COPY_EN : ARMAR_COPY,
    CHECKLIST_LABELS: en ? CHECKLIST_LABELS_EN : CHECKLIST_LABELS,
    CHECKLIST: en ? CHECKLIST_COPY_EN : CHECKLIST_COPY,
    PHOTO: en ? PHOTO_COPY_EN : PHOTO_COPY,
    COBROS: en ? COBROS_COPY_EN : COBROS_COPY,
    PUBLISH: en ? PUBLISH_COPY_EN : PUBLISH_COPY,
    NUMBERS: en ? NUMBERS_COPY_EN : NUMBERS_COPY,
    SEED: en ? SEED_COPY_EN : SEED_COPY,
    SHAPE_LABELS: shapeLabels(en),
  }
}

/** The nudge emails' copy for a locale (lib/email.ts). */
/** A US shop is paid one way — its own Stripe account (D15) — so its «pagos» reminder never says Mercado Pago or CLABE. */
const NUDGE_PAGOS_US = {
  es: { title: 'Activa cómo te pagan', lead: 'Conecta tu cuenta de Stripe. Sin esto nadie puede pagarte.' },
  en: { title: 'Turn on how you get paid', lead: 'Connect your Stripe account. Without this, nobody can pay you.' },
} as const

export function nudgeCopy(locale: P2sLocale | string | null | undefined, market?: 'mx' | 'us' | null) {
  const en = locale === 'en'
  const step = en ? NUDGE_STEP_COPY_EN : NUDGE_STEP_COPY
  return {
    NUDGE: en ? NUDGE_COPY_EN : NUDGE_COPY,
    STEP: market === 'us' ? { ...step, pagos: NUDGE_PAGOS_US[en ? 'en' : 'es'] } : step,
  }
}

export function describeCopy(locale: P2sLocale): Widen<typeof DESCRIBE_COPY> {
  return locale === 'en' ? DESCRIBE_COPY_EN : DESCRIBE_COPY
}

/**
 * English for a builder message the SERVER sent in Spanish (one-front-door-both-markets follow-up): the photo, confirm,
 * publish and claim routes answer in the platform's Spanish; an English screen shows the twin at the same key. Built
 * once from the same bundle pairs `builderCopy` uses, so a new Spanish line with an English twin is covered with no
 * second list. A message with no twin (a backend's own text) is returned unchanged.
 */
let EN_FOR: Map<string, string> | null = null
export function englishFor(message: string): string {
  if (!EN_FOR) {
    EN_FOR = new Map()
    const walk = (es: unknown, en: unknown) => {
      if (typeof es === 'string' && typeof en === 'string') { if (!EN_FOR!.has(es)) EN_FOR!.set(es, en); return }
      if (es && en && typeof es === 'object' && typeof en === 'object') {
        for (const k of Object.keys(es as object)) walk((es as Record<string, unknown>)[k], (en as Record<string, unknown>)[k])
      }
    }
    walk(builderCopy('es'), builderCopy('en'))
  }
  return EN_FOR.get(message) ?? message
}
