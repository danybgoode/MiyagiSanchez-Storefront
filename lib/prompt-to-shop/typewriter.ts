/**
 * The describe box's rotating example (root-shop-builder-home follow-up, 10-29).
 *
 * The textarea's placeholder types an example out, holds it, deletes it and types the next one, so a merchant
 * who lands on `/` sees what kind of sentence to write without reading a hint. Pure: one step in, the next step and
 * how long to wait before it out — the component only owns the timer.
 */

export type TypewriterStep = {
  /** Which example is on screen. */
  line: number
  /** How many of its characters are showing. */
  chars: number
  phase: 'typing' | 'holding' | 'deleting'
}

/** Milliseconds per character typed, per character deleted, the pause on a full line, and before the next one. */
export const TYPEWRITER_TIMING = { type: 45, erase: 18, hold: 1800, gap: 350 } as const

export const TYPEWRITER_START: TypewriterStep = { line: 0, chars: 0, phase: 'typing' }

/** The text the placeholder shows for a step. */
export function typewriterText(lines: readonly string[], step: TypewriterStep): string {
  const line = lines[step.line % lines.length] ?? ''
  return line.slice(0, step.chars)
}

/** The step after `step`, and how long to wait before showing it. */
export function nextTypewriterStep(
  lines: readonly string[],
  step: TypewriterStep,
): { step: TypewriterStep; delay: number } {
  const length = (lines[step.line % lines.length] ?? '').length
  if (step.phase === 'typing') {
    if (step.chars < length) return { step: { ...step, chars: step.chars + 1 }, delay: TYPEWRITER_TIMING.type }
    return { step: { ...step, phase: 'holding' }, delay: TYPEWRITER_TIMING.hold }
  }
  if (step.phase === 'holding') return { step: { ...step, phase: 'deleting' }, delay: TYPEWRITER_TIMING.erase }
  if (step.chars > 0) return { step: { ...step, chars: step.chars - 1 }, delay: TYPEWRITER_TIMING.erase }
  return { step: { line: (step.line + 1) % lines.length, chars: 0, phase: 'typing' }, delay: TYPEWRITER_TIMING.gap }
}
