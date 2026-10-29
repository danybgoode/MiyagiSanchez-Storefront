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
  pdfTitle: 'Catálogo PDF',
  pdfLead: 'Tus productos con fotos, precios y un código QR en cada uno, listo para reenviar.',
  pdfDownload: 'Descargar',
  pdfPreparing: 'Preparando tu PDF…',
  pdfShareText: (shopName: string) => `Catálogo de ${shopName} (PDF)`,
} as const

/** The printed catalog's words (share-kit S2.2). */
export const CATALOG_PRINT_COPY = {
  subtitle: (count: number) => `Catálogo · ${count} producto${count === 1 ? '' : 's'}`,
  closing: (shopName: string) => `Pide a ${shopName}`,
  whatsapp: (digits: string) => `WhatsApp: +${digits}`,
} as const
