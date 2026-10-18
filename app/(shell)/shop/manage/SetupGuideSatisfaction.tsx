'use client'

import { useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'

/**
 * golden-frijoles satisfied-ask — once the five setup steps are done, ask the merchant once whether the guide helped.
 * The answer goes to POST /api/growth/satisfaction, which claims `metadata.settings.guide.satisfaction_answered` on the
 * merchant's own shop and only then forwards it to Golden Frijoles as its standard rating (`rateSatisfaction`). The
 * server owns "asked once": a repeat answers 409 and sends nothing. "Ahora no" counts as an answer.
 *
 * ⚠️ The in-flight lock is local state: a double tap must not send two ratings.
 */
const SCORES = [1, 2, 3, 4, 5] as const

export default function SetupGuideSatisfaction() {
  const [state, setState] = useState<'asking' | 'sending' | 'thanks' | 'gone'>('asking')

  async function answer(value: (typeof SCORES)[number] | 'dismissed') {
    if (state !== 'asking') return
    setState('sending')
    // Whatever the outcome, the card leaves: asking again in the same view would read as the tap not working, and the
    // server already decided whether this merchant can still be asked (the page reads its claim on the next load).
    await fetch('/api/growth/satisfaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: 'setup_guide', answer: value }),
    }).catch(() => {})
    setState(value === 'dismissed' ? 'gone' : 'thanks')
  }

  if (state === 'gone') return null
  if (state === 'thanks') {
    return (
      <Card variant="panel" className="mb-8 p-5">
        <p className="text-sm text-[var(--color-muted)]">¡Gracias! Nos ayuda a mejorar la guía.</p>
      </Card>
    )
  }

  const busy = state === 'sending'
  return (
    <Card variant="panel" className="mb-8 p-5">
      <h2 className="font-bold text-base mb-1">Tu tienda está lista</h2>
      <p className="text-sm text-[var(--color-muted)] mb-3">
        ¿Qué tanto te ayudó la guía a ponerla en marcha? 1 es nada, 5 es mucho.
      </p>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Califica la guía del 1 al 5">
        {SCORES.map((score) => (
          <Button key={score} type="button" size="sm" loading={busy} onClick={() => void answer(score)}>
            {score}
          </Button>
        ))}
        <Button type="button" variant="ghost" size="sm" loading={busy} onClick={() => void answer('dismissed')}>
          Ahora no
        </Button>
      </div>
    </Card>
  )
}
