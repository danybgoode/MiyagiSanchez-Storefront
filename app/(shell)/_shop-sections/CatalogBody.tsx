import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import r2ImageLoader from '@/lib/image-loader'
import { listingHref } from '@/lib/shop-presentation/chrome'
import type { CatalogModel } from '@/lib/share-kit/catalog'
import { catalogFor } from '@/lib/share-kit/catalog-server'
import type { ShopPresentationContext } from '@/lib/shop-presentation/context'
import ShopThemeShell from './ShopThemeShell'

export { catalogFor }

/**
 * The shop's catalog page — one scroll of products with one order button each (share-kit S1.2).
 *
 * The page a merchant drops into a WhatsApp chat or a status. It renders the share kit's one model (D6) and nothing
 * else, and ships no client JavaScript: every action is a plain link (D9). Mexico shops only (D5): the order message,
 * the `52` dialling prefix and the copy are Mexican.
 */

export const CATALOG_COPY = {
  title: 'Catálogo',
  orderWhatsApp: 'Pedir por WhatsApp',
  buy: 'Comprar',
  seeShop: 'Ver la tienda completa',
  empty: 'Esta tienda todavía no tiene productos publicados.',
  emptyLink: 'Ver la tienda',
} as const

export function catalogMetadata(ctx: ShopPresentationContext | null, model: CatalogModel | null): Metadata {
  if (!ctx || !model) return { title: 'Página no encontrada' }
  const image = model.shop.logoUrl ?? model.items.find((item) => item.imageUrl)?.imageUrl ?? null
  const description = `${model.items.length} producto${model.items.length === 1 ? '' : 's'} de ${model.shop.name}. Pide en un toque.`
  return {
    title: `${model.shop.name} · ${CATALOG_COPY.title}`,
    description,
    alternates: { canonical: model.links.catalog },
    openGraph: {
      title: `${model.shop.name} · ${CATALOG_COPY.title}`,
      description,
      url: model.links.catalog,
      ...(image ? { images: [{ url: image }] } : {}),
    },
  }
}

export default async function CatalogBody({ ctx }: { ctx: ShopPresentationContext }) {
  const model = await catalogFor(ctx)
  if (!model) notFound()
  const shopHref = ctx.basePath || '/'

  return (
    <ShopThemeShell theme={ctx.theme} accent={ctx.accent}>
      <main className="max-w-xl mx-auto px-4 pb-12" data-testid="catalogo">
        <header className="flex items-center gap-3 py-5 border-b border-[var(--color-border)] mb-5">
          {model.shop.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- the merchant's own logo, through the image proxy
            <img
              src={r2ImageLoader({ src: model.shop.logoUrl, width: 128 })}
              alt=""
              width={56}
              height={56}
              className="w-14 h-14 rounded-[var(--r-pill)] object-cover"
            />
          ) : (
            <div
              className="w-14 h-14 rounded-[var(--r-pill)] flex items-center justify-center text-xl font-bold"
              style={{ background: ctx.accent, color: ctx.accentTextColor }}
              aria-hidden="true"
            >
              {model.shop.name.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-xl font-bold leading-tight">{model.shop.name}</h1>
            <p className="text-sm text-[var(--color-muted)]">{CATALOG_COPY.title}</p>
          </div>
        </header>

        {model.items.length === 0 ? (
          <div className="text-center py-16" data-testid="catalogo-empty">
            <p className="text-[var(--color-muted)] mb-4">{CATALOG_COPY.empty}</p>
            <a href={shopHref} className="btn btn-secondary">{CATALOG_COPY.emptyLink}</a>
          </div>
        ) : (
          <ul className="grid gap-5 list-none p-0 m-0">
            {model.items.map((item, index) => {
              const productHref = listingHref({ listingBase: ctx.listingBase }, item.id)
              return (
                <li key={item.id} className="card-tile overflow-hidden" data-testid="catalogo-item">
                  <a href={productHref} className="block no-underline">
                    {item.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- plain img keeps the page free of client JS
                      <img
                        src={r2ImageLoader({ src: item.imageUrl, width: 640 })}
                        alt={item.title}
                        width={640}
                        height={640}
                        loading={index < 2 ? 'eager' : 'lazy'}
                        className="w-full aspect-square object-cover"
                      />
                    ) : (
                      <div className="w-full aspect-square flex items-center justify-center bg-[var(--color-surface-alt)]">
                        <i className="iconoir-shop text-4xl text-[var(--color-muted)]" aria-hidden="true" />
                      </div>
                    )}
                  </a>
                  <div className="p-4 grid gap-3">
                    <div>
                      <h2 className="text-base font-semibold leading-snug">{item.title}</h2>
                      <p className="t-price mt-1">{item.priceLabel}</p>
                    </div>
                    {item.order.kind === 'whatsapp' ? (
                      <a
                        href={item.order.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn w-full justify-center"
                        style={{ background: 'var(--provider-whatsapp)', color: 'var(--fg-inverse)' }}
                        data-testid="catalogo-order"
                        data-order="whatsapp"
                      >
                        <i className="iconoir-chat-bubble" aria-hidden="true" /> {CATALOG_COPY.orderWhatsApp}
                      </a>
                    ) : (
                      <a
                        href={productHref}
                        className="btn w-full justify-center"
                        style={{ background: ctx.accent, color: ctx.accentTextColor }}
                        data-testid="catalogo-order"
                        data-order="buy"
                      >
                        <i className="iconoir-shopping-bag" aria-hidden="true" /> {CATALOG_COPY.buy}
                      </a>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        <p className="text-center mt-8">
          <a href={shopHref} className="btn btn-ghost">{CATALOG_COPY.seeShop}</a>
        </p>
      </main>
    </ShopThemeShell>
  )
}
