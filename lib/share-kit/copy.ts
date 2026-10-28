/**
 * The share kit's merchant-facing copy (es-MX), in one place so Comparte and the prompt-to-shop publish screen say
 * the same thing. The buyer-facing catalog page keeps its own copy beside its body (`CatalogBody.CATALOG_COPY`).
 */
export const SHARE_KIT_COPY = {
  catalogTitle: 'Catálogo',
  catalogLead: 'Todos tus productos en una sola página, con un botón para pedir en cada uno.',
  copy: 'Copiar',
  copied: 'Copiado',
  copiedToast: 'Enlace copiado',
  copyFailed: 'No se pudo copiar el enlace',
  whatsapp: 'Compartir por WhatsApp',
  qr: 'Descargar QR',
  open: 'Ver catálogo',
  shareText: (shopName: string) => `Mira el catálogo de ${shopName}`,
} as const
