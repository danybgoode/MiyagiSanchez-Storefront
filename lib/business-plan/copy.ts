/** «Tu plan» copy, es-MX (business-infrastructure S2/S3). Pure strings. */

import type { Gap, Source } from './model'
import type { Constraint, Move } from './engine'

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
    if (g.kind === 'offers') return 'lo que vendes: agrega tus productos a tu tienda'
    if (g.kind === 'capacity') return 'tu límite y cuántas horas al mes lo tienes'
    if (g.kind === 'price') return `el precio de «${g.title}»`
    if (g.kind === 'cost') return `cuánto te cuesta «${g.title}»`
    if (g.kind === 'units') return `cuántos «${g.title}» vendes al mes`
    return `cuántos minutos te toma «${g.title}»`
  },
  saveFailed: 'No pudimos guardar ahora. Inténtalo de nuevo en un momento.',
  invalidInput: 'Revisa los números: deben ser cantidades de 0 o más, y cada costo fijo necesita nombre.',
  resourceNeeded: 'Escribe cuál es tu límite (por ejemplo «mi tiempo») para guardar sus horas.',
} as const

/** The plan summary (S3.1–S3.3). Every figure is passed in from the engine; nothing here computes. */
export const SUMMARY_COPY = {
  title: 'Lo que dice tu plan',
  needed: 'Ventas al mes para tu meta',
  breakeven: 'Para cubrir costos fijos',
  capacity: 'Lo que da tu límite',
  current: 'Vendes hoy al mes',
  profitNow: 'Te queda hoy al mes',
  movesLead: 'Lo que te conviene hacer, en orden:',
  disclaimer: 'Son cuentas con tus números, no una promesa. Si un número no es tuyo, cámbialo abajo.',
  constraint: (c: Constraint, gap: (g: Gap) => string): string => {
    if (c.kind === 'inputs') return `Para decirte cuánto vender falta: ${gap(c.gap)}.`
    if (c.kind === 'losing') return 'Hoy cada venta, en promedio, te cuesta dinero: primero precios o costos, luego volumen.'
    if (c.kind === 'capacity') return `Te frena tu capacidad: necesitas ${c.needed_units} y tu límite da ${c.capacity_units}.`
    if (c.kind === 'demand') return `Te faltan compradores: necesitas ${c.needed_units} y hoy vendes ${c.current_units}.`
    return `Vas en camino: necesitas ${c.needed_units} y hoy vendes ${c.current_units}.`
  },
  move: (m: Move, pesos: (cents: number) => string): { title: string; action: string } => {
    switch (m.kind) {
      case 'reprice': return { title: `Sube «${m.title}» de ${pesos(m.from_cents)} a ${pesos(m.to_cents)} (+${pesos(m.gain_per_unit_cents)} por pieza, antes de comisiones)`, action: 'Cambiar precio' }
      case 'pause': return { title: `Pausa «${m.title}»: cada venta te cuesta ${pesos(m.loss_per_unit_cents)}`, action: 'Abrir producto' }
      case 'push': return { title: m.per_hour_cents != null ? `Empuja «${m.title}»: ${pesos(m.per_hour_cents)} por hora de tu límite` : `Empuja «${m.title}»: ${pesos(m.contribution_cents)} por venta`, action: 'Compartir' }
      case 'grow_demand': return { title: `Consigue ${m.extra_units} ventas más al mes`, action: 'Compartir catálogo' }
      case 'raise_capacity': return { title: `${m.extra_hours} horas más al mes de ${m.resource} te llevan a tu meta`, action: 'Ajustar límite' }
      case 'fill_input': return { title: 'Llena el número que falta', action: 'Llenar' }
    }
  },
} as const

/** The monthly check-in (S3.4). Plain text pieces; the email and Telegram senders wrap them. */
export const CHECKIN_COPY = {
  subject: (shop: string, month: string) => `${shop}: tu plan de ${month}`,
  heading: (month: string) => `Así te fue en ${month}`,
  sold: (month: string, sold: number) => `En ${month} vendiste ${sold}.`,
  versus: (needed: number, sold: number) =>
    sold >= needed ? `Tu plan pedía ${needed}: llegaste. Sigue así.` : `Tu plan pide ${needed} al mes para tu meta: te faltaron ${needed - sold}.`,
  noGoal: 'Aún no le pones meta a tu plan: dinos cuánto quieres ganar al mes y te decimos cuánto vender.',
  next: 'Lo que más te conviene ahora:',
  cta: 'Ver mi plan',
  footer: 'Te escribimos una vez al mes. Puedes apagar estos avisos en Configuración › Notificaciones.',
} as const
