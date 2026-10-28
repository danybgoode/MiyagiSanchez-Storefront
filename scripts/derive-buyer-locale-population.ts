import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const DIRECT_BUYER_DIRS = [
  'app/(shell)/account',
  'app/(shell)/checkout',
  'app/(shell)/messages',
  'app/(shell)/l',
  'app/(shell)/mx',
  'app/(shell)/s',
  'app/(shell)/payment',
  'app/(shell)/c',
  // Owned-host root routes: on a subdomain or custom domain these serve the
  // shop's own pages directly (middleware passes them through with the channel
  // header). They are as buyer-facing as anything under `/s/`, and they were
  // outside this list — a scan that hand-picks its roots decays silently while
  // still passing, which is why the Living Shop epic's new sections went
  // uncovered until an assertion named one of them.
  'app/(shell)/tienda',
  'app/(shell)/colecciones',
  'app/(shell)/eventos',
  'app/(shell)/acerca',
  'app/(shell)/faq',
  'app/(shell)/politicas',
  'app/(shell)/catalogo',
  'app/(us-shell)/us',
] as const

/**
 * Subtrees that sit INSIDE a buyer root but are not buyer surfaces.
 *
 * `app/(shell)/mx/vende` is the Mexican seller-acquisition family — the landing,
 * its six persona pages, the migration hub and the promoter pages. They are es-MX
 * by design (AGENTS rule 5: es-MX default, bilingual only on a named allow-list),
 * they have always been outside this scan, and they render marketing prose that is
 * authored per market rather than translated.
 *
 * They only appear here because their URL moved: `/vende` became `/mx/vende` when
 * each market got one landing of its own, which dropped ~35 files into a scan root
 * whose meaning is "buyer chrome, must be dictionary-backed". A page's URL is not
 * what decides which language rule it is held to, so the exclusion is stated by
 * path, with this reason, rather than allowed to show up as 35 new violations that
 * the next person silences by extracting copy nobody asked to translate.
 *
 * `app/(shell)/mx/precios` (pricing-page, 2026-10-28) is the same kind of page: what SELLING
 * costs, written for a merchant comparing platforms, es-MX and MX-priced by design. A buyer
 * never needs it, and its prices are MXN facts, not presentation to localize.
 *
 * Named as a prefix list and asserted in `e2e/buyer-locale-population.spec.ts`, so
 * adding a second exclusion is a visible decision instead of a quiet widening.
 */
export const NON_BUYER_SUBTREES = [
  'app/(shell)/mx/vende',
  'app/(shell)/mx/precios',
] as const

const BUYER_ENTRYPOINTS = [
  'app/components/MarketDocument.tsx',
  'app/(shell)/layout.tsx',
  'app/(site)/layout.tsx',
  'app/(site)/page.tsx',
  'app/(mx-site)/layout.tsx',
  'app/(mx-site)/mx/page.tsx',
  'app/(us-site)/layout.tsx',
  'app/(us-site)/us/page.tsx',
  'app/(us-shell)/layout.tsx',
] as const

export interface BuyerLocalePopulation {
  readonly generatedBy: 'scripts/derive-buyer-locale-population.ts'
  readonly direct: string[]
  readonly marketRoots: string[]
  /** TSX render closure only. Pure/server TS modules do not contain UI chrome. */
  readonly closure: string[]
  readonly copyClassification: {
    readonly dictionaryConsuming: string[]
    readonly noLiteralUiCopy: string[]
    readonly explicitExemptions: Array<{
      file: string
      candidates: string[]
      reason: 'technical_url_template'
    }>
    readonly needsExtraction: Array<{ file: string; candidates: string[] }>
  }
  readonly presentationFormatting: {
    readonly explicitExemptions: Array<{
      file: string
      candidates: string[]
      reason: never
    }>
    readonly hardcoded: Array<{ file: string; candidates: string[] }>
  }
}

const EXPLICIT_COPY_EXEMPTIONS: Readonly<Record<string, Readonly<Record<string, 'technical_url_template'>>>> = {
  'app/(shell)/account/referrals/ReferralsClient.tsx': {
    '{0}/?ref={1}': 'technical_url_template',
  },
}

function filesBelow(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((name) => {
    const absolute = path.join(root, name)
    return statSync(absolute).isDirectory() ? filesBelow(absolute) : [absolute]
  })
}

function relative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/')
}

function resolveStaticImport(root: string, from: string, request: string): string | null {
  const base = request.startsWith('@/')
    ? path.join(root, request.slice(2))
    : request.startsWith('.')
      ? path.resolve(path.dirname(path.join(root, from)), request)
      : null
  if (!base) return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return relative(root, candidate)
  }
  return null
}

function appTsxClosure(root: string, entries: string[]): string[] {
  const seen = new Set<string>()
  const queue = entries.filter((file) => existsSync(path.join(root, file)))
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(path.join(root, file), 'utf8')
    const imports = source.matchAll(/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g)
    for (const match of imports) {
      const resolved = resolveStaticImport(root, file, match[1])
      if (resolved && !seen.has(resolved)) queue.push(resolved)
    }
  }
  return [...seen]
    .filter((file) => file.startsWith('app/') && file.endsWith('.tsx'))
    .sort()
}

export function literalUiCandidates(source: string, file = 'fixture.tsx'): string[] {
  const found = new Set<string>()
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const localBindings = new Map<string, ts.Expression>()
  function collectBindings(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      localBindings.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, collectBindings)
  }
  collectBindings(parsed)

  function add(value: string) {
    const normalized = value.replace(/&apos;/g, "'").replace(/\s+/g, ' ').trim()
    const localeInvariant = normalized === 'ucp.dev' || normalized === 'Miyagi' ||
      normalized === 'Sánchez' || /^&[a-z]+;$/.test(normalized)
    if (/[\p{L}]/u.test(normalized) && !localeInvariant) found.add(normalized)
  }

  function visit(node: ts.Node) {
    if (ts.isJsxText(node)) add(node.getText(parsed))
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(parsed)
      if (['title', 'placeholder', 'aria-label'].includes(name) && node.initializer && ts.isStringLiteral(node.initializer)) {
        add(node.initializer.text)
      }
      if (
        ['title', 'placeholder', 'aria-label'].includes(name) &&
        node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression
      ) {
        visitRenderedExpression(node.initializer.expression)
      }
    }
    if (
      ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent) &&
      !(ts.isJsxElement(node.parent) && node.parent.openingElement.tagName.getText(parsed) === 'style')
    ) {
      visitRenderedExpression(node.expression)
    }
    ts.forEachChild(node, visit)
  }

  /**
   * Only descend through expression positions whose value React renders. This
   * catches `condition ? 'Comprar' : 'Comprando…'` without misclassifying IDs
   * in control predicates such as `status === 'paid'` as UI copy.
   */
  function visitRenderedExpression(expression: ts.Expression): void {
    if (ts.isIdentifier(expression)) {
      const initializer = localBindings.get(expression.text)
      if (initializer && initializer !== expression) visitRenderedExpression(initializer)
      return
    }
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) {
      visitRenderedExpression(expression.expression)
      return
    }
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      add(expression.text)
      return
    }
    if (ts.isTemplateExpression(expression)) {
      const pattern = expression.templateSpans.reduce(
        (value, span, index) => `${value}{${index}}${span.literal.text}`,
        expression.head.text,
      )
      add(pattern)
      return
    }
    if (ts.isConditionalExpression(expression)) {
      visitRenderedExpression(expression.whenTrue)
      visitRenderedExpression(expression.whenFalse)
      return
    }
    if (ts.isBinaryExpression(expression)) {
      if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        visitRenderedExpression(expression.right)
      } else if (
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        visitRenderedExpression(expression.left)
        visitRenderedExpression(expression.right)
      }
      return
    }
    if (ts.isArrayLiteralExpression(expression)) {
      for (const element of expression.elements) {
        if (ts.isExpression(element)) visitRenderedExpression(element)
      }
    }
  }
  visit(parsed)
  return [...found].sort()
}

/**
 * Find locale/timezone constants embedded in buyer rendering code. Those facts
 * must come from MarketPresentation even when the visible copy is translated;
 * a translated label beside an `es-MX` amount is still the wrong US product.
 */
export function hardcodedPresentationCandidates(source: string, file = 'fixture.tsx'): string[] {
  const found = new Set<string>()
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  function stringValue(node: ts.Expression | undefined): string | null {
    return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null
  }

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression.getText(parsed)
      const locale = stringValue(node.arguments?.[0])
      const isIntlFormatter = expression === 'Intl.NumberFormat' || expression === 'Intl.DateTimeFormat'
      const isLocaleMethod = /\.toLocale(?:String|DateString|TimeString)$/.test(expression)
      if ((isIntlFormatter || isLocaleMethod) && locale === 'es-MX') {
        found.add(`${expression}('es-MX')`)
      }
    }
    if (
      ts.isPropertyAssignment(node) && node.name.getText(parsed).replace(/["']/g, '') === 'timeZone' &&
      stringValue(node.initializer) === 'America/Mexico_City'
    ) {
      found.add("timeZone: 'America/Mexico_City'")
    }
    ts.forEachChild(node, visit)
  }

  visit(parsed)
  return [...found].sort()
}

export function deriveBuyerLocalePopulation(root: string): BuyerLocalePopulation {
  const direct = DIRECT_BUYER_DIRS
    .flatMap((dir) => filesBelow(path.join(root, dir)))
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => relative(root, file))
    .filter((file) => !NON_BUYER_SUBTREES.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)))
    .sort()

  const marketRoots = [
    'app/(mx-site)/mx/page.tsx',
    'app/(us-site)/us/page.tsx',
  ].filter((file) => existsSync(path.join(root, file)))

  const closure = appTsxClosure(root, [...direct, ...BUYER_ENTRYPOINTS])
  const dictionaryConsuming: string[] = []
  const noLiteralUiCopy: string[] = []
  const explicitExemptions: BuyerLocalePopulation['copyClassification']['explicitExemptions'] = []
  const needsExtraction: Array<{ file: string; candidates: string[] }> = []
  const hardcoded: Array<{ file: string; candidates: string[] }> = []
  for (const file of closure) {
    const source = readFileSync(path.join(root, file), 'utf8')
    const hardcodedCandidates = hardcodedPresentationCandidates(source, file)
    if (hardcodedCandidates.length > 0) hardcoded.push({ file, candidates: hardcodedCandidates })
    const candidates = literalUiCandidates(source, file)
    const exemptions = EXPLICIT_COPY_EXEMPTIONS[file] ?? {}
    const exempted = candidates.filter((candidate) => candidate in exemptions)
    const unclassified = candidates.filter((candidate) => !(candidate in exemptions))
    if (exempted.length > 0) {
      explicitExemptions.push({
        file,
        candidates: exempted,
        reason: exemptions[exempted[0]],
      })
    }
    if (unclassified.length > 0) needsExtraction.push({ file, candidates: unclassified })
    else if (/\b(?:getDictionary|Dictionary|buyerShell|\bcopy\b|\bui\b)/.test(source)) dictionaryConsuming.push(file)
    else noLiteralUiCopy.push(file)
  }

  return {
    generatedBy: 'scripts/derive-buyer-locale-population.ts',
    direct,
    marketRoots,
    closure,
    copyClassification: { dictionaryConsuming, noLiteralUiCopy, explicitExemptions, needsExtraction },
    presentationFormatting: { explicitExemptions: [], hardcoded },
  }
}

export function serializeBuyerLocalePopulation(population: BuyerLocalePopulation): string {
  return `${JSON.stringify(population, null, 2)}\n`
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = process.cwd()
  const output = path.join(root, 'locales/buyer-population.json')
  writeFileSync(output, serializeBuyerLocalePopulation(deriveBuyerLocalePopulation(root)))
  process.stdout.write(`Wrote ${relative(root, output)}\n`)
}
