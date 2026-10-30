'use client'

import Link from 'next/link'
import { ROOT_LANGUAGE_PATHS } from '@/lib/root-language'

/**
 * The strip's "English" link on `/` — a client island because the click must STORE the choice.
 *
 * `/en` still runs `RootLanguageSwitch`, which moves a Spanish-language browser back to `/`
 * unless a choice is stored under `ms.rootLanguage`. A plain link therefore bounced every es-MX
 * phone straight back to the page it came from (the fresh reviewer on Storefront PR 454 caught it): the
 * link looked dead. Writing the same key the switcher writes makes this a real choice, and `/en`
 * itself is untouched (product-owner decision 10-29).
 *
 * The key is spelled here rather than imported because `RootLanguageSwitch` keeps it private and
 * `/en` is out of scope; `e2e/root-language.spec.ts` pins that both files spell it the same.
 */
const CHOICE_KEY = 'ms.rootLanguage'

export default function RootEnglishLink({ label, style }: { label: string; style?: React.CSSProperties }) {
  return (
    <Link
      href={ROOT_LANGUAGE_PATHS.en}
      hrefLang="en"
      data-testid="root-market-link-en"
      prefetch={false}
      style={style}
      onClick={() => {
        try {
          window.localStorage.setItem(CHOICE_KEY, 'en')
        } catch {
          // Storage blocked: the link still navigates; `/en` may hop a Spanish browser back.
        }
      }}
    >
      {label}
    </Link>
  )
}
