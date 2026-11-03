/**
 * The plan in words (business-infrastructure D10). The model ONLY writes words; every figure is the engine's.
 *
 *   - `explainTemplate` — a deterministic es-MX explanation built from the plan. Always available; it is the fallback.
 *   - `explainPrompt`   — asks the model to say the same thing more warmly, given the plan as data.
 *   - `guardExplanation` — accepts a model text only if EVERY number in it is one the engine produced (normalised:
 *                          "$15,000", "15000" and "15 000" are the same number). Anything else → the template.
 *
 * Why so strict: a model that "rounds" a break-even, or invents a percentage, presents a guess as arithmetic — the
 * confident blank this whole bet is built to avoid.
 *
 * Pure: no I/O.
 */

import { createHash } from 'node:crypto'
import type { BusinessInputs } from './model'
import type { Move, Plan } from './engine'

const pesos = (cents: number) => `$${Math.round(cents / 100).toLocaleString('es-MX')}`

/** Every figure the engine produced, as the plain numbers a text may contain. */
export function allowedNumbers(plan: Plan): Set<string> {
  const out = new Set<string>()
  const add = (n: number | null | undefined) => { if (n != null && Number.isFinite(n)) out.add(String(Math.round(n))) }
  const addCents = (c: number | null | undefined) => { if (c != null) add(c / 100) }
  addCents(plan.fixed_cents); addCents(plan.goal_cents); addCents(plan.current_profit_cents)
  // Signed figures are WRITTEN unsigned ("te cuesta $60"); `numbersIn` never captures a minus (PR #468 review).
  if (plan.avg_contribution_cents != null) addCents(Math.abs(plan.avg_contribution_cents))
  if (plan.current_profit_cents != null) addCents(Math.abs(plan.current_profit_cents))
  add(plan.breakeven_units); add(plan.needed_units); add(plan.capacity_units); add(plan.current_units)
  for (const o of plan.offers) {
    // A title can carry digits ("Pastel 2 kg"); repeating the title is not inventing a figure.
    for (const n of numbersIn(o.title)) out.add(n)
    addCents(o.price_cents); addCents(o.cost_cents); addCents(o.contribution_cents); addCents(o.contribution_per_hour_cents)
    add(o.minutes); add(o.units_per_month)
    if (o.margin_pct != null) add(o.margin_pct * 100)
  }
  for (const m of plan.moves) {
    if (m.kind === 'reprice') { addCents(m.from_cents); addCents(m.to_cents); addCents(m.gain_per_unit_cents) }
    if (m.kind === 'pause') addCents(m.loss_per_unit_cents)
    if (m.kind === 'push') { addCents(m.contribution_cents); addCents(m.per_hour_cents) }
    if (m.kind === 'grow_demand') add(m.extra_units)
    if (m.kind === 'raise_capacity') add(m.extra_hours)
  }
  // Small counting words a sentence may need ("3 cambios", "1 mes") are not figures of the plan.
  for (let i = 0; i <= 3; i++) out.add(String(i))
  return out
}

/** The numbers a text contains, normalised: thousands separators and currency signs removed, decimals rounded. */
export function numbersIn(text: string): string[] {
  // Separators only BETWEEN digit groups of three ("15,000"), never a list ("12, 15 y 20" is three numbers).
  const found = text.match(/\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g) ?? []
  return found.map((raw) => {
    const t = raw
    // "15,000" / "15.000" thousands vs "12.5" decimals: a separator followed by exactly 3 digits is a thousands mark.
    const normalised = /^\d{1,3}([.,]\d{3})+$/.test(t) ? t.replace(/[.,]/g, '') : t.replace(/,/g, '')
    const n = Number(normalised)
    return Number.isFinite(n) ? String(Math.round(n)) : normalised
  })
}

export function guardExplanation(text: unknown, plan: Plan): string | null {
  if (typeof text !== 'string') return null
  const t = text.trim()
  if (!t || t.length > 900) return null
  const allowed = allowedNumbers(plan)
  return numbersIn(t).every((n) => allowed.has(n)) ? t : null
}

export function moveSentence(m: Move): string {
  switch (m.kind) {
    case 'reprice': return `Sube «${m.title}» de ${pesos(m.from_cents)} a ${pesos(m.to_cents)} (antes de comisiones): ganas ${pesos(m.gain_per_unit_cents)} más por pieza.`
    case 'pause': return `Pausa «${m.title}»: cada venta te cuesta ${pesos(m.loss_per_unit_cents)}.`
    case 'push': return m.per_hour_cents != null
      ? `Empuja «${m.title}»: te deja ${pesos(m.per_hour_cents)} por hora de tu límite.`
      : `Empuja «${m.title}»: te deja ${pesos(m.contribution_cents)} por venta.`
    case 'grow_demand': return `Te faltan ${m.extra_units} ventas al mes: comparte tu catálogo donde están tus compradores.`
    case 'raise_capacity': return `Con ${m.extra_hours} horas más de ${m.resource} al mes llegas a tu meta.`
    case 'fill_input': return 'Primero llena el número que falta abajo.'
  }
}

export function explainTemplate(plan: Plan): string {
  const parts: string[] = []
  const c = plan.constraint
  if (c.kind === 'inputs') parts.push('Aún no podemos decirte cuánto vender: falta un número.')
  else if (c.kind === 'losing') parts.push(c.avg_contribution_cents === 0
    ? 'Hoy, en promedio, cada venta no te deja nada: vender más no ayuda hasta cambiar precios o costos.'
    : `Hoy, en promedio, cada venta te cuesta ${pesos(Math.abs(c.avg_contribution_cents))}: vender más no ayuda hasta cambiar precios o costos.`)
  else {
    if (plan.goal_cents != null && plan.needed_units != null) parts.push(`Para ganar ${pesos(plan.goal_cents)} al mes necesitas unas ${plan.needed_units} ventas.`)
    if (plan.breakeven_units != null && plan.fixed_cents > 0) parts.push(`Con ${plan.breakeven_units} cubres tus costos fijos.`)
    if (c.kind === 'capacity') parts.push(`Tu límite solo da para ${c.capacity_units}: lo que te frena es la capacidad, no los compradores.`)
    if (c.kind === 'demand') parts.push(`Tu límite alcanza; hoy vendes ${c.current_units}: lo que te falta son compradores.`)
    if (c.kind === 'none') parts.push(`Hoy vendes ${c.current_units}: vas en camino.`)
  }
  for (const m of plan.moves) parts.push(moveSentence(m))
  return parts.join(' ')
}

export function explainPrompt(plan: Plan, shopName: string): string {
  return `Eres el asesor de negocio de Miyagi Sánchez. Explica en español de México, de tú, cálido y claro, el plan de "${shopName.replace(/["<>\n]/g, '')}" en 3 a 5 frases cortas.

REGLAS
- Usa SOLO cifras que aparecen en el texto base de abajo, escritas igual. No calcules, no redondees distinto, no agregues porcentajes ni cifras nuevas.
- No prometas resultados. No des consejos de impuestos ni de crédito.
- Devuelve solo el texto, sin títulos ni viñetas.

TEXTO BASE (los hechos; respeta sus cifras)
${explainTemplate(plan)}`
}

/** A stable hash of the inputs an explanation explains: regenerate only when they change (D10). */
export function inputsHash(inputs: BusinessInputs): string {
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 16)
}
