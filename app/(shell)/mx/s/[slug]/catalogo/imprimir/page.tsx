import { notFound } from 'next/navigation'
import QRCode from 'qrcode'
import type { Metadata } from 'next'
import { resolveShopPresentation } from '@/lib/shop-presentation/context'
import { printImageUrl } from '@/lib/image-loader'
import { catalogFor } from '@/lib/share-kit/catalog-server'
import { chunkIntoSheets } from '@/lib/share-kit/print-plan'
import { CATALOG_PRINT_COPY as copy } from '@/lib/share-kit/copy'

/**
 * The catalog as the PDF renderer prints it (share-kit S2.2, D15). Unlinked and `noindex`: it exists for
 * `services/print-pdf` to load, and a person who finds it sees the same public catalog in print layout.
 *
 * `force-dynamic` because a render must never read a CDN-stale page: the PDF's cache key is the hash of the model
 * the route computed (D16), and this page must print that same model. Every image goes through `/api/img` on our
 * own origin, so the renderer's allow-list (D14) has nothing else to admit. QR codes are inline SVG made here, with
 * no network. Public data only, so no secret.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { robots: { index: false, follow: false } }

const CSS = `
  @page { size: A4; margin: 0; }
  .catalog-print { background: #e5e5e5; padding: 24px 0; }
  .catalog-sheet { width: 210mm; height: 297mm; background: #fff; color: #111; margin: 0 auto 16px; padding: 14mm;
    box-sizing: border-box; overflow: hidden; position: relative; page-break-after: always; font-family: inherit; }
  .catalog-sheet:last-child { page-break-after: auto; }
  .catalog-grid { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: repeat(3, 1fr); gap: 6mm; height: 100%; }
  .catalog-card { display: grid; grid-template-rows: 1fr auto; border: 0.3mm solid #ddd; border-radius: 3mm; overflow: hidden; min-height: 0; }
  .catalog-card img.photo { width: 100%; height: 100%; object-fit: cover; min-height: 0; }
  .catalog-card .nophoto { background: #f2f2f2; }
  .catalog-card .meta { display: grid; grid-template-columns: 1fr 22mm; gap: 3mm; padding: 3mm; align-items: center; }
  .catalog-card .title { font-size: 10pt; font-weight: 600; line-height: 1.25; margin: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .catalog-card .price { font-size: 11pt; font-weight: 700; margin: 1.5mm 0 0; }
  .catalog-qr svg { width: 22mm; height: 22mm; display: block; }
  .catalog-cover { display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; gap: 8mm; }
  .catalog-cover img.logo { width: 40mm; height: 40mm; object-fit: cover; border-radius: 50%; }
  .catalog-band { position: absolute; left: 0; right: 0; top: 0; height: 12mm; }
  @media print {
    html, body { background: #fff !important; }
    body > *:not(main) { display: none !important; }
    body > main { display: block !important; margin: 0 !important; padding: 0 !important; }
    .catalog-print { padding: 0 !important; background: #fff !important; }
    .catalog-sheet { margin: 0 !important; }
  }
`

async function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 })
}

export default async function CatalogPrintPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await resolveShopPresentation(slug, { marketBasePath: '/mx', market: 'mx' })
  if (!ctx) notFound()
  const model = await catalogFor(ctx)
  if (!model) notFound()

  const [catalogQr, ...itemQrs] = await Promise.all([
    qrSvg(model.links.catalogShort),
    ...model.items.map((item) => qrSvg(item.shortUrl)),
  ])
  const qrById = new Map(model.items.map((item, i) => [item.id, itemQrs[i]]))
  const band = { background: ctx.accent }
  const sheets = chunkIntoSheets(model.items)

  return (
    <div className="catalog-print" data-testid="catalogo-print">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <section className="catalog-sheet catalog-cover" data-sheet="cover">
        <div className="catalog-band" style={band} />
        {model.shop.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- printed by headless Chromium; next/image adds nothing here
          <img className="logo" src={printImageUrl(model.shop.logoUrl, 384)} alt="" />
        ) : null}
        <h1 style={{ fontSize: '28pt', margin: 0 }}>{model.shop.name}</h1>
        <p style={{ fontSize: '14pt', margin: 0 }}>{copy.subtitle(model.items.length)}</p>
        {model.shop.description ? <p style={{ fontSize: '11pt', maxWidth: '140mm', margin: 0, color: '#444' }}>{model.shop.description}</p> : null}
      </section>

      {sheets.map((sheet, index) => (
        <section key={index} className="catalog-sheet" data-sheet="products">
          <div className="catalog-grid">
            {sheet.map((item) => (
              <article key={item.id} className="catalog-card" data-testid="catalogo-print-item">
                {item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- printed by headless Chromium
                  <img className="photo" src={printImageUrl(item.imageUrl, 640)} alt="" />
                ) : (
                  <div className="nophoto" />
                )}
                <div className="meta">
                  <div>
                    <p className="title">{item.title}</p>
                    <p className="price">{item.priceLabel}</p>
                  </div>
                  <div className="catalog-qr" dangerouslySetInnerHTML={{ __html: qrById.get(item.id) ?? '' }} />
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}

      <section className="catalog-sheet catalog-cover" data-sheet="closing">
        <div className="catalog-band" style={band} />
        <h2 style={{ fontSize: '20pt', margin: 0 }}>{copy.closing(model.shop.name)}</h2>
        <div className="catalog-qr" style={{ transform: 'scale(2)', margin: '12mm 0' }} dangerouslySetInnerHTML={{ __html: catalogQr }} />
        <p style={{ fontSize: '13pt', margin: 0 }}>{model.links.catalogShort.replace(/^https?:\/\//, '')}</p>
        {model.shop.whatsapp ? <p style={{ fontSize: '13pt', margin: 0 }}>{copy.whatsapp(model.shop.whatsapp)}</p> : null}
      </section>
    </div>
  )
}
