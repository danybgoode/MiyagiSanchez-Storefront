/**
 * Prompt-to-shop — the example-card illustrations (epic D10).
 *
 * One simple line drawing per catalog category, on a 64 x 64 canvas. They are deliberately drawn, flat and
 * obviously illustrative: an example card must never be mistaken for a product photo of something the merchant
 * actually sells. Typed `Record<IllustrationKey, …>` so a category added to the catalog without a drawing fails to
 * compile, and the shapes use only `currentColor` (the canvas colours them from the shop's own theme variables).
 *
 * Pure data: no JSX, so the `api` spec can walk it.
 */

import type { IllustrationKey } from './blocks'

/** A circle as a path, so every shape is a plain `d` string. */
const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`

export const ILLUSTRATIONS: Record<IllustrationKey, string[]> = {
  autos: ['M8 42V32l6-12h36l6 12v10z', 'M14 32h36', circle(20, 44, 5), circle(44, 44, 5)],
  inmuebles: ['M10 30L32 12l22 18', 'M16 28v24h32V28', 'M28 52V40h8v12'],
  electronica: ['M22 8h20a3 3 0 0 1 3 3v42a3 3 0 0 1-3 3H22a3 3 0 0 1-3-3V11a3 3 0 0 1 3-3z', 'M28 50h8'],
  hogar: ['M12 34v-6a4 4 0 0 1 4-4h32a4 4 0 0 1 4 4v6', 'M8 34h48v10H8z', 'M14 44v6M50 44v6'],
  moda: ['M22 10l-14 8 6 10 6-3v27h24V25l6 3 6-10-14-8c-2 4-6 6-10 6s-8-2-10-6z'],
  deportes: [circle(32, 32, 20), 'M12 32h40', 'M32 12c-8 6-8 34 0 40', 'M32 12c8 6 8 34 0 40'],
  servicios: ['M18 12h28v44H18z', 'M26 8h12v8H26z', 'M25 34l5 5 9-10'],
  mascotas: ['M8 32c8-12 24-14 34-4l14-8v24l-14-8c-10 10-26 8-34-4z', circle(20, 30, 1.5)],
  herramientas: ['M30 28l20 24', 'M18 14l18-4 6 12-18 4z'],
  negocios: ['M16 54V12h32v42z', 'M24 20h4M36 20h4M24 30h4M36 30h4', 'M28 54V44h8v10'],
  cursos: ['M10 14h18a4 4 0 0 1 4 4v34a4 4 0 0 0-4-4H10z', 'M54 14H36a4 4 0 0 0-4 4v34a4 4 0 0 1 4-4h18z'],
  comunidad: [circle(24, 24, 6), circle(42, 26, 5), 'M12 50c0-9 6-14 12-14s12 5 12 14', 'M38 38c8 0 14 4 14 12'],
  creatividad: ['M32 8C18 8 8 18 8 30s10 26 22 26c4 0 5-3 3-6s0-6 4-6h8c6 0 11-4 11-10C56 18 46 8 32 8z', circle(22, 28, 2), circle(32, 20, 2), circle(44, 24, 2)],
  otros: ['M10 22l22-10 22 10v22L32 54 10 44z', 'M10 22l22 10 22-10M32 32v22'],
}
