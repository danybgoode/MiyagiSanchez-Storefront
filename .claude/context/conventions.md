# Conventions & patterns

<a name="bilingual"></a>
## Language — es-MX default, with a bilingual allow-list

The site is **es-MX by default** — the seller portal and most pages are Spanish-only. A defined
allow-list of surfaces is **bilingual (es/en)** via the `locales/{es,en}.json` dictionary (~119
keys) + `getDictionary()`: the dictionary-backed public pages (e.g. `app/terminos`), the
sweepstakes public flow (`app/g/[slug]`, `?lang=en`, per-campaign `*_en/*_es`), the embed
widget locale toggle, and the **shop builder** (one-front-door-both-markets D11): `/en`, `/us/sell`, `/us/vende`
and every prompt-to-shop screen and reminder email, in the draft's language via `lib/prompt-to-shop/copy-en.ts`. The gate: (a) **es-MX copy-completeness** everywhere — no orphan strings,
no hardcoded English; (b) on the allow-list, **both `es` + `en` keys present**. Don't make a new
surface bilingual by default — extend the allow-list deliberately.

```ts
// ✅ es-MX (default surfaces)
<button>Guardar configuración</button>

// ✅ bilingual allow-list — via the dictionary
const dict = await getDictionary(locale) // 'es' | 'en'
<button>{dict.settings.save}</button>
```

**How i18n works**:
```ts
// Server component (page.tsx)
import { getDictionary } from '@/lib/dictionary'
const dict = await getDictionary()
// Pass slice to client component as prop:
<MyClientComponent ui={dict.settings} />

// Client component — receives ui prop, never calls getDictionary()
export default function MyClient({ ui }: { ui: Dictionary['settings'] }) { ... }
```

**Brand names stay in English in both locale files**: Stripe, MercadoPago, WhatsApp, Cal.com, Inbox, Bonsai.

**Check for bare hardcoded strings**:
```bash
grep -rn '"[A-Z][a-z]' app/ --include="*.tsx" | grep -v "//\|className\|href\|type=\|placeholder\|aria-\|alt=\|node_modules"
```

---

## Auth patterns

```ts
// In server components / API routes — returns null if not signed in
import { currentUser } from '@clerk/nextjs/server'
const user = await currentUser()
if (!user) return NextResponse.json({ error: '...' }, { status: 401 })

// When you only need userId (lighter, no full user object)
import { auth } from '@clerk/nextjs/server'
const { userId } = await auth()

// In pages that should redirect (not return JSON)
import { redirect } from 'next/navigation'
const user = await currentUser()
if (!user) redirect('/sign-in')
```

`middleware.ts` auto-protects `/shop/manage/.*` — you don't need to add auth checks there.

---

## API route pattern

```ts
import { NextRequest, NextResponse } from 'next/server'
import { currentUser } from '@clerk/nextjs/server'
import { db } from '@/lib/supabase'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'

export async function POST(req: NextRequest) {
  // 1. Auth (if required)
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })

  // 2. Rate limit (for user-facing endpoints)
  const rl = await checkRateLimit('checkout', getClientIp(req))
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Demasiados intentos. Espera un momento.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    )
  }

  // 3. Parse body
  let body: { listingId: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Datos inválidos.' }, { status: 400 })
  }
  if (!body.listingId) return NextResponse.json({ error: 'listingId requerido.' }, { status: 400 })

  // 4. DB query
  const { data, error } = await db.from('...').select('...').eq('id', body.listingId).maybeSingle()
  if (!data) return NextResponse.json({ error: 'No encontrado.' }, { status: 404 })

  // 5. Business logic in try/catch — return 502 for 3rd-party failures
  try {
    const result = await externalApi.doSomething()
    return NextResponse.json({ result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[route-name] failed:', msg)
    return NextResponse.json({ error: 'Error externo.', detail: msg }, { status: 502 })
  }
}
```

---

<a name="storage"></a>
## File uploads

### Listing images (public, Cloudflare R2)

```ts
import { uploadToR2, isR2Configured } from '@/lib/r2'

if (isR2Configured()) {
  const arrayBuffer = await file.arrayBuffer()
  const key = `listing-images/${userId}/${Date.now()}.webp`
  const url = await uploadToR2(arrayBuffer, key, 'image/webp')
  // url is a public CDN URL
} else {
  // Fallback to Supabase Storage (dev environments without R2)
}
```

### Digital files (private, presigned URLs)

```ts
import { uploadDigitalToR2, getR2DigitalSignedUrl, isR2DigitalConfigured } from '@/lib/r2'

// Upload (returns storage key, NOT public URL)
const key = await uploadDigitalToR2(buffer, `digital/${shopId}/${filename}`, mimeType)

// Later, to serve the file (1-hour expiry):
const signedUrl = await getR2DigitalSignedUrl(key, 3600, 'download-filename.pdf')
```

---

## Telegram admin notifications

All events go to Daniel's personal Telegram. Fire-and-forget — never throws.

```ts
import { tg } from '@/lib/telegram'

await tg.newListing(listing.title, priceFmt, shopName, listing.id)
await tg.salePaid('$1,200', listing.title, buyerEmail, 'stripe')
await tg.newSubscription('$500', 'mes', listingTitle, buyerEmail)
await tg.offerMade('$800', '$1,000', listingTitle, buyerEmail)
await tg.alert('Something went wrong: ' + errorMessage)
```

Do not add `await` on the critical path — the Telegram call has a 5s timeout but should not block the response.

---

## Error handling in client components

```ts
const [loading, setLoading] = useState(false)
const [error, setError] = useState<string | null>(null)

async function handleSubmit() {
  setLoading(true); setError(null)
  try {
    const res = await fetch('/api/...', { method: 'POST', ... })
    const data = await res.json() as { url?: string; error?: string }
    if (!res.ok || !data.url) { setError(data.error ?? 'Error inesperado.'); return }
    window.location.href = data.url
  } catch { setError('Sin conexión. Verifica tu internet.') }
  finally { setLoading(false) }
}

// Render
{error && <p className="text-red-600 text-sm">⚠ {error}</p>}
<button disabled={loading}>{loading ? 'Cargando…' : 'Acción'}</button>
```

---

## Commit style

Direct to `main`, no PRs. Include a co-author line:

```
fix: short description of what changed

Longer body if needed. Focus on the why.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Revert with `git revert HEAD` if something breaks in production.

---

## TypeScript gotchas

```ts
// Supabase join returns object OR array depending on relationship type
// Always cast when uncertain:
const shops = listing.marketplace_shops as unknown as ShopType | ShopType[]
const shop = Array.isArray(shops) ? shops[0] : shops

// JSONB columns come back as unknown — cast with 'as'
const meta = (listing.metadata ?? {}) as Record<string, unknown>
const tiers = meta.subscription_tiers as StoredTier[] | undefined

// Clerk user fields
const email = user.emailAddresses?.[0]?.emailAddress  // can be undefined

// Next.js 15+ async params
const { id } = await params  // params is Promise<{id:string}>
```

---

## Design patterns

**Server component (page) → client component** split:
```
page.tsx (async server component)
  ↓ fetches data, auth, shop settings
  ↓ passes plain serializable props
MyFeaturePanel.tsx ('use client' — handles interactivity)
```

**ToggleSwitch component** (in ShopSettings.tsx — import or copy):
```tsx
<ToggleSwitch
  checked={myState}
  onChange={setMyState}
  label="Feature label"
  description="Short description shown below label."
/>
```

**Section styling pattern** (ShopSettings sections):
```tsx
<section className="border border-[var(--color-border)] rounded-xl p-5 mb-5">
  <SectionTitle>Section Name</SectionTitle>
  {/* content */}
</section>
```

---

## What NOT to do

- ❌ Don't use `stripe.checkout.sessions.create()` directly in subscription routes — use `createSubscriptionCheckout()` from `lib/stripe-subscriptions.ts`
- ❌ Don't hardcode prices in MXN cents without checking `listing.currency`
- ❌ Don't call `getDictionary()` in a client component
- ❌ Don't use `.single()` for DB queries that might return no rows — use `.maybeSingle()` (`.single()` throws on not-found)
- ❌ Don't expose `SUPABASE_SERVICE_ROLE_KEY` to the browser — the `db` client must only be used server-side
- ❌ Don't create Stripe products/prices in checkout routes — prices are created once on listing creation in `/api/sell/create`
- ❌ Don't use bare `text-gray-*` colors — use `text-[var(--color-muted)]` etc.
