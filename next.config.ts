import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'
import { LOADER_DEVICE_WIDTHS, LOADER_IMAGE_WIDTHS } from './lib/image-variant'

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Cloud Run container (09-platform-infra
  // frontend-vercel-to-cloudrun, S1.2). Vercel ignores `output: 'standalone'`
  // and keeps using its own build output, so this is a no-op there.
  output: 'standalone',
  images: {
    // 09-platform-infra/hyper-performant-website S1.1 — the built-in `/_next/image`
    // optimizer 500s/400s under `output: 'standalone'` (open upstream Next.js
    // regression, vercel/next.js#82610 — confirmed against this exact Dockerfile,
    // see that commit's message and lib/image-loader.ts's header comment). A
    // CUSTOM loader bypasses `/_next/image` entirely, so `remotePatterns`/`formats`
    // below are vestigial under this mode (Next ignores them for a custom loader)
    // but left in place as documentation of intent + a cheap revert path if the
    // upstream bug is ever fixed.
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
    ],
    // D5 — only these candidates are emitted by the custom loader. The set is
    // based on every current optimized call site: 25vw cards, a 100vw/1120px
    // feature image, and the 40px catalogue thumbnail (the preview is
    // explicitly unoptimized). Keeping it small bounds cold origin encodes
    // without changing the /api/img route's compatibility width ladder.
    deviceSizes: [...LOADER_DEVICE_WIDTHS],
    imageSizes: [...LOADER_IMAGE_WIDTHS],
    // `images.formats` is a Next type limited to WebP/AVIF. JPEG fallback is
    // negotiated inside /api/img for clients that do not advertise WebP.
    formats: ['image/webp'],
    loader: 'custom',
    loaderFile: './lib/image-loader.ts',
  },
  async rewrites() {
    return [
      // Well-known discovery → canonical UCP capability manifest, so AI agents
      // can auto-find the API. Served via rewrite (reliable for .well-known).
      { source: '/.well-known/ucp', destination: '/api/ucp/manifest' },
    ]
  },
  async redirects() {
    return [
      // The Mexican seller landing moved under its market prefix when the seller
      // landings became one-per-market (`/mx/vende` and `/us/sell`). `/vende` has
      // been printed on flyers, bought as ad traffic and linked from outside for
      // months, so it keeps resolving — permanently, in one hop, query preserved
      // (Next carries the query string through a redirect, so UTM and the A/B `v`
      // survive; that is what makes this safe for paid traffic).
      //
      // Here rather than in `middleware.ts` deliberately: this is a static path
      // rule with no request state in it, `redirects()` is evaluated ahead of the
      // middleware, and every middleware edit widens the blast radius of a file
      // that also decides tenant channels and the subdomain paywall.
      //
      // `permanent: true` is a 308, which preserves the METHOD and the body. A
      // 301 lets an intermediary rewrite a POST into a GET, and
      // `/vende/fundadoras` posts an application form.
      { source: '/vende', destination: '/mx/vende', permanent: true },
      { source: '/vende/:path*', destination: '/mx/vende/:path*', permanent: true },
    ]
  },
  async headers() {
    return [
      {
        // The embeddable widget loader is included via <script> from any site, so
        // it must be CORS-open and cacheable. (07 · Embeddable Widget, Sprint 2.)
        source: '/embed.js',
        headers: [
          { key: 'Content-Type', value: 'text/javascript; charset=utf-8' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Cache-Control', value: 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400' },
        ],
      },
      {
        // Prompt-to-shop drafts (owner canvas and the view-only link) are somebody's unfinished shop: never cached by
        // a CDN or a browser, never indexed. The pages say the same (force-dynamic, `robots`); this is the header
        // twin, so the guarantee does not rest on a framework default. (epic prompt-to-shop S2.4/S2.5, D15.)
        source: '/p2s/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
      {
        // The full-shop embed surface must be framable by ANY site (it's the
        // whole point). frame-ancestors * is the modern directive; no global
        // X-Frame-Options is set, so nothing to override. (US-5.)
        source: '/embed/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: 'frame-ancestors *' },
        ],
      },
    ]
  },
}

export default withSentryConfig(nextConfig, {
  // Sentry org/project set via SENTRY_ORG and SENTRY_PROJECT env vars
  silent: true,                  // suppress verbose build output
  sourcemaps: { disable: false },
  // Route Sentry traffic through /monitoring-tunnel so ad blockers
  // (uBlock, Brave, Privacy Badger…) can't intercept the ingest calls.
  // withSentryConfig auto-creates the API route handler for this path.
  tunnelRoute: '/monitoring-tunnel',
  // Updated from deprecated top-level options (disableLogger, automaticVercelMonitors)
  webpack: {
    treeshake: { removeDebugLogging: true },
    automaticVercelMonitors: true, // create Sentry monitors for Vercel cron jobs
  },
})
