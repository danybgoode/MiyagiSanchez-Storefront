'use client'

import { useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { useSettingsSave } from './settings/_components/useSettingsSave'

/**
 * golden-frijoles satisfied-ask — once the five setup steps are done, ask the merchant once whether the guide helped.
 * The answer goes to Golden Frijoles as its standard rating (POST /api/growth/satisfaction → `rateSatisfaction`), and
 * `metadata.settings.guide.satisfaction_answered` is saved through the same PATCH seam as `guide_dismissed`, so the
 * ask never comes back on another device. "Ahora no" counts as an answer: asked once, never nagged.
 *
 * ⚠️ The in-flight lock is local state: a double tap must not send two ratings.
 */
const SCORES = [1, 2, 3, 4, 5] as const

export default function SetupGuideSatisfaction() {
  const { save } = useSettingsSave()
  const [state, setState] = useState<'asking' | 'sending' | 'thanks' | 'gone'>('asking')

  async function answer(value: (typeof SCORES)[number] | 'dismissed') {
    if (state !== 'asking') return
    setState('sending')
    // Telemetry is fire-and-forget (the route no-ops when growth.telemetry_enabled is off); the saved flag is what
    // stops the ask, so it is the one we wait for.
    fetch('/api/growth/satisfaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureId: 'setup_guide', answer: value }),
    }).catch(() => {})
    await save({ settings: { guide: { satisfaction_answered: true } } })
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
