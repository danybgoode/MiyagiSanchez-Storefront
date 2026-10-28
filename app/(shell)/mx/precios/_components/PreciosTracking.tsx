'use client'

import Link from 'next/link'
import { useEffect, type ReactNode } from 'react'
import { pushAnalyticsEvent } from '@/lib/analytics-events'

/**
 * `/mx/precios` funnel (pricing-page D10): `precios_viewed` once per browser, then the two
 * onward clicks — into the comparador and into sign-up. The page itself stays a Server
 * Component; only these two links and the view beacon are client code.
 */
export function PreciosViewed() {
  useEffect(() => {
    pushAnalyticsEvent('precios_viewed', {}, { dedupeKey: 'precios_viewed' })
  }, [])
  return null
}

export function PreciosTrackedLink({
  href,
  event,
  className,
  testId,
  children,
}: {
  href: string
  event: 'precios_comparador_clicked' | 'precios_signup_clicked'
  className: string
  testId: string
  children: ReactNode
}) {
  return (
    <Link
      href={href}
      className={className}
      data-testid={testId}
      prefetch={false}
      onClick={() => pushAnalyticsEvent(event, { href })}
    >
      {children}
    </Link>
  )
}
