import 'server-only'

import { headers } from 'next/headers'
import { getLanguagePreference } from '@/lib/site-language-server'
import {
  resolveShopPresentation,
  type ShopPresentationOptions,
} from './context'

/** Dynamic owned-host adapter; request-neutral public routes import context.ts directly. */
export async function resolveRequestShopPresentation(
  slug: string | null,
  options: ShopPresentationOptions = {},
) {
  const requestHeaders = await headers()
  return resolveShopPresentation(slug, {
    ...options,
    ownedShopSlug: requestHeaders.get('x-miyagi-shop-slug'),
    language: await getLanguagePreference(),
  })
}

/**
 * Dynamic MARKETPLACE adapter (`/mx/s/<slug>/…`, `/us/s/<slug>/…`): the same context, in the visitor's stored
 * language. The public-read cache renders these sections through `context.ts` directly and never imports this file,
 * which is what keeps that cache request-neutral (`lib/revalidate-truth.ts`).
 */
export async function resolveMarketShopPresentation(
  slug: string | null,
  options: ShopPresentationOptions = {},
) {
  return resolveShopPresentation(slug, { ...options, language: await getLanguagePreference() })
}
