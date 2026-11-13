'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { BuyerCopyText } from '@/app/components/BuyerPresentationContext'
import {
  ROOT_LANGUAGE_PATHS,
  builderLanguageRedirect,
  type RootLanguage,
} from '@/lib/root-language'

/**
 * The market selector's language control: the visible ES/EN switcher, and the
 * one-time automatic hop to whichever of the two documents the browser reads.
 *
 * A client island for the same reason `MarketRecommendation` is one — the server
 * render must read no request headers, or `/` stops being a static CDN asset and
 * cold-starts as a per-request function (`Roadmap/LEARNINGS.md`,
 * marketplace-static-shell). The server emits the switcher link and nothing else;
 * the language decision happens after hydration, in the browser that actually
 * holds the preference.
 *
 * ── Redirect, where the market badge only recommends ─────────────────────────
 * `MarketRecommendation` is emphatic that a browser signal may recommend a MARKET
 * but never choose one, because a market carries currency, payments and shipping —
 * consequences a visitor has to opt into. Language carries none of those. Sending
 * an English reader to the English telling of the same page decides nothing on
 * their behalf; leaving them on a Spanish page they cannot read decides quite a
 * lot. So this one navigates, and the two rules are consistent rather than in
 * tension: the page still asks which market, in a language the visitor can read.
 *
 * `replace`, not `push`, so the back button leaves the site instead of bouncing
 * off the document the visitor was just moved out of.
 *
 * ── An explicit click outranks the browser, permanently ──────────────────────
 * Clicking the switcher stores the choice, and a stored choice suppresses the
 * automatic hop on every later visit. Without that, a Mexican visitor on an en-US
 * laptop who switched to Spanish would be thrown back to English by the next page
 * load, and the control would read as broken. `localStorage` and not a cookie on
 * purpose: a cookie would be sent on every request to a page whose entire value is
 * being cacheable, and the server has no use for it.
 */

const CHOICE_KEY = 'ms.rootLanguage'

function readChoice(): string | null {
  try {
    return window.localStorage.getItem(CHOICE_KEY)
  } catch {
    // Private mode, a storage quota, a locked-down browser. A visitor who cannot
    // store a choice still gets a working switcher and the browser default.
    return null
  }
}

function writeChoice(language: RootLanguage): void {
  try {
    window.localStorage.setItem(CHOICE_KEY, language)
  } catch {
    // Same as above — the navigation still happens, it just is not remembered.
  }
}

export default function RootLanguageSwitch({ current }: { current: RootLanguage }) {
  const router = useRouter()
  const other: RootLanguage = current === 'es' ? 'en' : 'es'

  useEffect(() => {
    const target = builderLanguageRedirect({
      current,
      // `languages` is the ordered list the visitor actually configured;
      // `language` alone is the single top entry, and older browsers have only it.
      languages: navigator.languages?.length ? navigator.languages : [navigator.language],
      chosen: readChoice(),
    })
    if (target) router.replace(target)
  }, [current, router])

  return (
    <Link
      href={ROOT_LANGUAGE_PATHS[other]}
      data-testid={`root-language-${other}`}
      hrefLang={other}
      onClick={() => writeChoice(other)}
      style={{
        fontSize: 12,
        color: 'var(--fg-muted)',
        textDecoration: 'underline',
        textUnderlineOffset: 3,
      }}
    >
      <BuyerCopyText copyKey="page.languageSwitch" />
    </Link>
  )
}
