/**
 * «Mandar recibo» — the plain-text receipt a merchant can send a buyer from WhatsApp
 * (in-person-sales S2.3). Pure: the caller passes already-formatted money so this file never
 * guesses a locale or a currency.
 */
export interface ReceiptLine { title: string; variantTitle: string | null; quantity: number; lineTotal: string }

export function buildReceiptText(input: {
  shopName: string
  lines: ReceiptLine[]
  total: string
  /** Already formatted (the merchant's own date format). */
  date: string
  method: 'cash' | 'card' | 'transfer'
}): string {
  const METHOD = { cash: 'Efectivo', card: 'Tarjeta', transfer: 'Transferencia' } as const
  const items = input.lines.map((l) => `${l.quantity} x ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ''}: ${l.lineTotal}`)
  return [`Recibo de ${input.shopName}`, input.date, '', ...items, '', `Total: ${input.total}`, `Pago: ${METHOD[input.method]}`, 'Gracias por tu compra'].join('\n')
}
