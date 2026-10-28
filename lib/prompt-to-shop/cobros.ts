/**
 * Prompt-to-shop — the cobros / entregas chooser (epic S5.1). Pure: no I/O, no `next/*`.
 *
 * THE RAILS ARE THE EXISTING ONES, unchanged. This module only decides two things:
 *
 *   • which choice shows as switched on, read off the SAME settings keys the settings pages write; and
 *   • the `PATCH /api/sell/shop` body each choice sends — the exact keys and values the Pagos and Envíos sections
 *     send for the same switch. The route deep-merges `settings`, so a body carrying one key changes that key only.
 *
 * Mercado Pago is not written here at all: it is the existing OAuth (`/api/mp/connect`), which writes its own state
 * on the way back. SPEI reuses the CLABE rule in `lib/clabe.ts`, the one the Pagos section uses.
 *
 * What a BUYER will be offered is not decided here either. That is checkout's rule, previewed through
 * `lib/checkout-options.ts`; the switches below are what the merchant asked for, and the preview is what checkout
 * makes of it (cash, for instance, is only offered with hand delivery — the preview shows that, this does not).
 */

import { clabeComplete, normalizeClabeInput } from '../clabe'

/** The settings the chooser reads: the shop's `metadata.settings`, as the settings pages read it. */
export interface CobrosSettings {
  mercadopago?: { connected?: boolean } | null
  checkout?: {
    bank_transfer?: { enabled?: boolean; clabe?: string | null; bank_name?: string | null; account_holder?: string | null } | null
    cash_pickup?: { enabled?: boolean } | null
  } | null
  shipping?: { local_pickup?: boolean; correos_enabled?: boolean; origin_address?: Record<string, string | null> | null } | null
}

export interface ChooserState {
  mercadopago: boolean
  spei: boolean
  /** The CLABE on file, for the field's initial value. Never shown to anyone but its owner. */
  clabe: string
  bankName: string
  accountHolder: string
  cash: boolean
  /** «Entrega acordada» — the shop-level hand delivery / pickup switch (`shipping.local_pickup`). */
  handDelivery: boolean
  correos: boolean
  /** Correos quotes from the shop's origin address; without one it is saved but not offered. */
  hasOrigin: boolean
}

export function readChooserState(settings: CobrosSettings | null | undefined): ChooserState {
  const s = settings ?? {}
  const bt = s.checkout?.bank_transfer ?? {}
  const stored = typeof bt.clabe === 'string' ? bt.clabe : ''
  // Checkout's own test (`sellerHasSpei`): ALL the stored digits, exactly 18. Slicing first would call a 19-digit
  // value complete here while checkout refuses it.
  const storedDigits = stored.replace(/\D/g, '')
  const clabe = normalizeClabeInput(stored)
  const origin = s.shipping?.origin_address ?? {}
  return {
    // The same "connected" the cobros wizard and the setup guide read.
    mercadopago: s.mercadopago?.connected === true,
    spei: bt.enabled !== false && clabeComplete(storedDigits),
    clabe,
    bankName: typeof bt.bank_name === 'string' ? bt.bank_name : '',
    accountHolder: typeof bt.account_holder === 'string' ? bt.account_holder : '',
    // Stored default-on: the Pagos section shows an absent `cash_pickup.enabled` as on, and so does this.
    cash: s.checkout?.cash_pickup?.enabled !== false,
    handDelivery: s.shipping?.local_pickup === true,
    correos: s.shipping?.correos_enabled === true,
    hasOrigin: !!(origin.street && origin.city && (origin.state_code || origin.state) && origin.postal_code),
  }
}

export type SettingsPatch = { settings: Record<string, unknown> }

/**
 * Save SPEI: the Pagos section's `bank_transfer` block, switched on. `null` when the CLABE is not complete — the
 * Pagos rule — so nothing is sent that checkout would not offer.
 */
export function speiPatch(input: { clabe: string; bankName: string; accountHolder: string }): SettingsPatch | null {
  const clabe = normalizeClabeInput(input.clabe)
  if (!clabeComplete(clabe)) return null
  return {
    settings: {
      checkout: {
        bank_transfer: {
          enabled: true,
          clabe,
          bank_name: input.bankName.trim() || null,
          account_holder: input.accountHolder.trim() || null,
        },
      },
    },
  }
}

/** Turn SPEI off without forgetting the CLABE (the merge keeps every key this does not send). */
export function speiOffPatch(): SettingsPatch {
  return { settings: { checkout: { bank_transfer: { enabled: false } } } }
}

export function cashPatch(enabled: boolean): SettingsPatch {
  return { settings: { checkout: { cash_pickup: { enabled } } } }
}

export function handDeliveryPatch(enabled: boolean): SettingsPatch {
  return { settings: { shipping: { local_pickup: enabled } } }
}

export function correosPatch(enabled: boolean): SettingsPatch {
  return { settings: { shipping: { correos_enabled: enabled } } }
}

/**
 * The existing Mercado Pago OAuth start, unchanged. `redirect_to=wizard` is the return the cobros wizard already
 * uses (its callback lands on `/shop/manage/settings/pagos/wizard` with the connected state); no new return target.
 */
export const MP_CONNECT_HREF = '/api/mp/connect?redirect_to=wizard'
