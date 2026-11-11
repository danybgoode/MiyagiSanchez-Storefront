'use client'

import {
  AUTOS_TRUST_GROUP,
  CATEGORY_GROUPS,
  EVENT_FIELDS,
  GENERIC_CATEGORIES,
  GENERIC_FIELDS,
  RENTAL_GROUP,
  type AttrField,
} from '@/lib/listing-attributes'
import { InspectionReportField } from './InspectionReportField'
import { SEATS_HINT, SEATS_LABEL, hasEventBlock } from '@/lib/event-seats'

export type Attrs = Record<string, string | number | boolean>

export type ListingType = 'product' | 'service' | 'rental' | 'digital' | 'subscription'

const inputClass =
  'w-full border border-[var(--color-border)] rounded-[var(--r-sm)] px-3 py-2 text-sm bg-[var(--fg-inverse)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent'

/** Single schema-driven field renderer (text / number / select / date / time). */
function AttrInput({ field, attrs, setAttr }: {
  field: AttrField; attrs: Attrs; setAttr: (k: string, v: string) => void
}) {
  const value = (attrs[field.key] as string) ?? ''
  return (
    <div>
      <label className="block text-xs font-medium text-[var(--color-text)] mb-1">{field.label}</label>
      {field.type === 'select' ? (
        <select value={value} onChange={e => setAttr(field.key, e.target.value)} className={inputClass}>
          <option value="">Seleccionar…</option>
          {(field.options ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : field.type === 'number' ? (
        <input
          type="number"
          inputMode="numeric"
          value={value}
          onChange={e => setAttr(field.key, e.target.value)}
          placeholder={field.placeholder}
          min={field.min}
          max={field.max}
          className={inputClass}
        />
      ) : field.type === 'date' || field.type === 'time' ? (
        <input
          type={field.type}
          value={value}
          onChange={e => setAttr(field.key, e.target.value)}
          className={inputClass}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={e => setAttr(field.key, e.target.value.slice(0, field.maxLength ?? 80))}
          placeholder={field.placeholder}
          className={inputClass}
        />
      )}
    </div>
  )
}

function FieldGrid({ fields, attrs, setAttr }: {
  fields: AttrField[]; attrs: Attrs; setAttr: (k: string, v: string) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {fields.map(f => <AttrInput key={f.key} field={f} attrs={attrs} setAttr={setAttr} />)}
    </div>
  )
}

export function AttrsSection({ category, listingType, attrs, setAttr, seats, setSeats }: {
  category: string; listingType: ListingType; attrs: Attrs; setAttr: (k: string, v: string) => void
  /** «Lugares disponibles» (merchant-panel-gaps S1.1) — rendered inside the event block once it is filled. */
  seats?: string; setSeats?: (v: string) => void
}) {
  const eventBlock = (
    <div className="space-y-3 border border-purple-200 bg-purple-50/60 rounded-[var(--r-md)] p-4">
      <p className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wide">Detalles del evento</p>
      <FieldGrid fields={EVENT_FIELDS} attrs={attrs} setAttr={setAttr} />
      {setSeats && hasEventBlock(attrs) && (
        <div>
          <label htmlFor="event-seats" className="block text-xs font-medium text-[var(--color-text)] mb-1">{SEATS_LABEL}</label>
          <input
            id="event-seats"
            data-testid="event-seats"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={seats ?? ''}
            onChange={e => setSeats(e.target.value)}
            // No silent rewrite: «-3» or «2.5» reach seatsForWrite and are refused, never saved as 3 or 25 (codex review #490).
            className={`w-32 ${inputClass}`}
          />
          <p className="text-xs text-[var(--color-muted)] mt-1">{SEATS_HINT}</p>
        </div>
      )}
      <p className="text-xs text-[var(--color-muted)]">
        Opcional. Úsalo cuando este servicio o archivo digital sea una entrada, taller, clase o experiencia con fecha.
      </p>
    </div>
  )

  const panel = (group: { title: string; panelClass: string; fields: AttrField[] }) => (
    <div className={`space-y-3 border rounded-[var(--r-md)] p-4 ${group.panelClass}`}>
      <p className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wide">{group.title}</p>
      <FieldGrid fields={group.fields} attrs={attrs} setAttr={setAttr} />
    </div>
  )

  if (listingType === 'digital') return eventBlock
  if (listingType === 'subscription') return null

  // The category attribute panel (independent of the rental pricing panel below).
  const categoryContent = (() => {
    // Product-paneled categories take precedence over the service fallback.
    // Autos additionally get the financing/warranty panel + inspection-report
    // field (cars-vertical S2.1) — pricing/trust data, not vehicle specs.
    if (category === 'autos') {
      return (
        <div className="space-y-3">
          {panel(CATEGORY_GROUPS.autos)}
          {panel(AUTOS_TRUST_GROUP)}
          <InspectionReportField
            value={(attrs.inspection_report_url as string) ?? ''}
            onChange={v => setAttr('inspection_report_url', v)}
          />
        </div>
      )
    }
    if (['inmuebles', 'moda', 'electronica'].includes(category)) {
      return panel(CATEGORY_GROUPS[category])
    }
    // Services get their own panel + the optional event block.
    if (category === 'servicios' || listingType === 'service') {
      return (
        <div className="space-y-3">
          {panel(CATEGORY_GROUPS.servicios)}
          {eventBlock}
        </div>
      )
    }
    if (GENERIC_CATEGORIES.includes(category)) {
      return <FieldGrid fields={GENERIC_FIELDS} attrs={attrs} setAttr={setAttr} />
    }
    return null
  })()

  // Rentals (S4.2) lead with a pricing panel — rate period + deposit — that the
  // PDP date picker reads to compute the exact total. Shown above whatever
  // category panel applies (a rented car still captures its vehicle specs).
  if (listingType === 'rental') {
    return (
      <div className="space-y-3">
        {panel(RENTAL_GROUP)}
        {categoryContent}
      </div>
    )
  }

  return categoryContent
}
