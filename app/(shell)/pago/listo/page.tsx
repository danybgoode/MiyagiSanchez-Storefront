import Link from 'next/link'
import type { Metadata } from 'next'

/**
 * /pago/listo — where a buyer lands after paying (or abandoning) a counter or payment-link QR
 * (in-person-sales D8). A plain thank-you: it never completes a cart and sends no email. The
 * order is created by the provider webhook (and the reconcile job), not by this redirect, so
 * nothing here can mark anything paid. `?estado=cancelado` is the "you backed out" variant.
 */
export const metadata: Metadata = {
  title: 'Pago — Miyagi Sánchez',
  robots: { index: false, follow: false },
}

export default async function PagoListoPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const { estado } = await searchParams
  const cancelled = estado === 'cancelado'
  return (
    <main className="max-w-md mx-auto px-4 py-16 text-center">
      <i className={`${cancelled ? 'iconoir-xmark' : 'iconoir-check-circle'} text-5xl ${cancelled ? 'text-[var(--color-muted)]' : 'text-[var(--color-success)]'}`} aria-hidden />
      <h1 className="text-2xl font-bold mt-3">{cancelled ? 'No se hizo el pago' : 'Listo'}</h1>
      <p className="text-[var(--color-muted)] mt-2">
        {cancelled
          ? 'No te cobramos nada. Si quieres pagar, pídele a la tienda que te muestre el código otra vez.'
          : 'La tienda confirmará tu pago en un momento. Si tienes dudas, pregúntale a quien te atendió.'}
      </p>
      <Link href="/" className="btn btn-secondary mt-6 inline-flex">Ir a Miyagi Sánchez</Link>
    </main>
  )
}
