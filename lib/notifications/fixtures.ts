/**
 * lib/notifications/fixtures.ts
 *
 * A realistic sample payload for every email in the communications catalog
 * (marketplace-communications · S3.1).
 *
 * ── WHY FIXTURES AND NOT A RENDER-ONLY MODE ───────────────────────────────────
 * A template that compiles is not a template that arrives. Resend rejects on `from`
 * domain misconfiguration, on spam heuristics, and on HTML that renders fine locally
 * and badly in a mail client. So the sample path calls the REAL sender, which builds
 * the real subject and body and goes through the real transport — the only way the
 * thing the product owner sees in his inbox is the thing a merchant would get.
 *
 * ── EVERY FIXTURE IS OBVIOUSLY FAKE ───────────────────────────────────────────
 * Names, shops and amounts here are invented and read as invented. A sample must
 * never be mistakable for a real order six months from now — the `[PRUEBA]` subject
 * prefix and the banner do most of that work (see `lib/notifications/sample.ts`),
 * and the data doing it too is the belt to that braces.
 *
 * ── THE RECIPIENT IS ALWAYS THE CALLER'S ──────────────────────────────────────
 * Every fixture takes `to` and puts it in whichever recipient field that sender
 * reads. No fixture carries a hardcoded destination address, so there is no way for
 * one to send somewhere unintended even if the allow-list above it were bypassed.
 */
import * as email from '@/lib/email'

/**
 * Renders and sends one communication with sample data.
 *
 * The return is deliberately loose: most senders resolve to `void`, and the four
 * scheduled reminders resolve to a Resend id so their delivery can be cancelled
 * later. The sample path does not read either — it reports on whether the call threw
 * — so narrowing this would buy nothing and force casts at four call sites.
 */
export type CommunicationFixture = (to: string) => Promise<unknown>

const URL = 'https://miyagisanchez.com'
const LISTING = `${URL}/mx/l/prod_muestra`
const ORDER = `${URL}/compras/order_muestra`
const SHOP = 'Tienda de Muestra'
const BUYER = 'Ana Muestra'
const SELLER_SHOP = 'Bazar Ejemplo'

/** An hour from now, formatted the way the senders expect (ISO). */
const soon = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()

const offerCtx = (to: string) => ({
  listingTitle: 'Cámara analógica Pentax K1000',
  listingId: 'prod_muestra',
  listingUrl: LISTING,
  askingPrice: '$3,200.00 MXN',
  offerAmount: '$2,650.00 MXN',
  offerPct: 83,
  buyerName: BUYER,
  buyerEmail: to,
  buyerMessage: 'Me interesa mucho, ¿aceptarías esta oferta?',
  currency: 'MXN',
  offerId: 'ofr_muestra',
  expiresAt: soon(),
  conversationUrl: `${URL}/messages/conv_muestra`,
})

/**
 * key → fixture. The key is the catalog's, so the population guard can assert the
 * two agree and neither can silently grow past the other.
 */
export const COMMUNICATION_FIXTURES: Record<string, CommunicationFixture> = {
  'account.welcome': (to) => email.sendAccountWelcome({ to, clerkUserId: 'sample_user' }),
  'shop.p2s_draft_link': (to) => email.sendP2sDraftLink({ to, shopName: SHOP, draftId: '00000000-0000-4000-8000-000000000000', sharePath: '/p2s/v/00000000-0000-4000-8000-000000000001' }),
  'shop.claim_link_requested': (to) => email.sendShopClaimLink({ to, shopName: SHOP, claimUrl: 'https://miyagisanchez.com/claim?token=sample', market: 'mx' }),
  'shop.claimed_welcome': (to) => email.sendShopClaimedWelcome({ to, shopName: SHOP, shopSlug: 'tienda-de-muestra', market: 'mx', sellerId: 'sample_seller' }),
  'shop.created_welcome.mx': (to) => email.sendShopCreatedWelcome({ to, shopName: SHOP, shopSlug: 'tienda-de-muestra', market: 'mx', sellerId: 'sample_created_mx' }),
  'shop.created_welcome.us': (to) => email.sendShopCreatedWelcome({ to, shopName: 'Sample Shop', shopSlug: 'sample-shop', market: 'us', sellerId: 'sample_created_us' }),
  // ── Offers ──────────────────────────────────────────────────────────────────
  'offer.confirmed_to_buyer': (to) => email.sendOfferConfirmed(offerCtx(to)),
  'offer.new_to_seller': (to) => email.sendNewOfferToSeller({ ...offerCtx(to), sellerEmail: to }),
  'offer.accepted': (to) => email.sendOfferAccepted({
    ...offerCtx(to),
    checkoutUrl: `${URL}/checkout/muestra`,
    checkoutExpiresAt: soon(),
    sellerPhone: '+52 55 1234 5678',
  }),
  'offer.declined': (to) => email.sendOfferDeclined({
    listingTitle: 'Cámara analógica Pentax K1000',
    listingUrl: LISTING,
    askingPrice: '$3,200.00 MXN',
    offerAmount: '$2,650.00 MXN',
    buyerEmail: to,
    buyerName: BUYER,
  }),
  'offer.countered': (to) => email.sendOfferCountered({
    ...offerCtx(to),
    counterAmount: '$2,950.00 MXN',
    counterPct: 92,
    counterMessage: 'Te la dejo en este precio.',
    counterExpiresAt: soon(),
  }),
  'offer.counter_accepted': (to) => email.sendCounterAccepted({
    sellerEmail: to,
    listingTitle: 'Cámara analógica Pentax K1000',
    listingUrl: LISTING,
    counterAmount: '$2,950.00 MXN',
    buyerName: BUYER,
    buyerEmail: to,
    conversationUrl: `${URL}/messages/conv_muestra`,
  }),
  'offer.withdrawn': (to) => email.sendOfferWithdrawn({
    sellerEmail: to,
    listingTitle: 'Cámara analógica Pentax K1000',
    listingUrl: LISTING,
    offerAmount: '$2,650.00 MXN',
    buyerName: BUYER,
  }),
  'offer.seller_reminder': (to) => email.sendSellerOfferReminder({
    sellerEmail: to,
    listingTitle: 'Cámara analógica Pentax K1000',
    listingUrl: LISTING,
    offerAmount: '$2,650.00 MXN',
    offerPct: 83,
    buyerName: BUYER,
    expiresAt: soon(),
  }),
  'offer.seller_expiry_warning': (to) => email.sendSellerExpiryWarning({
    sellerEmail: to,
    listingTitle: 'Cámara analógica Pentax K1000',
    listingUrl: LISTING,
    offerAmount: '$2,650.00 MXN',
    offerPct: 83,
    buyerName: BUYER,
    expiresAt: soon(),
  }),
  'offer.buyer_counter_expiry_warning': (to) => email.sendBuyerCounterExpiryWarning({
    buyerEmail: to,
    listingTitle: 'Cámara analógica Pentax K1000',
    listingUrl: LISTING,
    counterAmount: '$2,950.00 MXN',
    expiresAt: soon(),
    conversationUrl: `${URL}/messages/conv_muestra`,
  }),
  'offer.buyer_payment_expiry_warning': (to) => email.sendBuyerPaymentExpiryWarning({
    buyerEmail: to,
    listingTitle: 'Cámara analógica Pentax K1000',
    checkoutUrl: `${URL}/checkout/muestra`,
    agreedAmount: '$2,950.00 MXN',
    expiresAt: soon(),
  }),

  // ── Orders ──────────────────────────────────────────────────────────────────
  'order.confirmed_to_buyer': (to) => email.sendOrderConfirmedToBuyer({
    buyerEmail: to,
    buyerName: BUYER,
    listingTitle: 'Suéter tejido a mano',
    listingUrl: LISTING,
    amountPaid: '$890.00 MXN',
    shopName: SELLER_SHOP,
    isDigital: false,
  }),
  'order.sale_completed_to_seller': (to) => email.sendSaleCompletedToSeller({
    sellerEmail: to,
    listingTitle: 'Suéter tejido a mano',
    listingUrl: LISTING,
    amountPaid: '$890.00 MXN',
    buyerName: BUYER,
    buyerEmail: to,
    isDigital: false,
  }),
  'order.new_to_seller': (to) => email.sendNewOrderToSeller({
    sellerEmail: to,
    listingTitle: 'Suéter tejido a mano',
    listingUrl: LISTING,
    amountPaid: '$890.00 MXN',
    buyerName: BUYER,
    buyerEmail: to,
    shippingAddress: {
      nombre: BUYER,
      calle: 'Av. Ejemplo 123, Int. 4',
      colonia: 'Roma Norte',
      ciudad: 'Ciudad de México',
      cp: '06700',
    },
    orderId: 'order_muestra',
    orderUrl: ORDER,
  }),
  'order.coordinated_to_buyer': (to) => email.sendCoordinatedOrderToBuyer({
    buyerEmail: to,
    buyerName: BUYER,
    listingTitle: 'Mesa de centro restaurada',
    listingUrl: LISTING,
    amountPaid: '$4,500.00 MXN',
    shopName: SELLER_SHOP,
    orderUrl: ORDER,
  }),
  'order.coordinated_to_seller': (to) => email.sendCoordinatedOrderToSeller({
    sellerEmail: to,
    listingTitle: 'Mesa de centro restaurada',
    listingUrl: LISTING,
    amountPaid: '$4,500.00 MXN',
    buyerName: BUYER,
    buyerEmail: to,
    shopName: SELLER_SHOP,
    orderId: 'order_muestra',
    orderUrl: ORDER,
  }),
  'order.pickup_to_buyer': (to) => email.sendPickupOrderToBuyer({
    buyerEmail: to,
    buyerName: BUYER,
    listingTitle: 'Pan de masa madre',
    listingUrl: LISTING,
    amountPaid: '$120.00 MXN',
    shopName: SELLER_SHOP,
    pickupAddress: 'Av. Ejemplo 123, Roma Norte, CDMX',
    pickupInstructions: 'Toca el timbre 4B. Horario de 10 a 18 h.',
    sellerPhone: '+52 55 1234 5678',
    orderUrl: ORDER,
  }),
  'order.pickup_to_seller': (to) => email.sendPickupOrderToSeller({
    sellerEmail: to,
    listingTitle: 'Pan de masa madre',
    listingUrl: LISTING,
    amountPaid: '$120.00 MXN',
    buyerName: BUYER,
    buyerEmail: to,
    shopName: SELLER_SHOP,
    orderUrl: ORDER,
  }),
  'order.manual_to_buyer': (to) => email.sendManualOrderToBuyer({
    buyerEmail: to,
    buyerName: BUYER,
    listingTitle: 'Bicicleta urbana',
    listingUrl: LISTING,
    amountToPay: '$6,800.00 MXN',
    shopName: SELLER_SHOP,
    manualPayment: {
      spei: { clabe: '012345678901234567', bank_name: 'Banco Ejemplo', account_holder: 'Bazar Ejemplo SA de CV' },
    },
    orderUrl: ORDER,
  }),
  'order.manual_to_seller': (to) => email.sendManualOrderToSeller({
    sellerEmail: to,
    listingTitle: 'Bicicleta urbana',
    listingUrl: LISTING,
    amount: '$6,800.00 MXN',
    buyerName: BUYER,
    buyerEmail: to,
    shopName: SELLER_SHOP,
    orderUrl: ORDER,
  }),
  'order.buyer_reported_payment': (to) => email.sendBuyerReportedPaymentToSeller({
    sellerEmail: to,
    listingTitle: 'Bicicleta urbana',
    buyerEmail: to,
    orderUrl: ORDER,
  }),
  'difusion.platform_broadcast': (to) => email.sendPlatformBroadcast({
    to,
    subject: 'Aviso de la plataforma',
    headline: 'Un aviso del equipo de Miyagi Sánchez',
    paragraphs: [
      'Así se ve un aviso operativo enviado desde Difusión.',
      'El texto lo escribe quien lo envía; el diseño es el mismo de siempre.',
    ],
    ctaLabel: 'Ir a mi tienda',
    ctaUrl: `${URL}/shop/manage`,
  }),
  'mensajes.conversation_message': (to) => email.sendConversationMessage({
    to,
    recipientRole: 'seller',
    listingTitle: 'Bicicleta urbana',
    messageText: '¿Sigue disponible? ¿Aceptas una oferta?',
    conversationUrl: `${URL}/messages/00000000-0000-0000-0000-000000000000`,
  }),
  'order.ml_event_to_seller': (to) => email.sendMlOrderEventToSeller({
    sellerEmail: to,
    subject: 'Venta nueva en Mercado Libre',
    headline: 'Se vendió “Suéter tejido a mano” en Mercado Libre',
    note: 'El stock ya se descontó en Miyagi. Revisa el pedido para preparar el envío.',
    orderUrl: ORDER,
  }),

  // ── Shipping ────────────────────────────────────────────────────────────────
  'shipping.order_shipped': (to) => email.sendOrderShipped({
    buyerEmail: to,
    buyerName: BUYER,
    listingTitle: 'Suéter tejido a mano',
    orderUrl: ORDER,
    carrier: 'Estafeta',
    trackingNumber: '1234567890',
    estimatedDelivery: 'martes 19 de agosto',
    shopName: SELLER_SHOP,
  }),
  'shipping.order_delivered': (to) => email.sendOrderDelivered({
    buyerEmail: to,
    buyerName: BUYER,
    listingTitle: 'Suéter tejido a mano',
    orderUrl: ORDER,
    shopName: SELLER_SHOP,
  }),

  // ── Returns ─────────────────────────────────────────────────────────────────
  'return.requested_to_seller': (to) => email.sendReturnRequestToSeller({
    sellerEmail: to,
    shopName: SELLER_SHOP,
    buyerName: BUYER,
    buyerEmail: to,
    listingTitle: 'Suéter tejido a mano',
    reason: 'No es lo que esperaba',
    description: 'La talla es más chica de lo indicado.',
    orderUrl: ORDER,
  }),
  'return.requested_confirmed_to_buyer': (to) => email.sendReturnRequestConfirmedToBuyer({
    buyerEmail: to,
    buyerName: BUYER,
    listingTitle: 'Suéter tejido a mano',
    shopName: SELLER_SHOP,
    orderUrl: ORDER,
  }),
  'return.accepted': (to) => email.sendReturnAcceptedToBuyer({
    buyerEmail: to,
    buyerName: BUYER,
    listingTitle: 'Suéter tejido a mano',
    shopName: SELLER_SHOP,
    refundAmount: '$890.00 MXN',
    isPartial: false,
    sellerNote: 'Sin problema, te reembolso en cuanto reciba la pieza.',
    orderUrl: ORDER,
  }),
  'return.declined': (to) => email.sendReturnDeclinedToBuyer({
    buyerEmail: to,
    buyerName: BUYER,
    listingTitle: 'Suéter tejido a mano',
    shopName: SELLER_SHOP,
    sellerNote: 'La pieza se envió como se describe y ya pasó el plazo.',
    orderUrl: ORDER,
  }),
  'return.refund_transfer_sent': (to) => email.sendRefundTransferSentToBuyer({
    buyerEmail: to,
    buyerName: BUYER,
    listingTitle: 'Suéter tejido a mano',
    shopName: SELLER_SHOP,
    refundAmount: '$890.00 MXN',
    sellerNote: 'Transferencia enviada hoy por SPEI.',
    orderUrl: ORDER,
  }),

  // ── Print edition ───────────────────────────────────────────────────────────
  'print.ad_received_to_buyer': (to) => email.sendPrintAdReceivedToBuyer({
    buyerEmail: to,
    buyerName: BUYER,
    editionTitle: 'El Barrio · Número 04',
    providerName: 'Imprenta Ejemplo',
    tierLabel: 'Media página',
    amountPaid: '$2,400.00 MXN',
    submissionDeadline: '30 de agosto',
    distributionDate: '15 de septiembre',
    manageUrl: `${URL}/impreso/muestra`,
  }),
  'print.ad_received_to_miyagi': (to) => email.sendPrintAdReceivedToMiyagi({
    adminEmail: to,
    editionTitle: 'El Barrio · Número 04',
    tierLabel: 'Media página',
    sellerName: SELLER_SHOP,
    buyerEmail: to,
    amountPaid: '$2,400.00 MXN',
    ctaUrl: LISTING,
    photosCount: 3,
    adminUrl: `${URL}/admin/print`,
  }),
  'print.ad_payment_pending': (to) => email.sendPrintAdPaymentPending({
    buyerEmail: to,
    buyerName: BUYER,
    editionTitle: 'El Barrio · Número 04',
    tierLabel: 'Media página',
    amountDue: '$2,400.00 MXN',
    manual: { spei: { clabe: '012345678901234567', bank_name: 'Banco Ejemplo', account_holder: 'Miyagi Sánchez' } },
    submissionDeadline: '30 de agosto',
    manageUrl: `${URL}/impreso/muestra`,
  }),
  'print.ad_approved': (to) => email.sendPrintAdApproved({
    buyerEmail: to,
    buyerName: BUYER,
    editionTitle: 'El Barrio · Número 04',
    tierLabel: 'Media página',
    distributionDate: '15 de septiembre',
    manageUrl: `${URL}/impreso/muestra`,
  }),
  'print.ad_rejected': (to) => email.sendPrintAdRejected({
    buyerEmail: to,
    buyerName: BUYER,
    editionTitle: 'El Barrio · Número 04',
    tierLabel: 'Media página',
    reason: 'La imagen no tiene la resolución mínima para impresión.',
    manageUrl: `${URL}/impreso/muestra`,
  }),
  'print.payment_reported_to_miyagi': (to) => email.sendPrintPaymentReportedToMiyagi({
    adminEmail: to,
    editionTitle: 'El Barrio · Número 04',
    tierLabel: 'Media página',
    buyerEmail: to,
    amount: '$2,400.00 MXN',
    adminUrl: `${URL}/admin/print`,
  }),
  'print.payment_reported_to_buyer': (to) => email.sendPrintPaymentReportedToBuyer({
    buyerEmail: to,
    buyerName: BUYER,
    editionTitle: 'El Barrio · Número 04',
    manageUrl: `${URL}/impreso/muestra`,
  }),
  'print.social_received': (to) => email.sendPrintSocialReceived({
    toEmail: to,
    caption: 'Nueva colección de cerámica, disponible este fin de semana.',
    mineUrl: `${URL}/impreso/social/muestra`,
  }),

  // ── Launchpad ───────────────────────────────────────────────────────────────
  'launchpad.verification_code': (to) => email.sendLaunchpadVerificationCode({ to, code: '482913', shopName: SHOP }),
  'launchpad.status': (to) => email.sendLaunchpadStatusEmail({
    to, authorName: 'Autor de Muestra', title: 'Cuentos del barrio', shopName: SHOP,
    status: 'in_review', note: 'Lo estamos leyendo esta semana.',
  }),
  'launchpad.published': (to) => email.sendLaunchpadPublishedEmail({
    to, authorName: 'Autor de Muestra', title: 'Cuentos del barrio', shopName: SHOP, url: LISTING,
  }),
  'launchpad.campaign_vote_code': (to) => email.sendLaunchpadCampaignVoteCode({ to, code: '739104', campaignTitle: 'Cuentos del barrio' }),
  'launchpad.campaign_coupon': (to) => email.sendLaunchpadCampaignCouponEmail({
    to, campaignTitle: 'Cuentos del barrio', couponCode: 'MUESTRA20', percent: 20, productUrl: LISTING, expiresAt: soon(),
  }),
  'launchpad.campaign_result': (to) => email.sendLaunchpadCampaignResultEmail({
    to, campaignTitle: 'Cuentos del barrio', met: true, voteCount: 128, threshold: 100, couponCode: 'MUESTRA20',
  }),
  'launchpad.campaign_voter_unmet': (to) => email.sendLaunchpadCampaignVoterUnmet({ to, campaignTitle: 'Cuentos del barrio' }),

  // ── Events & ticketing ──────────────────────────────────────────────────────
  'events.verification_code': (to) => email.sendEventVerificationCode({
    to, code: '204815', locale: 'es', eventTitle: 'Taller de cerámica', eventUrl: LISTING,
  }),
  'events.registration_confirmation': (to) => email.sendEventRegistrationConfirmation({
    to, locale: 'es', eventTitle: 'Taller de cerámica', eventUrl: LISTING,
    startsAt: soon(), venueName: 'Casa Ejemplo', venueAddress: 'Av. Ejemplo 123, Roma Norte, CDMX',
  }),

  // ── Sweepstakes ─────────────────────────────────────────────────────────────
  'sweepstakes.verification_code': (to) => email.sendSweepstakesVerificationCode({
    to, code: '618402', locale: 'es', campaignTitle: 'Sorteo de muestra', campaignUrl: LISTING,
  }),
  'sweepstakes.winner': (to) => email.sendSweepstakesWinner({
    to, locale: 'es', campaignTitle: 'Sorteo de muestra', campaignUrl: LISTING,
  }),
  'sweepstakes.consolation': (to) => email.sendSweepstakesConsolation({
    to, locale: 'es', campaignTitle: 'Sorteo de muestra', campaignUrl: LISTING,
    message: 'Gracias por participar. La próxima puede ser la tuya.',
    couponCode: 'GRACIAS10',
  }),

  // ── Promoter / founding operator ────────────────────────────────────────────
  'promoter.application_received_to_admin': (to) => email.sendPromoterApplicationReceivedToAdmin({
    adminEmail: to, name: 'Promotor de Muestra', email: to, whatsapp: '+52 55 1234 5678',
    city: 'Ciudad de México', motivation: 'Conozco muchos comercios en mi colonia.',
    adminUrl: `${URL}/admin/promoter`,
  }),
  'promoter.application_approved': (to) => email.sendPromoterApplicationApproved({
    to, name: 'Promotor de Muestra', code: 'MUESTRA', bindUrl: `${URL}/promotor/vincular`,
  }),
  'promoter.application_rejected': (to) => email.sendPromoterApplicationRejected({ to, name: 'Promotor de Muestra' }),
  'promoter.founding_operator_application_received': (to) => email.sendFoundingOperatorApplicationReceivedToAdmin({
    adminEmail: to, adminUrl: `${URL}/admin/promoter`,
  }),
  'promoter.founding_operator_application_rejected': (to) => email.sendFoundingOperatorApplicationRejected({
    to, name: 'Operator Sample', locale: 'en',
  }),
  'promoter.founding_operator_activation_invitation': (to) => email.sendFoundingOperatorActivationInvitationWithOutcome({
    to, name: 'Operator Sample', activationUrl: `${URL}/us/operators/activate`, expiresAt: soon(), locale: 'en',
  }).then(() => undefined),
  'promoter.transfer_approved': (to) => email.sendPromoterTransferApproved({
    to, skuLabel: 'Dominio propio', owedMxn: '$1,200.00 MXN',
  }),
  'promoter.transfer_rejected': (to) => email.sendPromoterTransferRejected({
    to, skuLabel: 'Dominio propio', reason: 'No encontramos la transferencia en el estado de cuenta.',
  }),
  'promoter.merchant_close_receipt': (to) => email.sendMerchantCloseReceipt({
    to, shopName: SELLER_SHOP,
    items: [
      { label: 'Alta de tienda', amountMxn: null },
      { label: 'Dominio propio (12 meses)', amountMxn: '$1,200.00 MXN', note: 'Pagado por adelantado' },
    ],
    claimUrl: `${URL}/reclamar/muestra`,
    toMerchantDirectly: true,
  }),
  'promoter.preview_approval_code': (to) => email.sendPreviewApprovalCode({ to, code: '905172', shopName: SELLER_SHOP }),

  // ── Referrals ───────────────────────────────────────────────────────────────
  'referrals.reward': (to) => email.sendReferralReward(to, 'MUESTRA50', '$50.00 MXN'),

  // ── Agent / MCP ─────────────────────────────────────────────────────────────
  'agent.config_alert': (to) => email.sendAgentConfigAlert({
    to, shopName: SELLER_SHOP,
    blocks: ['checkout', 'support'],
    sensitive: ['escrow_mode'],
  }),
}

/** Keys with a fixture. Used by the population guard and the admin surface. */
export function fixtureKeys(): string[] {
  return Object.keys(COMMUNICATION_FIXTURES)
}
