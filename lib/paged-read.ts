/**
 * lib/paged-read.ts — read a whole table through PostgREST, a page at a time.
 *
 * PostgREST answers at most 1,000 rows per request by default and says NOTHING when it cuts a result short. A single
 * unpaged read therefore "succeeds" on the first 1,000 rows and a script plans, counts or reports on a partial table
 * as if it were the whole one. Every reporting or backfill script that reads a table reads it through here.
 *
 * PURE (the fetcher is injected), so "keeps going past one page" and "an error on any page throws" are unit-tested.
 */

export type PageResult<T> = { data: T[] | null; error: { message: string } | null }

/** Below PostgREST's 1,000-row ceiling on purpose: a page that comes back FULL must mean "ask again", never "cut". */
export const DEFAULT_PAGE_SIZE = 500

/**
 * Read every row, `pageSize` at a time, until a page comes back short. Any page that errors, or answers without an
 * array, throws: a partial list must never be returned as if it were the table. `what` names the table in the error.
 * The `fetchPage` it is given must order by a stable, unique key, or rows could repeat or be skipped between pages.
 */
export async function readAllPages<T>(
  fetchPage: (from: number, to: number) => Promise<PageResult<T>>,
  pageSize: number = DEFAULT_PAGE_SIZE,
  what: string = 'rows',
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error(`readAllPages: pageSize must be a positive integer (got ${pageSize})`)
  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1)
    if (error) throw new Error(`could not read ${what} (rows ${from}–${from + pageSize - 1}): ${error.message}`)
    if (!Array.isArray(data)) throw new Error(`could not read ${what} (rows ${from}–${from + pageSize - 1}): no rows array in the answer`)
    rows.push(...data)
    if (data.length < pageSize) return rows
  }
}
