import Link from 'next/link'

/**
 * «Crear con IA» on the dashboard home (epic one-front-door-both-markets S4.1, D20; product owner 2026-11-12: "card on
 * dashboard home"). Before this, the shop builder's tools — a photo, a catalog file, a store link — were reachable
 * only while building a NEW shop; a merchant who already had one could not find them. Each choice opens the import
 * page's «Crear con IA» section, where the result is reviewed before anything is created.
 */
const CHOICES = [
  { icon: 'iconoir-camera', label: 'Desde una foto', body: 'Toma una foto de lo que vendes y llenamos la ficha.' },
  { icon: 'iconoir-page', label: 'Desde tu lista', body: 'Tu Excel, tu PDF o tu lista en texto.' },
  { icon: 'iconoir-link', label: 'Desde tu tienda anterior', body: 'Pega el link de tu tienda en Shopify, Big Cartel u otra.' },
] as const

export default function CreateWithAiCard() {
  return (
    <section data-testid="dashboard-crear-con-ia" className="border border-[var(--color-border)] rounded-[var(--r-lg)] p-5 mb-8">
      <h2 className="font-semibold mb-1 flex items-center gap-2">
        <i className="iconoir-magic-wand text-xl" aria-hidden /> Crear con IA
      </h2>
      <p className="text-sm text-[var(--color-muted)] mb-4">Agrega productos a tu tienda en segundos, con lo que ya tienes.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        {CHOICES.map((c) => (
          <Link
            key={c.label}
            href="/shop/manage/import#crear-con-ia"
            prefetch={false}
            className="block border border-[var(--color-border)] rounded-[var(--r-md)] p-4 hover:bg-[var(--surface-muted)] transition-colors"
          >
            <i className={`${c.icon} text-xl`} aria-hidden />
            <span className="block font-semibold mt-2">{c.label}</span>
            <span className="block text-xs text-[var(--color-muted)] mt-1">{c.body}</span>
          </Link>
        ))}
      </div>
    </section>
  )
}
