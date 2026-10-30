import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Image from 'next/image'
import { isLinkToken, payChoices, payScreen } from '@/lib/in-person/payment-link'
import { readCheckoutMethods } from '@/lib/in-person/counter-backend'
import { getPublicLink } from '@/lib/in-person/payment-link-backend'
import PayClient from './PayClient'

/**
 * /pagar/[token] — the page a buyer opens from a payment link (in-person-sales S4.2, D15). Public,
 * noindex, never cached (next.config sets `Cache-Control: private, no-store` for this path), and
 * outside the seller shell. Everything shown (shop, lines, total) is the BACKEND's; the buyer can
 * choose only among the shop's own payment methods.
 */
export const metadata: Metadata = {
  title: 'Pagar — Miyagi Sánchez',
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency || 'MXN', maximumFractionDigits: 2 }).format(cents / 100)

interface PublicLink {
  state: string
  kind: string
  concept: string | null
  lines: Array<{ title: string; quantity: number; unit_price_cents: number }>
  total_cents: number
  currency: string
  shop: { name: string; slug: string; logo_url: string | null }
}

export default async function PagarPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!isLinkToken(token)) notFound()

  const { status, body } = await getPublicLink(token)
  const link = body.payment_link as PublicLink | undefined
  const screen = payScreen({ httpStatus: status, state: link?.state, code: body.code })

  if (screen.screen !== 'ready' || !link) {
    return (
      <main className="max-w-md mx-auto px-4 py-16 text-center">
        {link?.shop && <p className="text-sm text-[var(--color-muted)] mb-2">{link.shop.name}</p>}
        <h1 className="text-xl font-bold">{screen.screen === 'ready' ? 'No pudimos abrir este cobro.' : screen.message}</h1>
      </main>
    )
  }

  let choices: ReturnType<typeof payChoices> = []
  try { choices = payChoices(await readCheckoutMethods(link.shop.slug)) } catch { /* shown as unavailable below */ }

  return (
    <main className="max-w-md mx-auto px-4 py-8">
      <div className="flex items-center gap-3">
        {link.shop.logo_url && <Image src={link.shop.logo_url} alt="" width={48} height={48} className="rounded-[var(--r-md)] object-cover w-12 h-12" />}
        <div>
          <p className="text-sm text-[var(--color-muted)]">Pago a</p>
          <h1 className="text-xl font-bold">{link.shop.name}</h1>
        </div>
      </div>

      <div className="card-panel mt-5 p-4">
        {link.kind === 'amount' ? (
          <p className="font-medium">{link.concept}</p>
        ) : (
          <ul className="list-none p-0 m-0 flex flex-col gap-2">
            {link.lines.map((l, i) => (
              <li key={`${l.title}-${i}`} className="flex justify-between gap-3">
                <span>{l.quantity} x {l.title}</span>
                <span>{money(l.quantity * l.unit_price_cents, link.currency)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-baseline justify-between mt-4 pt-3 border-t border-[var(--color-border)]">
          <span>Total</span>
          <span className="text-2xl font-bold">{money(link.total_cents, link.currency)}</span>
        </div>
      </div>

      <PayClient token={token} choices={choices} />
    </main>
  )
}
