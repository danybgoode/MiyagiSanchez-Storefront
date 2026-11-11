import Link from 'next/link'
import { requireAdmin } from '@/lib/admin/guard'
import { db } from '@/lib/supabase'
import { FEEDBACK_CATEGORIES, FEEDBACK_AUTHOR_KINDS, type FeedbackCategory, type FeedbackAuthorKind } from '@/lib/feedback'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Retroalimentación — Admin' }

type FeedbackRow = {
  id: string
  author_kind: FeedbackAuthorKind
  author_id: string
  author_label: string
  category: FeedbackCategory
  tool_name: string | null
  message: string
  created_at: string
}

type FeedbackSearchParams = { category?: string; author_kind?: string }

const CATEGORY_LABEL: Record<FeedbackCategory, string> = {
  feature: 'Función',
  'mcp-tool': 'Herramienta MCP',
  bug: 'Error',
}

const AUTHOR_KIND_LABEL: Record<FeedbackAuthorKind, string> = {
  seller: 'Vendedor',
  partner: 'Socio',
  agent: 'Agente',
  promoter: 'Promotor',
}

function buildFeedbackUrl(params: FeedbackSearchParams): string {
  const qs = new URLSearchParams()
  if (params.category) qs.set('category', params.category)
  if (params.author_kind) qs.set('author_kind', params.author_kind)
  const s = qs.toString()
  return s ? `/admin/feedback?${s}` : '/admin/feedback'
}

/**
 * Read-only admin list over `platform_feedback` (miyagi-partners-mcp S3) — the
 * `send_feedback` MCP tool's landing spot, newest first. Direct server-component
 * db read (no client state, no API route) — the same convention `/admin/audit`
 * and `/admin/flags` already use for a read-only list; filters are plain GET
 * links/`<select>`, mirroring `/admin/flags`'s `FlagsFilterBar` shape. No
 * edit/reply in v1 (sprint doc acceptance).
 */
export default async function AdminFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<FeedbackSearchParams>
}) {
  await requireAdmin()
  const params = await searchParams

  const category = FEEDBACK_CATEGORIES.includes(params.category as FeedbackCategory)
    ? (params.category as FeedbackCategory)
    : undefined
  const authorKind = FEEDBACK_AUTHOR_KINDS.includes(params.author_kind as FeedbackAuthorKind)
    ? (params.author_kind as FeedbackAuthorKind)
    : undefined

  let query = db
    .from('platform_feedback')
    .select('id, author_kind, author_id, author_label, category, tool_name, message, created_at')
    .order('created_at', { ascending: false })
    .limit(200)
  if (category) query = query.eq('category', category)
  if (authorKind) query = query.eq('author_kind', authorKind)

  const { data, error } = await query
  if (error) console.error('[admin/feedback] read failed:', error.message)
  const rows = (data ?? []) as FeedbackRow[]

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold mb-1">Retroalimentación</h1>
      <p className="text-sm text-[var(--fg-muted)] mb-5">
        Reportes enviados vía la herramienta MCP <code>send_feedback</code> — vendedores y socios. Más recientes primero.
      </p>

      <div className="flex flex-wrap gap-2 mb-3">
        <Link
          href={buildFeedbackUrl({ ...params, category: undefined })}
          className={`badge no-underline ${!category ? 'badge-verified' : 'badge-soft'}`}
        >
          Todas las categorías
        </Link>
        {FEEDBACK_CATEGORIES.map((c) => (
          <Link
            key={c}
            href={buildFeedbackUrl({ ...params, category: c })}
            className={`badge no-underline ${category === c ? 'badge-verified' : 'badge-soft'}`}
          >
            {CATEGORY_LABEL[c]}
          </Link>
        ))}
      </div>

      <form method="GET" action="/admin/feedback" className="flex flex-wrap gap-2 items-center mb-5">
        <input type="hidden" name="category" value={category ?? ''} />
        <select
          name="author_kind"
          defaultValue={authorKind ?? ''}
          className="border border-[var(--color-border)] rounded-lg px-2 py-2 text-sm"
        >
          <option value="">Todo autor</option>
          {FEEDBACK_AUTHOR_KINDS.map((k) => (
            <option key={k} value={k}>{AUTHOR_KIND_LABEL[k]}</option>
          ))}
        </select>
        <button type="submit" className="btn btn-secondary btn-sm">Filtrar</button>
      </form>

      {error ? (
        <p className="text-sm text-red-600">
          No se pudo leer la tabla de retroalimentación — intenta recargar. ({error.message})
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--fg-muted)]">Sin retroalimentación registrada todavía.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left border-b border-[var(--border)]">
                <th className="py-2 px-3 font-semibold">Cuándo</th>
                <th className="py-2 px-3 font-semibold">Autor</th>
                <th className="py-2 px-3 font-semibold">Categoría</th>
                <th className="py-2 px-3 font-semibold">Herramienta</th>
                <th className="py-2 px-3 font-semibold">Mensaje</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-[var(--border)] align-top">
                  <td className="py-2 px-3 whitespace-nowrap text-[var(--fg-muted)]">{fmt(r.created_at)}</td>
                  <td className="py-2 px-3">
                    {r.author_label}
                    <span className="block text-xs text-[var(--fg-muted)]">{AUTHOR_KIND_LABEL[r.author_kind] ?? r.author_kind}</span>
                  </td>
                  <td className="py-2 px-3">{CATEGORY_LABEL[r.category] ?? r.category}</td>
                  <td className="py-2 px-3 font-mono text-xs">{r.tool_name ?? '—'}</td>
                  <td className="py-2 px-3">{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
