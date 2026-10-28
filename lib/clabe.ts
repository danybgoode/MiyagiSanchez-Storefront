/**
 * lib/clabe.ts — the SPEI CLABE input rule, in one place.
 *
 * Extracted from the Pagos settings section (`shop/manage/settings/_sections/Pagos.tsx`), which held it inline, so
 * the prompt-to-shop cobros chooser (S5.1) saves a CLABE through the SAME rule instead of a second copy of it:
 * digits only, at most 18, and complete at exactly 18. Checkout offers SPEI on the same condition — the backend's
 * `sellerHasSpei` strips non-digits and requires length 18 — so "complete here" and "offered at checkout" agree.
 *
 * Pure and next-free: a browser module and the Playwright `api` runner both import it.
 */

export const CLABE_LENGTH = 18

/** The banks the Pagos section offers in its picker. Moved here with the rule so both surfaces list the same banks. */
export const MX_BANKS = [
  'BBVA', 'Banorte', 'Santander', 'Citibanamex', 'HSBC', 'Scotiabank',
  'Banco Azteca', 'Inbursa', 'BanCoppel', 'Afirme', 'Banregio', 'BanBajío',
  'Nu', 'Hey Banco', 'Klar', 'Mercado Pago', 'Otro',
] as const

/** What the CLABE field keeps of what was typed or pasted: its digits, at most 18 of them. */
export function normalizeClabeInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, CLABE_LENGTH)
}

/** A CLABE checkout will offer: exactly 18 digits. */
export function clabeComplete(clabe: string): boolean {
  return clabe.length === CLABE_LENGTH
}

/** The picker's «other bank» entry. Choosing it opens a free-text field; it is never stored as a bank name. */
export const OTHER_BANK = 'Otro'

/**
 * How a stored bank name opens the picker: a listed bank selects itself; a name not on the list (or a legacy literal
 * «Otro») selects «Otro» with the name in the free-text field. Pagos and the cobros chooser share it.
 */
export function initialBankPick(stored: string | null | undefined): { isOther: boolean; name: string } {
  const name = (stored ?? '').trim()
  if (!name) return { isOther: false, name: '' }
  if (name === OTHER_BANK) return { isOther: true, name: '' }
  return (MX_BANKS as readonly string[]).includes(name) ? { isOther: false, name } : { isOther: true, name }
}

/** A choice in the picker: «Otro» clears the name for the free-text field; anything else IS the name. */
export function pickBank(choice: string): { isOther: boolean; name: string } {
  return choice === OTHER_BANK ? { isOther: true, name: '' } : { isOther: false, name: choice }
}
