import { redirect } from 'next/navigation'
import { auth } from '@clerk/nextjs/server'
import { Banner } from '@/components/feedback/Banner'
import { listOwnerThreads } from '@/lib/shop-chat/handoff-server'
import QuestionsClient from './QuestionsClient'

export const metadata = { title: 'Preguntas — Mi tienda' }
export const dynamic = 'force-dynamic'

/**
 * «Preguntas» (business-infrastructure S5): the questions buyers left when the shop's chat could not answer. Only the
 * caller's own (scoped by their Clerk id); open first. Answering emails the buyer once; one tap adds it to the FAQ so the
 * chat answers it next time.
 */
export default async function QuestionsPage() {
  const { userId } = await auth()
  if (!userId) redirect('/sign-in?redirect_url=%2Fshop%2Fmanage%2Fpreguntas')
  const threads = await listOwnerThreads(userId)
  return (
    <div className="max-w-3xl mx-auto px-4 py-6 grid gap-4" data-testid="questions-page">
      <div className="grid gap-1">
        <h1 className="t-h2" style={{ margin: 0, letterSpacing: 0 }}>Preguntas</h1>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>
          Lo que te preguntaron en el chat de tu tienda y el chat no supo responder. Tu respuesta le llega a su correo.
        </p>
      </div>
      {threads === null ? (
        <Banner variant="warning">No pudimos leer tus preguntas ahora. Inténtalo de nuevo en un momento.</Banner>
      ) : threads.length === 0 ? (
        <p className="t-small" style={{ margin: 0 }} data-testid="questions-empty">Aún no te dejan preguntas. Cuando el chat de tu tienda no sepa algo, aquí aparece.</p>
      ) : (
        <QuestionsClient threads={threads} />
      )}
    </div>
  )
}
