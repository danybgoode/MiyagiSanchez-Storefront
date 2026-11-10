/**
 * POST /api/shop/business-model — the merchant saves their own numbers (business-infrastructure S2.1/S2.3, D7).
 *
 * validate → owner → read → apply → conditional write. The seller is the caller's own (`getMySeller`, from their
 * Clerk token); nothing in the body names a seller or a row. The write is conditional on the `updated_at` the page
 * read, so a second tab's save is a 409 to reload, never a silent overwrite.
 */
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getMySeller } from '@/lib/get-my-seller'
import { applyPlanEdit, parsePlanEdit } from '@/lib/business-plan/edit'
import { readModel, writeInputs } from '@/lib/business-plan/store-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const COPY = {
  invalid: 'Revisa los números: deben ser cantidades de 0 o más.',
  auth: 'Inicia sesión para guardar tus números.',
  noShop: 'Primero necesitas una tienda.',
  stale: 'Tus números cambiaron en otra pestaña. Recarga la página.',
  unavailable: 'No pudimos guardar ahora. Inténtalo de nuevo en un momento.',
} as const

const fail = (status: number, code: keyof typeof COPY) => NextResponse.json({ error: COPY[code], code }, { status })

export async function POST(req: NextRequest) {
  // JSON only. A cross-site <form> can only send form encodings or text/plain, and a cross-origin JSON fetch needs a
  // preflight this route never grants: with the Clerk session cookie (SameSite=Lax) and the `updated_at` precondition,
  // this closes the forged-edit path the security pass raised on PR #467 (defence in depth, not the only guard).
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return fail(415, 'invalid')
  const edit = parsePlanEdit(await req.json().catch(() => null))
  if (!edit) return fail(400, 'invalid')

  const { userId } = await auth()
  if (!userId) return fail(401, 'auth')

  const seller = await getMySeller()
  if (!seller) return fail(404, 'noShop')

  const row = await readModel(seller.id)
  if (row === 'unavailable') return fail(503, 'unavailable')
  if (!row || row.updated_at !== edit.updated_at) return fail(409, 'stale')

  const next = applyPlanEdit(row.inputs, edit, new Date().toISOString())
  if (!next) return fail(400, 'invalid')

  const saved = await writeInputs(row, next)
  if (saved === 'unavailable') return fail(503, 'unavailable')
  if (!saved) return fail(409, 'stale')
  return NextResponse.json({ ok: true, inputs: saved.inputs, updated_at: saved.updated_at })
}
