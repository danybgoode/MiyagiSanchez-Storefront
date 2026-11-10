'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import type { OwnerThread } from '@/lib/shop-chat/handoff-server'

function Thread({ thread }: { thread: OwnerThread }) {
  const router = useRouter()
  const [reply, setReply] = useState('')
  const [saveFaq, setSaveFaq] = useState(true)
  const [state, setState] = useState<{ kind: 'idle' | 'sending' } | { kind: 'done' | 'error'; message: string }>({ kind: 'idle' })

  async function send() {
    if (!reply.trim() || state.kind === 'sending') return
    setState({ kind: 'sending' })
    try {
      const res = await fetch(`/api/shop/questions/${thread.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: reply.trim(), save_faq: saveFaq }),
      })
      const body = (await res.json().catch(() => null)) as { message?: string } | null
      setState({ kind: res.ok ? 'done' : 'error', message: body?.message ?? 'No pudimos enviar tu respuesta.' })
      if (res.ok) router.refresh()
    } catch {
      setState({ kind: 'error', message: 'No pudimos enviar tu respuesta. Revisa tu conexión.' })
    }
  }

  return (
    <article className="card-panel grid gap-2" style={{ padding: 'var(--s-4)' }} data-testid="question" data-status={thread.status}>
      <p style={{ margin: 0, fontWeight: 600 }}>{thread.question}</p>
      {thread.transcript.length > 1 ? (
        <details className="t-small">
          <summary>Ver la conversación</summary>
          <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
            {thread.transcript.map((t, i) => <li key={i}><strong>{t.role === 'user' ? 'Comprador' : 'Chat'}:</strong> {t.text}</li>)}
          </ul>
        </details>
      ) : null}
      {thread.status === 'answered' ? (
        <p className="t-small" style={{ margin: 0 }}><strong>Tu respuesta:</strong> {thread.reply}</p>
      ) : (
        <div className="grid gap-2">
          <textarea className="input" rows={3} maxLength={600} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Tu respuesta" aria-label="Tu respuesta" data-testid="question-reply" />
          <label className="t-small flex items-center gap-2">
            <input type="checkbox" checked={saveFaq} onChange={(e) => setSaveFaq(e.target.checked)} />
            Guardar como pregunta frecuente (el chat la responde la próxima vez)
          </label>
          <div>
            <Button type="button" variant="primary" disabled={!reply.trim() || state.kind === 'sending'} onClick={() => void send()} data-testid="question-send">
              {state.kind === 'sending' ? 'Enviando…' : 'Responder'}
            </Button>
          </div>
        </div>
      )}
      {state.kind === 'done' || state.kind === 'error' ? <p className="t-small" role="status" style={{ margin: 0 }}>{state.message}</p> : null}
    </article>
  )
}

export default function QuestionsClient({ threads }: { threads: OwnerThread[] }) {
  return <div className="grid gap-3">{threads.map((t) => <Thread key={t.id} thread={t} />)}</div>
}
