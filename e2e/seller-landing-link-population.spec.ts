import { test, expect } from '@playwright/test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { SELLER_LANDING_PATHS } from '../lib/seller-acquisition'

/**
 * Seller-landing link population — guards the claim `SELLER_LANDING_PATHS` makes.
 *
 * `one-landing-per-market` moved the Spanish seller family from `/vende` to
 * `/mx/vende` and stated that `SELLER_LANDING_PATHS` is "the one place that knows
 * where a market recruits, and every call site reads it". Nothing enforced that,
 * and three call sites did not read it — each found by hand, one at a time:
 *
 *   · `app/(shell)/agent/page.tsx`      — the absolute seller CTA agents copy out
 *                                         of the page, still `${ENDPOINT}/vende`.
 *   · `app/(shell)/admin/promoter/…`    — the promoter share link, MINTED fresh and
 *                                         then printed, still `${siteUrl}/vende`.
 *   · `app/(us-site)/us/operators/…`    — the Promotor cross-link, still
 *                                         `/vende/promotor`.
 *
 * All three "worked" — `next.config.ts` 308s `/vende/:path*` with the query intact —
 * which is exactly why no route test caught them and why a guard has to read the
 * SOURCE rather than follow a link. A redirect is invisible to a passing spec.
 *
 * What this bans is narrow on purpose: a `/vende` path used as a LINK TARGET. Prose
 * keeps its history — a dozen JSDoc comments explain why the `/vende` family looks the
 * way it does, and one Golden flag description (frozen in an applied migration, so the
 * TS copy cannot drift from it unilaterally) names `/vende/fundadoras` in a sentence.
 * A guard that made those unwriteable would be deleted as noise the first time someone
 * documented the move. So: comments are stripped, and a literal containing WHITESPACE
 * is a sentence, not a URL. The negation of the ban is always available — write
 * `/mx/vende/<persona>`, or read `SELLER_LANDING_PATHS`.
 *
 * ── root-shop-builder-home (2026-10-29): the landing moved again, to `/` ─────────
 * The Mexican anchor landing is now the bare domain, and `/mx/vende` is itself a 308.
 * Two things changed here because of it, and the second is the one that matters:
 *
 *   · a bare `/mx/vende` link target is now stale too (persona pages under
 *     `/mx/vende/<persona>` did not move and stay allowed);
 *   · the old exemption `literal.includes(SELLER_LANDING_PATHS.mx)` was DELETED. With the
 *     landing at `/`, every URL "includes" it, so that one line would have exempted every
 *     literal and left this guard green while checking nothing at all.
 */

const ROOT = path.resolve(import.meta.dirname, '..')
const SCAN_ROOTS = ['app', 'lib']

/**
 * `/api/vende/fundadoras/apply` is a different namespace that did NOT move — the API
 * route keeps its own path. Anchoring the pattern on a non-`/api` boundary keeps the
 * guard from demanding a rename that would break a live form POST.
 */
const STALE_LANDING = /(?<!\/api)(?<!\/mx)\/vende(?![a-z0-9-])/i

/** The bare anchor landing at its 2026-08 address — a 308 to `/` now. Sub-paths are allowed. */
const STALE_MX_ANCHOR = /\/mx\/vende(?![\/a-z0-9-])/i

/**
 * The one file allowed to spell the persona family's base: it is where `MX_SELLER_PAGES_BASE`
 * is defined, and the persona URLs are built from it. Everything else reads the constant.
 */
const DEFINING_FILE = 'lib/seller-acquisition.ts'

function sourceFilesBelow(relativeDir: string): string[] {
  const out: string[] = []
  const walk = (absolute: string) => {
    for (const entry of readdirSync(absolute)) {
      const child = path.join(absolute, entry)
      if (statSync(child).isDirectory()) walk(child)
      else if (/\.(?:ts|tsx)$/.test(entry)) out.push(child)
    }
  }
  walk(path.join(ROOT, relativeDir))
  return out
}

/** Blanks comment bodies, preserving offsets so reported line numbers stay true. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    // `(?<!:)`: the `//` in `https://` is a URL, not a comment. Without it every absolute link
    // was blanked before the scan saw it (fresh reviewer on PR #454 reproduced the miss).
    .replace(/(?<!:)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))
}

/** String and template literals only — a link target, never prose. */
function stringLiteralsIn(line: string): string[] {
  return (line.match(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g) ?? []).map((s) => s.slice(1, -1))
}

/** The single predicate both the sweep and its fixture test call. */
function isStaleLandingLink(literal: string): boolean {
  // The bare old anchor is stale even inside a sentence. The prose exemption below exists
  // for HISTORY about the `/vende` family; a string literal that still names `/mx/vende`
  // is an agent prompt or report text telling someone where to go — three of those
  // (`agent-prompt.ts`, `setup-spec.ts`, `cost-comparator-report.ts`) slipped past the
  // whitespace exemption on the first sweep of this move.
  if (STALE_MX_ANCHOR.test(literal)) return true
  if (!STALE_LANDING.test(literal)) return false
  if (/\s/.test(literal)) return false
  return true
}

test.describe('seller-landing link population', () => {
  test('SELLER_LANDING_PATHS is the market landings: Mexico at the root, the US under its prefix', () => {
    // Pinned literally. Read from the constant this would only prove self-consistency;
    // the point of the guard below is that these two exact paths are what ships.
    expect(SELLER_LANDING_PATHS.mx).toBe('/')
    expect(SELLER_LANDING_PATHS.us).toBe('/us/sell')
  })

  test('no source file links at the pre-move /vende path', () => {
    const offenders: string[] = []

    for (const dir of SCAN_ROOTS) {
      for (const file of sourceFilesBelow(dir)) {
        if (path.relative(ROOT, file).replace(/\\/g, '/') === DEFINING_FILE) continue
        const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
        lines.forEach((line, i) => {
          // The bare old anchor is matched on the whole (comment-stripped) LINE, not only on
          // single-line string literals: the cost-comparator report and the setup-spec prompt
          // are multi-line template literals, whose middle lines have no quote to anchor on —
          // a mutation that put `/mx/vende` back into the report sailed through the literal scan.
          if (STALE_MX_ANCHOR.test(line)) {
            offenders.push(`${path.relative(ROOT, file)}:${i + 1} → ${line.trim()}`)
            return
          }
          for (const literal of stringLiteralsIn(line)) {
            if (!isStaleLandingLink(literal)) continue
            offenders.push(`${path.relative(ROOT, file)}:${i + 1} → ${literal.trim()}`)
          }
        })
      }
    }

    expect(
      offenders,
      `link targets still on the pre-move path — use SELLER_LANDING_PATHS.mx (${SELLER_LANDING_PATHS.mx}):\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  test('the predicate catches every form the move actually left behind, and no prose', () => {
    // The three real misses, verbatim as they appeared in the source. Without this the
    // sweep could go green by matching nothing and no one would know.
    expect(isStaleLandingLink('${ENDPOINT}/vende')).toBe(true)
    expect(isStaleLandingLink('${siteUrl}/vende?promo=${code}')).toBe(true)
    expect(isStaleLandingLink('/vende/promotor')).toBe(true)

    // The 2026-10 move: a bare `/mx/vende` target is stale in every shape it appears in.
    expect(isStaleLandingLink('/mx/vende')).toBe(true)
    expect(isStaleLandingLink('/mx/vende?utm_source=x')).toBe(true)
    expect(isStaleLandingLink('${ENDPOINT}/mx/vende')).toBe(true)
    expect(isStaleLandingLink('/mx/vende#vende-router-title')).toBe(true)
    expect(isStaleLandingLink('Visita miyagisanchez.com/mx/vende para empezar')).toBe(true)
    expect(isStaleLandingLink('Abre ${PLATFORM_ORIGIN}/mx/vende, dime qué es')).toBe(true)

    // …and the things that must stay writeable.
    expect(isStaleLandingLink(SELLER_LANDING_PATHS.mx)).toBe(false)
    expect(isStaleLandingLink('/mx/vende/creadores')).toBe(false)
    expect(isStaleLandingLink('/mx/vende/promotor')).toBe(false)
    expect(isStaleLandingLink('/api/vende/fundadoras/apply')).toBe(false)
    expect(isStaleLandingLink('con las guías de /vende/migracion y súbela')).toBe(false)
    expect(isStaleLandingLink('/vendedores')).toBe(false)
  })

  test('the sweep sees absolute URLs and still ignores real comments', () => {
    // Runs the SWEEP's own preprocessing, not just the predicate — the predicate fixtures above
    // never passed through stripComments, which is how the absolute-URL blind spot hid.
    const scan = (src: string) =>
      stripComments(src).split('\n').some((line) => STALE_MX_ANCHOR.test(line) || stringLiteralsIn(line).some(isStaleLandingLink))
    expect(scan("const a = 'https://miyagisanchez.com/mx/vende'")).toBe(true)
    expect(scan('<a href="https://miyagisanchez.com/mx/vende">')).toBe(true)
    expect(scan('- https://miyagisanchez.com/mx/vende — qué es')).toBe(true)
    expect(scan('// we used to link https://miyagisanchez.com/mx/vende here')).toBe(false)
    expect(scan("const ok = 'https://miyagisanchez.com/mx/vende/creadores'")).toBe(false)
  })

  test('the scan actually reaches the three files the move missed', () => {
    // Guards the GUARD's population. A scan that quietly stopped covering `app/` or
    // `lib/` would keep passing forever while covering nothing — so name the files
    // whose misses motivated this spec and assert they are in the swept set.
    const swept = new Set(
      SCAN_ROOTS.flatMap((d) => sourceFilesBelow(d)).map((f) => path.relative(ROOT, f).replace(/\\/g, '/')),
    )
    for (const file of [
      'app/(shell)/agent/page.tsx',
      'app/(shell)/admin/promoter/PromoterAdminClient.tsx',
      'app/(us-site)/us/operators/page-config.ts',
      'lib/seller-acquisition.ts',
    ]) {
      expect(swept.has(file), `${file} must be inside the scan roots`).toBe(true)
    }
    expect(swept.size).toBeGreaterThan(500)
  })
})
