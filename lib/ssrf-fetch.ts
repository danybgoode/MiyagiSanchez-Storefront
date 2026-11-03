/**
 * lib/ssrf-fetch.ts
 *
 * SSRF DNS-pinning (epic 09 · ssrf-dns-pinning, Sprint 1). A sibling of
 * `lib/ssrf-guard.ts` — imports its `isPrivateIpv4`/`isPrivateIpv6`
 * classifiers rather than redefining them (that file stays the one place
 * those predicates live; this is NOT a third guard module).
 *
 * The problem this closes: both existing untrusted-domain callers
 * (`lib/shop-url-analyzer-fetch.ts`, `lib/shopify-mcp-client.ts`) resolve a
 * hostname, validate every returned address, then call `fetch()` — which
 * resolves the SAME hostname again, independently. Between those two
 * resolves there is a TOCTOU window: an attacker controlling DNS for the
 * target domain can flip the record between them (DNS rebinding) so the
 * address that got validated is not the address that gets dialed.
 *
 * `pinnedFetch` closes that window structurally: resolve ONCE, validate
 * every returned address, then physically dial one of the exact validated
 * IPs via a per-request undici `Agent` whose `connect.lookup` is stubbed to
 * always answer with that SAME validated set — no second, independent
 * resolve is ever possible. The original hostname is passed to `fetch()`
 * unchanged (only the dial target is pinned), so undici derives TLS
 * SNI/`servername` from it as usual — that is what preserves certificate
 * validation against the hostname the caller actually asked for, not the IP
 * we dialed.
 *
 * Why `undici` is imported directly (both `fetch` AND `Agent`), not Node's
 * global `fetch` with a duck-typed dispatcher: `undici` was, until this
 * epic, only a TRANSITIVE dependency of this package — hoisted from the
 * workspace root's node_modules (currently resolving to whatever version a
 * sibling package happens to need). Node 22 (the deployed Cloud Run image's
 * runtime, apps/storefront PR 289) has its OWN bundled `undici` backing
 * the global `fetch`, which is a different major than the hoisted one — so a
 * dispatcher built from a directly-imported `Agent` could silently mismatch
 * the dispatcher type the global `fetch` expects. Adding `undici` as a
 * DIRECT dependency here and importing `fetch`/`Agent` from it together
 * means both always come from the exact same package instance, in dev AND
 * in the `npm ci`-from-this-package's-own-lockfile Cloud Run build — the
 * deployed runtime's own bundled undici version becomes irrelevant, because
 * we never touch it.
 *
 * This deliberately BYPASSES Next.js's patched global `fetch` (and therefore
 * its Data Cache) — correct for both call sites here, which fetch an
 * arbitrary caller-supplied third-party origin on every call and must never
 * be cached.
 *
 * Kept `server-only`-free on purpose, same reason `lib/ssrf-guard.ts` is
 * (see that file's header): the Playwright `api` runner imports this module
 * directly to unit-test it, and `server-only` throws immediately when
 * imported outside a Next build — it would break the very test run meant to
 * cover this file. This was an open question in sprint-1.md ("`server-only`
 * enforcement on the new helper — raise it as a question in plan mode,
 * decide, move on"); the decision is: no, for the reason above.
 *
 * CORRECTION (cross-agent review + independent `pr-reviewer` pass,
 * 2026-07-20 — both confirmed live against real undici 8.8.0, one via a real
 * `https://www.shopify.com/` fetch through this exact shape): the first
 * version of this function called `await agent.destroy()` in a `finally`
 * immediately after `undiciFetch()` resolved. `undiciFetch()` resolves as
 * soon as HTTP HEADERS arrive — the body is still streaming — so that
 * `finally` forcibly killed the live socket while the caller was still
 * reading the body. Small payloads that fit in the same TCP flush as the
 * headers could pass by accident; anything larger (the `pr-reviewer` pass's
 * threshold ladder: 1 KB/16 KB OK, 64 KB/256 KB/1 MB failed) hit a real race
 * and threw `TypeError: terminated` on every read. `destroy()` is the
 * FORCEFUL teardown; it is still correct, and still used, on the throw path
 * below (no `Response` was ever handed to a caller there, so nothing else
 * will ever drain that connection). On the success path, the fix is to stop
 * destroying at all and instead let the per-request socket close itself the
 * moment it goes idle — see the comment inside `pinnedFetch`.
 */
import {
  fetch as undiciFetch,
  Agent,
  Headers,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from 'undici'
import { lookup as dnsLookup } from 'node:dns/promises'
import { ADDRCONFIG } from 'node:dns'
import { isPrivateIpv4, isPrivateIpv6 } from './ssrf-guard'

/** Thrown when a host resolves to a private/reserved address, or DNS resolution fails. */
export class SsrfBlockedError extends Error {}

export type ResolvedAddress = { address: string; family: number }

/**
 * A resolver seam — swap in a stub in tests to drive `pinnedFetch` through a
 * deterministic sequence of DNS answers (e.g. the TOCTOU-closure proof: a
 * `lookup` that returns a public address first and a private one on a
 * second call). TEST-ONLY override; production callers never pass this.
 */
export type PinnedFetchResolver = (hostname: string) => Promise<ResolvedAddress[]>

const defaultResolve: PinnedFetchResolver = async (hostname) => {
  // `hints: ADDRCONFIG` matches what undici's OWN default connector passes
  // to Node's lookup (confirmed live by cross-agent review instrumentation
  // of the lookup callback) — it suppresses address families the running
  // host has no actual route for. Without it, a dual-stack target whose
  // AAAA record happens to sort first would get pinned to IPv6 with no
  // fallback on a runtime with IPv4-only egress (Cloud Run) — the old
  // plain-`fetch()` path never hit this because Node's own default lookup
  // (and undici's `autoSelectFamily`) already filtered/failed-over across
  // whatever the OS could actually route.
  const results = await dnsLookup(hostname, { all: true, verbatim: true, hints: ADDRCONFIG })
  return results
}

/**
 * PURE — no network. Given `node:dns` lookup results, validate EVERY
 * returned address and return the full set to pin (order preserved), or
 * `null` if ANY resolved address is private/reserved. Fails closed on an
 * empty result set.
 *
 * Returns the whole validated set, not just the first address: the old
 * resolve-then-`fetch()` path let the runtime retry across every A/AAAA
 * record Node resolved (Happy-Eyeballs / dual-stack failover) — pinning only
 * `results[0]` would silently drop that resilience the moment a multi-homed
 * host's first record was momentarily down. Every address here has passed
 * the identical private/reserved check, so handing `pinnedFetch` the whole
 * set preserves failover without reopening the TOCTOU: nothing outside this
 * already-validated list is ever added later.
 */
export function selectPinnedAddresses(
  results: ResolvedAddress[],
): Array<{ address: string; family: 4 | 6 }> | null {
  if (results.length === 0) return null
  const addresses: Array<{ address: string; family: 4 | 6 }> = []
  for (const r of results) {
    const isPrivate = r.family === 6 ? isPrivateIpv6(r.address) : isPrivateIpv4(r.address)
    if (isPrivate) return null
    addresses.push({ address: r.address, family: r.family === 6 ? 6 : 4 })
  }
  return addresses
}

/**
 * Resolves `url.hostname` ONCE, validates every returned address with the
 * shared `lib/ssrf-guard.ts` classifiers, then dials one of the exact pinned
 * IPs — via a per-request undici `Agent` whose `connect.lookup` always
 * answers with that SAME validated set (`autoSelectFamily: true` lets Node
 * retry across it, same as the old plain-hostname path could) — while
 * leaving `url.hostname` itself untouched, so TLS SNI/cert validation still
 * runs against the original hostname. Throws `SsrfBlockedError` if the host
 * is not public (including on DNS failure — fails closed).
 *
 * Provides pinned DISPATCH only, not policy: callers keep their own
 * timeout/redirect/byte-cap/content-type rules layered on top.
 */
export async function pinnedFetch(
  url: URL,
  init?: UndiciRequestInit,
  opts?: {
    resolve?: PinnedFetchResolver
    /**
     * TEST-ONLY escape hatch. When `true`, skip `selectPinnedAddresses`'s
     * private/reserved-address rejection (still fails closed on an empty
     * result set, still pins the resolved set as-is). Production call sites
     * never pass this — its default (`selectPinnedAddresses`'s real,
     * unmodified rejection) is exactly current production behaviour.
     * Structurally guarded, not just documented: `pinnedFetch` throws if
     * this is ever passed with `NODE_ENV === 'production'`, so a future
     * caller can't quietly reach for it on a shared security seam.
     *
     * Why it exists at all: every address a sandboxed dev/CI machine can
     * dial to itself (loopback, its own LAN/CGNAT address) is, correctly,
     * `isPrivateIpv4`/`isPrivateIpv6`-private — that's the whole point of
     * the guard. That makes it impossible to drive `pinnedFetch` through a
     * real, successful connection to a local `http.createServer()` (the
     * TOCTOU-closure + hostname-preservation specs) without either
     * re-implementing the pin/dial mechanism a second time just for tests,
     * or a narrow, explicit bypass of only the rejection step here. The
     * rejection itself is separately verified with ZERO bypass, against the
     * real, unmodified classifiers, in the "rejection still works" specs.
     */
    unsafeSkipPrivateCheckForTest?: boolean
  },
): Promise<UndiciResponse> {
  if (opts?.unsafeSkipPrivateCheckForTest && process.env.NODE_ENV === 'production') {
    throw new Error('pinnedFetch: unsafeSkipPrivateCheckForTest must never be used in production')
  }

  const resolve = opts?.resolve ?? defaultResolve

  let results: ResolvedAddress[]
  try {
    results = await resolve(url.hostname)
  } catch {
    throw new SsrfBlockedError(`DNS resolution failed for host: ${url.hostname}`)
  }

  const pinnedAddresses = opts?.unsafeSkipPrivateCheckForTest
    ? (results.length > 0
        ? results.map((r) => ({ address: r.address, family: (r.family === 6 ? 6 : 4) as 4 | 6 }))
        : null)
    : selectPinnedAddresses(results)
  if (!pinnedAddresses) {
    throw new SsrfBlockedError(`Host does not resolve to a public address: ${url.hostname}`)
  }

  // A fresh Agent per request (never reused/shared across requests, never
  // holds more than one request's worth of connections) so the pinned
  // address set can never leak into a connection reused for a different
  // host.
  const agent = new Agent({
    connect: {
      lookup: (_lookupHostname, _lookupOptions, callback) => {
        callback(null, pinnedAddresses.map((a) => ({ address: a.address, family: a.family })))
      },
    },
    // Every candidate above already passed the private/reserved check, so
    // letting Node retry across them (Happy-Eyeballs / v4↔v6 failover)
    // preserves the resilience the old resolve-then-`fetch()` path got for
    // free from a plain hostname dial, without reopening any TOCTOU.
    autoSelectFamily: true,
    // Let this per-request socket close itself the instant it goes idle
    // (right after this one response finishes) instead of lingering in
    // undici's keep-alive pool for reuse that will never come (a fresh
    // Agent is never reused). This — not an explicit destroy — is what
    // cleans up the success path; see the file-header CORRECTION for why an
    // earlier version's `finally { agent.destroy() }` was wrong.
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
  })
  try {
    // Reinforces the same self-closing behaviour at the protocol level (most
    // servers close rather than keep-alive on request), independent of the
    // client-side keepAliveTimeout above. Only set if the caller didn't
    // already specify one.
    const headers = new Headers(init?.headers)
    if (!headers.has('connection')) headers.set('connection', 'close')
    return await undiciFetch(url, { ...init, headers, dispatcher: agent })
  } catch (err) {
    // The one path where the socket really could otherwise leak: no
    // Response was ever handed back for a caller to read/drain, so nothing
    // will ever put this Agent's connection through its normal close.
    await agent.destroy()
    throw err
  }
}
