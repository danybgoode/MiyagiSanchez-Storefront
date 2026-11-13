/**
 * Prompt-to-shop — the English copy (epic one-front-door-both-markets D11). Same shapes as `copy.ts`, checked by
 * `satisfies`, so a key added in Spanish and forgotten here is a type error rather than a blank line on `/en`.
 */

import { DESCRIBE_COPY } from './copy'
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

export function describeCopy(locale: P2sLocale): Widen<typeof DESCRIBE_COPY> {
  return locale === 'en' ? DESCRIBE_COPY_EN : DESCRIBE_COPY
}
