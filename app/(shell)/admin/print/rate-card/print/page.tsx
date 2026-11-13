import { redirect } from 'next/navigation'
import { db } from '@/lib/supabase'
import { currentUserIsAdmin } from '@/lib/admin/guard'
import {
  densityRows, blockSize, PRINT_PAGE_DIMS, newPage, PRINT_SPAN_PRESETS,
  type PrintLayoutDocument, type PrintBlock, type PrintSpanKey,
} from '@/lib/print-layout'
import { PRINT_TIER_KEYS, type PrintEdition, type PrintTierKey } from '@/lib/print'
import PrintAdBlock from '@/app/components/PrintAdBlock'
import PrintToolbar from '../../[editionId]/print/PrintToolbar'

export const dynamic = 'force-dynamic'
export const metadata = { title: { absolute: 'Tarifario — Miyagi Prints' } }

const BLEED = 3 // mm

/** Smallest available span preset stands in for the 'card' tier (no dedicated
 *  eighth-page preset exists — a rate card is a reference sheet, not a real
 *  packed layout, so reusing 'quarter' is the honest, simplest choice). */
const TIER_SPAN: Record<PrintTierKey, PrintSpanKey> = {
  full: 'full',
  half: 'half_h',
  quarter: 'quarter',
  card: 'quarter',
}

function formatMXN(cents: number): string {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(cents / 100)
}

/**
 * Promoter Funnel v2 · Sprint 5 (US-5.6) — the downloadable ad-rate template:
 * one page per tier, showing that tier's footprint with its live price, so a
 * promoter can show a merchant exactly what they're buying. Generated FRESH
 * on every request from the SAME layout/render pipeline the real edition PDF
 * uses (lib/print-layout.ts blocks + this print-CSS shell + the Cloud Run
 * Puppeteer service) — no dependency on any baseline artwork file (those were
 * human design inspiration only, and live in a separate un-deployed repo the
 * render service can't reach anyway).
 *
 * Pricing is the active open edition's plain tier list price — what a
 * merchant is actually quoted, not a promoter-discounted variant (print-ad
 * promoter pricing isn't a fixed per-tier override; see lib/promoter-pricing.ts's
 * `variablePrice: true` handling for print_ad).
 *
 * Same dual auth as the sibling edition print-view: a Clerk admin OR
 * `?secret=ADMIN_SECRET` (the machine path the Cloud Run PDF renderer uses).
 */
export default async function RateCardPrintPage({
  searchParams,
}: {
  searchParams: Promise<{ secret?: string }>
}) {
  const { secret } = await searchParams
  const adminSecret = process.env.ADMIN_SECRET
  const secretOk = Boolean(adminSecret) && secret === adminSecret
  if (!secretOk && !(await currentUserIsAdmin())) redirect('/')

  const { data: edition } = (await db
    .from('print_editions')
    .select('tiers')
    .eq('status', 'open')
    .order('submission_deadline', { ascending: true })
    .limit(1)
    .maybeSingle()) as { data: Pick<PrintEdition, 'tiers'> | null }
  const tiers = edition?.tiers ?? []

  const pages = PRINT_TIER_KEYS.map((key) => {
    const tier = tiers.find((t) => t.key === key)
    const page = newPage(4)
    const preset = PRINT_SPAN_PRESETS[TIER_SPAN[key]]
    const block: PrintBlock = {
      id: `rate-card-${key}`,
      kind: 'ad',
      source: { type: 'custom' },
      span: preset.span,
      content: {
        headline: tier?.label ?? preset.label,
        price: tier ? formatMXN(tier.price_cents) : undefined,
        body: 'Espacio disponible',
      },
      style: {},
      tier_key: key,
    }
    page.blocks = [block]
    return page
  })
  const document: PrintLayoutDocument = { version: 1, density_default: 4, pages }

  const dims = PRINT_PAGE_DIMS.carta
  const pageW = dims.w_mm + BLEED * 2
  const pageH = dims.h_mm + BLEED * 2

  const css = `
    @page { size: ${pageW}mm ${pageH}mm; margin: 0; }
    .print-root { position: fixed; inset: 0; overflow: auto; background: #555; z-index: 9999; padding: 56px 0 24px; }
    .sheet { width: ${pageW}mm; height: ${pageH}mm; background: #fff; position: relative; margin: 0 auto 16px; box-shadow: 0 2px 12px rgba(0,0,0,.4); overflow: hidden; page-break-after: always; }
    .sheet:last-of-type { page-break-after: auto; }
    .trim { position: absolute; top: ${BLEED}mm; left: ${BLEED}mm; right: ${BLEED}mm; bottom: ${BLEED}mm; }
    .pgrid { position: absolute; inset: 0; display: grid; gap: 1.5mm; grid-template-columns: repeat(2, 1fr); grid-auto-rows: 1fr; grid-auto-flow: dense; }
    @media print {
      html, body { background: #fff !important; }
      body > *:not(main) { display: none !important; }
      body > main { display: block !important; margin: 0 !important; padding: 0 !important; }
      .print-root { position: static !important; overflow: visible !important; background: #fff !important; padding: 0 !important; }
      .sheet { margin: 0 !important; box-shadow: none !important; }
      .no-print { display: none !important; }
    }
  `

  return (
    <div className="print-root">
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <PrintToolbar backHref="/admin/print" />

      {document.pages.map((page) => (
        <div key={page.id} className="sheet">
          <div className="trim">
            <div className="pgrid" style={{ gridTemplateRows: `repeat(${densityRows(page.density)}, 1fr)` }}>
              {page.blocks.map((b) => (
                <div key={b.id} style={{ gridColumn: `span ${b.span.col}`, gridRow: `span ${b.span.row}`, minHeight: 0 }}>
                  <PrintAdBlock block={b} tierLabel={b.content.headline ?? ''} size={blockSize(page.density, b.span)} />
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
