import type { IllustrationKey } from '@/lib/prompt-to-shop/blocks'
import { ILLUSTRATIONS } from '@/lib/prompt-to-shop/illustrations'

/**
 * A simple line drawing for an example card (prompt-to-shop D10). Coloured from the shop's own accent variable and
 * set on a tinted tile, so it reads as an illustration of the kind of thing the shop sells and never as a photo.
 */
export default function ExampleIllustration({ name }: { name: IllustrationKey }) {
  const shapes = ILLUSTRATIONS[name] ?? ILLUSTRATIONS.otros
  return (
    <div
      className="flex items-center justify-center h-36"
      style={{ background: 'color-mix(in srgb, var(--shop-accent, var(--color-accent)) 12%, transparent)' }}
      data-illustration={name}
    >
      <svg
        viewBox="0 0 64 64"
        width="72"
        height="72"
        fill="none"
        stroke="var(--shop-accent, var(--color-accent))"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {shapes.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </svg>
    </div>
  )
}
