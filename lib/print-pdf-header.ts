/**
 * `X-Print-Missing-Images` → a count, or undefined when it cannot be read. Only plain digits count: `Number('')` is
 * 0, so a lenient parse would read an empty header from a proxy as "every image loaded" and the PDF would be cached
 * (codex + verifier, PR 450). Unknown is not zero; a caller treats it as incomplete.
 *
 * Pure, relative imports only, so the `api` Playwright project tests it (`lib/print-pdf-client.ts` is server-only).
 */
export function parseMissingImages(header: string | null): number | undefined {
  return header !== null && /^\d{1,6}$/.test(header) ? Number(header) : undefined
}
