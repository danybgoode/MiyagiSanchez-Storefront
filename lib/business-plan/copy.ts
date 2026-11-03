/** «Tu plan» copy, es-MX (business-infrastructure S2/S3). Pure strings. */

import type { Gap, Source } from './model'

export const PLAN_COPY = {
  title: 'Tu plan',
  lead: 'Tus números y lo que te conviene hacer con ellos. Cada número dice de dónde salió; cambia los que no sean tuyos.',
  unavailable: 'No pudimos leer tu plan ahora. Inténtalo de nuevo en un momento.',
  couldNotRead: (what: Array<'products' | 'sales'>) =>
    `No pudimos leer ${what.map((w) => (w === 'products' ? 'tus productos' : 'tus ventas')).join(' ni ')} esta vez: esos números se quedan como estaban.`,
  source: { estimated: 'estimado', told: 'tuyo', measured: 'de tus ventas' } as Record<Source, string>,
  sourceHint: {
    estimated: 'Lo calculamos nosotros con tu descripción. Cámbialo por el tuyo.',
    told: 'Lo escribiste tú.',
    measured: 'Sale de tu catálogo y tus ventas.',
  } as Record<Source, string>,
  goalTitle: '¿Cuánto quieres ganar al mes?',
  goalHint: 'Lo que te quieres llevar a la bolsa, después de pagar costos.',
  offersTitle: 'Lo que vendes',
  offersEmpty: 'Aún no hay nada que vendas en tu plan. Agrega productos a tu tienda y aparecen aquí.',
  cols: { price: 'Precio', cost: 'Te cuesta', minutes: 'Minutos', units: 'Vendes al mes' },
  capacityTitle: 'Tu límite',
  capacityHint: 'El recurso que más limita cuánto puedes hacer (tu tiempo, el horno, la camioneta) y cuántas horas al mes lo tienes.',
  resourceLabel: 'Recurso',
  hoursLabel: 'Horas al mes',
  fixedTitle: 'Costos fijos al mes',
  fixedHint: 'Lo que pagas aunque no vendas: renta, luz, internet, gas.',
  addFixed: 'Agregar costo',
  removeFixed: 'Quitar',
  labelPlaceholder: 'Renta',
  save: 'Guardar mis números',
  saving: 'Guardando…',
  saved: 'Guardado',
  gapsTitle: 'Te faltan estos números',
  gap: (g: Gap): string => {
    if (g.kind === 'goal') return 'cuánto quieres ganar al mes'
    if (g.kind === 'capacity') return 'tu límite y cuántas horas al mes lo tienes'
    if (g.kind === 'price') return `el precio de «${g.title}»`
    if (g.kind === 'cost') return `cuánto te cuesta «${g.title}»`
    return `cuántos minutos te toma «${g.title}»`
  },
  saveFailed: 'No pudimos guardar ahora. Inténtalo de nuevo en un momento.',
} as const
