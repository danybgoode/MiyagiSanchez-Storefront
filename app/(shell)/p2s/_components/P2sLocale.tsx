'use client'

import { createContext, useContext, useMemo } from 'react'
import { builderCopy } from '@/lib/prompt-to-shop/copy-en'
import type { P2sLocale } from '@/lib/prompt-to-shop/locale'

/**
 * The builder's language for one screen (epic one-front-door-both-markets D11). The server page reads the draft's
 * `locale` and wraps its tree; every builder component asks `useBuilderCopy()`. No provider = Spanish, the platform
 * default, so a component rendered anywhere else behaves exactly as before.
 */
const Ctx = createContext<P2sLocale>('es')

export function P2sLocaleProvider({ locale, children }: { locale: P2sLocale; children: React.ReactNode }) {
  return <Ctx.Provider value={locale}>{children}</Ctx.Provider>
}

export function useP2sLocale(): P2sLocale {
  return useContext(Ctx)
}

export function useBuilderCopy() {
  const locale = useContext(Ctx)
  return useMemo(() => builderCopy(locale), [locale])
}
