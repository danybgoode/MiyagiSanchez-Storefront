/**
 * lib/notifications/catalog.ts
 *
 * THE communications matrix (marketplace-communications epic · D1). Every message
 * this platform can send is declared here exactly once: what triggers it, which
 * actor causes it, which actor receives it, and over which channels.
 *
 * Why a registry and not a parse of call sites: a script that greps for senders is
 * a guess that rots on the first refactor, and the whole point of this epic is a
 * map that cannot drift from the code it describes. So the declaration lives beside
 * the senders and a spec (`e2e/communications-catalog-population.spec.ts`, D2)
 * fails when `lib/email.ts` grows an export this file does not know about.
 *
 * PURE by construction — no `server-only`, no Supabase, no Resend. It is data plus
 * two total functions, so the Playwright `api` runner can assert over it without a
 * network, and the admin surface can render it directly.
 *
 * `trigger` is es-MX: it is rendered verbatim in `/admin/comunicaciones`, which is
 * user-facing app copy (AGENTS rule 5). Everything else here is English, like the
 * rest of the codebase.
 *
 * CHANNELS ARE THE DECLARED CAPABILITY, NOT THE GUARANTEED DELIVERY. A message
 * listed as `['email', 'push', 'telegram']` fans out through
 * `lib/notifications/dispatch.ts`, which consults the recipient's own preference
 * grid — and `telegram` is default-OFF for every group (`CHANNEL_DEFAULTS`), so a
 * seller who never linked a chat receives it on two channels. The matrix answers
 * "what can this send", the preference grid answers "what did this seller ask for".
 */
import type { Channel, EventGroup } from '@/lib/notifications/preferences'

/**
 * The five actors that exchange messages here.
 *
 * `platform` is Miyagi acting on its own behalf — a webhook fired, a cron ran, a
 * verification code was requested. It is deliberately distinct from `admin`, who
 * is a human operator taking a deliberate action, because "the system told you" and
 * "Daniel told you" are different facts to anyone reading this map. `promoter` is a
 * real, separately-authorized actor in this marketplace (the commission-paid
 * recruiter and, on /us, the founding operator), not a flavour of seller.
 */
export const COMMUNICATION_ACTORS = ['platform', 'admin', 'seller', 'buyer', 'promoter'] as const
export type CommunicationActor = (typeof COMMUNICATION_ACTORS)[number]

/** Where a communication sits in the product. Drives the grouping in the admin UI. */
export const COMMUNICATION_DOMAINS = [
  'orders',
  'offers',
  'returns',
  'shipping',
  'print',
  'launchpad',
  'events',
  'sweepstakes',
  'promoter',
  'referrals',
  'agent',
  // Operator-composed, not automated. Its own domain so it never hides among the
  // triggered messages an operator is auditing.
  'difusion',
  // Buyer↔seller conversations. Added 2026-08-15: messaging had no communication of
  // its own because it sent none — starting a conversation notified nobody and a
  // reply sent web push only.
  'mensajes',
  'cuentas',
] as const
export type CommunicationDomain = (typeof COMMUNICATION_DOMAINS)[number]

export type CommunicationEntry = {
  /** Stable identity. Never renamed — the admin surface and the sample sender key off it. */
  key: string
  /** Plain-language es-MX description of the action that fires this. */
  trigger: string
  from: CommunicationActor
  to: CommunicationActor
  /** Every channel this message can travel on. See the note above on capability vs delivery. */
  channels: Channel[]
  domain: CommunicationDomain
  /** The `lib/email.ts` export that renders it. */
  sender: string
  /** Where it fires from — the file that calls the sender. */
  origin: string
  /**
   * The seller/buyer preference group, when this message routes through
   * `lib/notifications/dispatch.ts`. Absent means it sends unconditionally —
   * verification codes, admin alerts and receipts are not preference-gated,
   * deliberately: a code nobody receives is a broken login, not a quiet preference.
   */
  group?: EventGroup
}

export const COMMUNICATION_CATALOG: readonly CommunicationEntry[] = [
  {
    key: 'account.welcome', trigger: 'Una persona verifica su correo al crear una cuenta.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'cuentas',
    sender: 'sendAccountWelcome', origin: 'app/api/webhooks/clerk/route.ts',
  },
  {
    key: 'shop.claim_link_requested', trigger: 'Una persona solicita por correo el enlace para reclamar una tienda.',
    from: 'platform', to: 'seller', channels: ['email'], domain: 'cuentas',
    sender: 'sendShopClaimLink', origin: 'app/api/claim/send/route.ts',
  },
  {
    key: 'shop.p2s_draft_link', trigger: 'Quien armó una tienda describiéndola pide que le mandemos el enlace por correo.',
    from: 'platform', to: 'seller', channels: ['email'], domain: 'cuentas',
    sender: 'sendP2sDraftLink', origin: 'app/api/p2s/link/[id]/route.ts',
  },
  {
    key: 'shop.claimed_welcome', trigger: 'La tienda se vincula a una cuenta por primera vez.',
    from: 'platform', to: 'seller', channels: ['email'], domain: 'cuentas',
    sender: 'sendShopClaimedWelcome', origin: 'app/api/claim/complete/route.ts',
  },
  {
    key: 'shop.created_welcome.mx', trigger: 'Se crea una tienda propia en el mercado de México.',
    from: 'platform', to: 'seller', channels: ['email'], domain: 'cuentas',
    sender: 'sendShopCreatedWelcome', origin: 'lib/shop-created-welcome.ts',
  },
  {
    key: 'shop.created_welcome.us', trigger: 'Se crea una tienda propia en el mercado de Estados Unidos.',
    from: 'platform', to: 'seller', channels: ['email'], domain: 'cuentas',
    sender: 'sendShopCreatedWelcome', origin: 'lib/shop-created-welcome.ts',
  },
  // ── Offers ──────────────────────────────────────────────────────────────────
  {
    key: 'offer.confirmed_to_buyer',
    trigger: 'Un comprador envía una oferta por un anuncio.',
    from: 'buyer', to: 'buyer', channels: ['email'], domain: 'offers',
    sender: 'sendOfferConfirmed', origin: 'app/api/offers/route.ts',
  },
  {
    key: 'offer.new_to_seller',
    trigger: 'Un comprador envía una oferta por un anuncio.',
    from: 'buyer', to: 'seller', channels: ['email', 'push', 'telegram'], domain: 'offers',
    sender: 'sendNewOfferToSeller', origin: 'app/api/offers/route.ts', group: 'offers',
  },
  {
    key: 'offer.accepted',
    trigger: 'El vendedor acepta una oferta.',
    from: 'seller', to: 'buyer', channels: ['email'], domain: 'offers',
    sender: 'sendOfferAccepted', origin: 'lib/offer-respond.ts',
  },
  {
    key: 'offer.declined',
    trigger: 'El vendedor rechaza una oferta.',
    from: 'seller', to: 'buyer', channels: ['email'], domain: 'offers',
    sender: 'sendOfferDeclined', origin: 'lib/offer-respond.ts',
  },
  {
    key: 'offer.countered',
    trigger: 'El vendedor responde con una contraoferta.',
    from: 'seller', to: 'buyer', channels: ['email'], domain: 'offers',
    sender: 'sendOfferCountered', origin: 'lib/offer-respond.ts',
  },
  {
    key: 'offer.counter_accepted',
    trigger: 'El comprador acepta la contraoferta del vendedor.',
    from: 'buyer', to: 'seller', channels: ['email', 'push', 'telegram'], domain: 'offers',
    sender: 'sendCounterAccepted', origin: 'app/api/offers/[id]/buyer-respond/route.ts', group: 'offers',
  },
  {
    key: 'offer.withdrawn',
    trigger: 'El comprador retira su oferta.',
    from: 'buyer', to: 'seller', channels: ['email'], domain: 'offers',
    sender: 'sendOfferWithdrawn', origin: 'app/api/offers/[id]/buyer-respond/route.ts',
  },
  {
    key: 'offer.seller_reminder',
    trigger: 'Una oferta lleva horas sin respuesta del vendedor.',
    from: 'platform', to: 'seller', channels: ['email'], domain: 'offers',
    sender: 'sendSellerOfferReminder', origin: 'app/api/cron/offer-reminders/route.ts',
  },
  {
    key: 'offer.seller_expiry_warning',
    trigger: 'Una oferta está por vencer sin respuesta del vendedor.',
    from: 'platform', to: 'seller', channels: ['email'], domain: 'offers',
    sender: 'sendSellerExpiryWarning', origin: 'app/api/cron/offer-reminders/route.ts',
  },
  {
    key: 'offer.buyer_counter_expiry_warning',
    trigger: 'Una contraoferta está por vencer sin respuesta del comprador.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'offers',
    sender: 'sendBuyerCounterExpiryWarning', origin: 'app/api/cron/offer-reminders/route.ts',
  },
  {
    key: 'offer.buyer_payment_expiry_warning',
    trigger: 'Una oferta aceptada está por vencer sin que el comprador pague.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'offers',
    sender: 'sendBuyerPaymentExpiryWarning', origin: 'app/api/cron/offer-reminders/route.ts',
  },

  // ── Orders ──────────────────────────────────────────────────────────────────
  {
    key: 'order.confirmed_to_buyer',
    trigger: 'Se confirma el pago de una compra (Stripe o Mercado Pago).',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'orders',
    sender: 'sendOrderConfirmedToBuyer', origin: 'app/api/webhooks/stripe/route.ts',
  },
  {
    key: 'order.sale_completed_to_seller',
    trigger: 'Se confirma el pago de una compra (Stripe o Mercado Pago).',
    from: 'platform', to: 'seller', channels: ['email', 'push', 'telegram'], domain: 'orders',
    sender: 'sendSaleCompletedToSeller', origin: 'app/api/webhooks/stripe/route.ts', group: 'orders',
  },
  {
    key: 'order.new_to_seller',
    trigger: 'Entra un pedido nuevo pagado con tarjeta.',
    from: 'platform', to: 'seller', channels: ['email', 'push', 'telegram'], domain: 'orders',
    sender: 'sendNewOrderToSeller', origin: 'app/api/webhooks/stripe/route.ts', group: 'orders',
  },
  {
    key: 'order.coordinated_to_buyer',
    trigger: 'Se paga un pedido cuya entrega se coordina con el vendedor.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'orders',
    sender: 'sendCoordinatedOrderToBuyer', origin: 'app/api/webhooks/stripe/route.ts',
  },
  {
    key: 'order.coordinated_to_seller',
    trigger: 'Se paga un pedido cuya entrega se coordina con el vendedor.',
    from: 'platform', to: 'seller', channels: ['email', 'push', 'telegram'], domain: 'orders',
    sender: 'sendCoordinatedOrderToSeller', origin: 'app/api/webhooks/stripe/route.ts', group: 'orders',
  },
  {
    key: 'order.pickup_to_buyer',
    trigger: 'Se paga un pedido para recoger en tienda.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'orders',
    sender: 'sendPickupOrderToBuyer', origin: 'app/api/webhooks/stripe/route.ts',
  },
  {
    key: 'order.pickup_to_seller',
    trigger: 'Se paga un pedido para recoger en tienda.',
    from: 'platform', to: 'seller', channels: ['email', 'push', 'telegram'], domain: 'orders',
    sender: 'sendPickupOrderToSeller', origin: 'app/api/webhooks/stripe/route.ts', group: 'orders',
  },
  {
    key: 'order.manual_to_buyer',
    trigger: 'Se cierra un pedido con pago manual (transferencia o efectivo).',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'orders',
    sender: 'sendManualOrderToBuyer', origin: 'app/api/orders/finalize-manual/route.ts',
  },
  {
    key: 'order.manual_to_seller',
    trigger: 'Se cierra un pedido con pago manual (transferencia o efectivo).',
    from: 'platform', to: 'seller', channels: ['email', 'push', 'telegram'], domain: 'orders',
    sender: 'sendManualOrderToSeller', origin: 'app/api/orders/finalize-manual/route.ts', group: 'orders',
  },
  {
    key: 'order.buyer_reported_payment',
    trigger: 'El comprador avisa que ya hizo la transferencia.',
    from: 'buyer', to: 'seller', channels: ['email', 'push', 'telegram'], domain: 'orders',
    sender: 'sendBuyerReportedPaymentToSeller', origin: 'app/api/orders/[id]/report-payment/route.ts',
    group: 'payments',
  },
  // ── Mensajes ────────────────────────────────────────────────────────────────
  // ── Difusión ────────────────────────────────────────────────────────────────
  {
    key: 'difusion.platform_broadcast',
    trigger: 'Un admin redacta y envía un aviso operativo desde /admin/comunicaciones → Difusión.',
    from: 'admin', to: 'seller', channels: ['email'], domain: 'difusion',
    sender: 'sendPlatformBroadcast', origin: 'app/api/admin/comunicaciones/broadcast/route.ts',
  },
  {
    key: 'mensajes.conversation_message',
    trigger: 'Alguien escribe en una conversación sobre un anuncio (incluye "Preguntar" en un anuncio).',
    from: 'buyer', to: 'seller', channels: ['email', 'push', 'telegram'], domain: 'mensajes',
    sender: 'sendConversationMessage', origin: 'lib/notifications/conversation.ts', group: 'mensajes',
  },
  {
    key: 'order.ml_event_to_seller',
    trigger: 'Cambia el estado de un pedido en Mercado Libre.',
    from: 'platform', to: 'seller', channels: ['email'], domain: 'orders',
    sender: 'sendMlOrderEventToSeller', origin: 'app/api/internal/ml/notify-seller/route.ts',
  },

  // ── Shipping ────────────────────────────────────────────────────────────────
  {
    key: 'shipping.order_shipped',
    trigger: 'El vendedor marca un pedido como enviado.',
    from: 'seller', to: 'buyer', channels: ['email'], domain: 'shipping',
    sender: 'sendOrderShipped', origin: 'app/api/orders/[id]/ship/route.ts',
  },
  {
    key: 'shipping.order_delivered',
    trigger: 'Se marca un pedido como entregado.',
    from: 'seller', to: 'buyer', channels: ['email'], domain: 'shipping',
    sender: 'sendOrderDelivered', origin: 'app/api/orders/[id]/route.ts',
  },

  // ── Returns ─────────────────────────────────────────────────────────────────
  {
    key: 'return.requested_to_seller',
    trigger: 'El comprador solicita una devolución.',
    from: 'buyer', to: 'seller', channels: ['email', 'push', 'telegram'], domain: 'returns',
    sender: 'sendReturnRequestToSeller', origin: 'app/api/orders/[id]/return-request/route.ts',
    group: 'returns',
  },
  {
    key: 'return.requested_confirmed_to_buyer',
    trigger: 'El comprador solicita una devolución.',
    from: 'buyer', to: 'buyer', channels: ['email'], domain: 'returns',
    sender: 'sendReturnRequestConfirmedToBuyer', origin: 'app/api/orders/[id]/return-request/route.ts',
  },
  {
    key: 'return.accepted',
    trigger: 'El vendedor acepta una devolución.',
    from: 'seller', to: 'buyer', channels: ['email'], domain: 'returns',
    sender: 'sendReturnAcceptedToBuyer', origin: 'app/api/orders/[id]/return-request/[requestId]/route.ts',
  },
  {
    key: 'return.declined',
    trigger: 'El vendedor rechaza una devolución.',
    from: 'seller', to: 'buyer', channels: ['email'], domain: 'returns',
    sender: 'sendReturnDeclinedToBuyer', origin: 'app/api/orders/[id]/return-request/[requestId]/route.ts',
  },
  {
    key: 'return.refund_transfer_sent',
    trigger: 'El vendedor confirma que ya envió el reembolso.',
    from: 'seller', to: 'buyer', channels: ['email'], domain: 'returns',
    sender: 'sendRefundTransferSentToBuyer', origin: 'app/api/orders/[id]/return-request/[requestId]/route.ts',
  },

  // ── Print edition ───────────────────────────────────────────────────────────
  {
    key: 'print.ad_received_to_buyer',
    trigger: 'Alguien envía un anuncio para la edición impresa.',
    from: 'buyer', to: 'buyer', channels: ['email'], domain: 'print',
    sender: 'sendPrintAdReceivedToBuyer', origin: 'lib/print-server.ts',
  },
  {
    key: 'print.ad_received_to_miyagi',
    trigger: 'Alguien envía un anuncio para la edición impresa.',
    from: 'buyer', to: 'admin', channels: ['email'], domain: 'print',
    sender: 'sendPrintAdReceivedToMiyagi', origin: 'lib/print-server.ts',
  },
  {
    key: 'print.ad_payment_pending',
    trigger: 'Un anuncio impreso queda esperando pago.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'print',
    sender: 'sendPrintAdPaymentPending', origin: 'app/api/cron/print-pending/route.ts',
  },
  {
    key: 'print.ad_approved',
    trigger: 'Miyagi aprueba un anuncio impreso.',
    from: 'admin', to: 'buyer', channels: ['email'], domain: 'print',
    sender: 'sendPrintAdApproved', origin: 'lib/print-server.ts',
  },
  {
    key: 'print.ad_rejected',
    trigger: 'Miyagi rechaza un anuncio impreso.',
    from: 'admin', to: 'buyer', channels: ['email'], domain: 'print',
    sender: 'sendPrintAdRejected', origin: 'lib/print-server.ts',
  },
  {
    key: 'print.payment_reported_to_miyagi',
    trigger: 'El anunciante avisa que ya pagó su anuncio impreso.',
    from: 'buyer', to: 'admin', channels: ['email'], domain: 'print',
    sender: 'sendPrintPaymentReportedToMiyagi', origin: 'app/api/print/submissions/[id]/payment-reported/route.ts',
  },
  {
    key: 'print.payment_reported_to_buyer',
    trigger: 'El anunciante avisa que ya pagó su anuncio impreso.',
    from: 'buyer', to: 'buyer', channels: ['email'], domain: 'print',
    sender: 'sendPrintPaymentReportedToBuyer', origin: 'app/api/print/submissions/[id]/payment-reported/route.ts',
  },
  {
    key: 'print.social_received',
    trigger: 'Alguien envía material para las redes de la edición.',
    from: 'buyer', to: 'admin', channels: ['email'], domain: 'print',
    sender: 'sendPrintSocialReceived', origin: 'app/api/print/social/route.ts',
  },

  // ── Launchpad ───────────────────────────────────────────────────────────────
  {
    key: 'launchpad.verification_code',
    trigger: 'Alguien pide un código para verificar su correo en Launchpad.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'launchpad',
    sender: 'sendLaunchpadVerificationCode', origin: 'lib/launchpad.ts',
  },
  {
    key: 'launchpad.status',
    trigger: 'Cambia el estado de una propuesta en Launchpad.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'launchpad',
    sender: 'sendLaunchpadStatusEmail', origin: 'lib/launchpad.ts',
  },
  {
    key: 'launchpad.published',
    trigger: 'Se publica una propuesta de Launchpad.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'launchpad',
    sender: 'sendLaunchpadPublishedEmail', origin: 'lib/launchpad.ts',
  },
  {
    key: 'launchpad.campaign_vote_code',
    trigger: 'Alguien pide un código para votar en una campaña.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'launchpad',
    sender: 'sendLaunchpadCampaignVoteCode', origin: 'lib/launchpad-campaigns.ts',
  },
  {
    key: 'launchpad.campaign_coupon',
    trigger: 'Una campaña alcanza su meta y se emite el cupón al votante.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'launchpad',
    sender: 'sendLaunchpadCampaignCouponEmail', origin: 'lib/launchpad-campaign-automation.ts',
  },
  {
    key: 'launchpad.campaign_result',
    trigger: 'Cierra una campaña de Launchpad con resultado.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'launchpad',
    sender: 'sendLaunchpadCampaignResultEmail', origin: 'lib/launchpad-campaign-automation.ts',
  },
  {
    key: 'launchpad.campaign_voter_unmet',
    trigger: 'Cierra una campaña sin alcanzar su meta.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'launchpad',
    sender: 'sendLaunchpadCampaignVoterUnmet', origin: 'lib/launchpad-campaign-automation.ts',
  },

  // ── Events & ticketing ──────────────────────────────────────────────────────
  {
    key: 'events.verification_code',
    trigger: 'Alguien pide un código para registrarse a un evento.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'events',
    sender: 'sendEventVerificationCode', origin: 'lib/events.ts',
  },
  {
    key: 'events.registration_confirmation',
    trigger: 'Se confirma el registro a un evento.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'events',
    sender: 'sendEventRegistrationConfirmation', origin: 'lib/events.ts',
  },

  // ── Sweepstakes ─────────────────────────────────────────────────────────────
  {
    key: 'sweepstakes.verification_code',
    trigger: 'Alguien pide un código para participar en un sorteo.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'sweepstakes',
    sender: 'sendSweepstakesVerificationCode', origin: 'lib/sweepstakes.ts',
  },
  {
    key: 'sweepstakes.winner',
    trigger: 'Se sortea un ganador.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'sweepstakes',
    sender: 'sendSweepstakesWinner', origin: 'lib/sweepstakes.ts',
  },
  {
    key: 'sweepstakes.consolation',
    trigger: 'Se sortea un ganador y se avisa al resto de participantes.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'sweepstakes',
    sender: 'sendSweepstakesConsolation', origin: 'lib/sweepstakes.ts',
  },

  // ── Promoter / founding operator ────────────────────────────────────────────
  {
    key: 'promoter.application_received_to_admin',
    trigger: 'Alguien solicita entrar al programa de promotores.',
    from: 'promoter', to: 'admin', channels: ['email'], domain: 'promoter',
    sender: 'sendPromoterApplicationReceivedToAdmin', origin: 'app/api/promoter/apply/route.ts',
  },
  {
    key: 'promoter.application_approved',
    trigger: 'Miyagi aprueba una solicitud de promotor.',
    from: 'admin', to: 'promoter', channels: ['email'], domain: 'promoter',
    sender: 'sendPromoterApplicationApproved', origin: 'app/api/admin/promoter/applications/[id]/approve/route.ts',
  },
  {
    key: 'promoter.application_rejected',
    trigger: 'Miyagi rechaza una solicitud de promotor.',
    from: 'admin', to: 'promoter', channels: ['email'], domain: 'promoter',
    sender: 'sendPromoterApplicationRejected', origin: 'app/api/admin/promoter/applications/[id]/reject/route.ts',
  },
  {
    key: 'promoter.founding_operator_application_received',
    trigger: 'Alguien solicita ser operador fundador en /us.',
    from: 'promoter', to: 'admin', channels: ['email'], domain: 'promoter',
    sender: 'sendFoundingOperatorApplicationReceivedToAdmin', origin: 'app/api/promoter/apply/route.ts',
  },
  {
    key: 'promoter.founding_operator_application_rejected',
    trigger: 'Miyagi rechaza una solicitud de operador fundador.',
    from: 'admin', to: 'promoter', channels: ['email'], domain: 'promoter',
    sender: 'sendFoundingOperatorApplicationRejected', origin: 'app/api/admin/promoter/applications/[id]/reject/route.ts',
  },
  {
    key: 'promoter.founding_operator_activation_invitation',
    trigger: 'Miyagi invita a un operador fundador a activar su cuenta.',
    from: 'admin', to: 'promoter', channels: ['email'], domain: 'promoter',
    sender: 'sendFoundingOperatorActivationInvitationWithOutcome', origin: 'lib/founding-operator-activation.ts',
  },
  {
    key: 'promoter.transfer_approved',
    trigger: 'Miyagi aprueba una transferencia reportada por un promotor.',
    from: 'admin', to: 'promoter', channels: ['email'], domain: 'promoter',
    sender: 'sendPromoterTransferApproved', origin: 'app/api/admin/promoter/transfers/[id]/approve/route.ts',
  },
  {
    key: 'promoter.transfer_rejected',
    trigger: 'Miyagi rechaza una transferencia reportada por un promotor.',
    from: 'admin', to: 'promoter', channels: ['email'], domain: 'promoter',
    sender: 'sendPromoterTransferRejected', origin: 'app/api/admin/promoter/transfers/[id]/reject/route.ts',
  },
  {
    key: 'promoter.merchant_close_receipt',
    trigger: 'Un promotor cierra el alta de un comercio nuevo.',
    from: 'promoter', to: 'seller', channels: ['email'], domain: 'promoter',
    sender: 'sendMerchantCloseReceipt', origin: 'lib/promoter-close-notify.ts',
  },
  {
    key: 'promoter.preview_approval_code',
    trigger: 'Se pide al comercio un código para aprobar su vista previa.',
    from: 'promoter', to: 'seller', channels: ['email'], domain: 'promoter',
    sender: 'sendPreviewApprovalCode', origin: 'lib/preview-verification-server.ts',
  },

  // ── Referrals ───────────────────────────────────────────────────────────────
  {
    key: 'referrals.reward',
    trigger: 'Se acredita una recompensa por recomendación.',
    from: 'platform', to: 'buyer', channels: ['email'], domain: 'referrals',
    sender: 'sendReferralReward', origin: 'lib/referrals.ts',
  },

  // ── Agent / MCP ─────────────────────────────────────────────────────────────
  {
    key: 'agent.config_alert',
    trigger: 'Un agente cambia la configuración de una tienda.',
    from: 'platform', to: 'seller', channels: ['email'], domain: 'agent',
    sender: 'sendAgentConfigAlert', origin: 'lib/agent-audit.ts',
  },
] as const

/**
 * Senders that exist in `lib/email.ts` on purpose but are wired to nothing.
 *
 * This list is what stops the population guard (D2) from being a guard that rejects
 * a correct state — the failure mode `LEARNINGS.md` records as worse than missing a
 * fault, because it trains people to bypass the check. Always allow the negation of
 * what you ban. An entry here needs a reason, and an empty list is the healthy state.
 */
export const DELIBERATELY_UNWIRED: readonly { sender: string; reason: string }[] = []

// ── Pure derivations ──────────────────────────────────────────────────────────

/** Every sender the catalog accounts for, wired or deliberately not. */
export function accountedSenders(): Set<string> {
  return new Set([
    ...COMMUNICATION_CATALOG.map((entry) => entry.sender),
    ...DELIBERATELY_UNWIRED.map((entry) => entry.sender),
  ])
}

export type CommunicationFilter = {
  from?: CommunicationActor
  to?: CommunicationActor
  channel?: Channel
  domain?: CommunicationDomain
  /** Free text matched against key and trigger, case-insensitively. */
  q?: string
}

/** Narrow the catalog. An absent filter field never narrows; an empty query is the full set. */
export function filterCommunications(
  entries: readonly CommunicationEntry[],
  filter: CommunicationFilter,
): CommunicationEntry[] {
  const q = filter.q?.trim().toLowerCase()
  return entries.filter((entry) => {
    if (filter.from && entry.from !== filter.from) return false
    if (filter.to && entry.to !== filter.to) return false
    if (filter.channel && !entry.channels.includes(filter.channel)) return false
    if (filter.domain && entry.domain !== filter.domain) return false
    if (q && !`${entry.key} ${entry.trigger}`.toLowerCase().includes(q)) return false
    return true
  })
}
