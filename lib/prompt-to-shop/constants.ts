/**
 * Prompt-to-shop — constants the BROWSER needs too.
 *
 * `blocks.ts` pulls the catalog and settings validators (tens of KB) into whatever imports it. The describe box and
 * the canvas only need a number, so it lives here, import-free, and `blocks.ts` re-exports it for the server side.
 * `e2e/p2s-client-diet.spec.ts` keeps the client modules from reaching the heavy ones.
 */

export const MAX_DESCRIPTION_CHARS = 500
