import type { WordsBlock } from '@/lib/prompt-to-shop/blocks'

/**
 * The frequent questions written from the merchant's description (business-infrastructure S4.3), shown on the draft
 * BEFORE they go live (PR #469 review: generated answers must not reach the shop and its chat unseen). They become the
 * shop's FAQ at keep and the chat answers from them; the merchant edits them in Configuración › Páginas.
 */
export default function FaqCard({ words }: { words: WordsBlock | null }) {
  const faq = words?.faq ?? []
  if (!faq.length) return null
  return (
    <section className="card-panel grid gap-2" style={{ padding: 'var(--s-4)' }} data-testid="p2s-faq" aria-labelledby="p2s-faq-title">
      <div className="grid gap-0.5">
        <h2 id="p2s-faq-title" className="t-h4" style={{ margin: 0, letterSpacing: 0 }}>Preguntas frecuentes</h2>
        <p className="t-small" style={{ margin: 0, color: 'var(--fg-muted)' }}>
          Las escribimos con lo que nos contaste. Al quedarte con tu tienda se publican y el chat de tu tienda responde con ellas. Revísalas: las cambias cuando quieras en Configuración › Páginas.
        </p>
      </div>
      <dl className="grid gap-1" style={{ margin: 0 }}>
        {faq.map((it) => (
          <div key={it.question}>
            <dt className="t-small" style={{ fontWeight: 600 }}>{it.question}</dt>
            <dd className="t-small" style={{ margin: 0 }}>{it.answer}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
