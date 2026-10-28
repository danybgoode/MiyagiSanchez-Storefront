/**
 * Prompt-to-shop — the real database reads behind the two canvas routes (epic S2.4/S2.5, D15).
 *
 * The ONLY file that selects by `view_token` (a spec sweeps the source to keep it so). Each read is a single
 * conditional query: ownership and expiry are part of the WHERE clause, never a check made after the fetch.
 */

import 'server-only'
import { db } from '@/lib/supabase'
import type { ReadDeps } from './access'

const OWNED_COLUMNS = 'id, identity, words, catalog, block_status, versions_used, updated_at, view_token'
// Content only. No id, no device_id, no description, no claim fields: a viewer is shown the shop and nothing about
// who made it or how to change it.
const SHARED_COLUMNS = 'identity, words, catalog, block_status'

export const readDeps: ReadDeps = {
  findOwned: async (draftId, deviceId) => {
    const { data, error } = await db
      .from('shop_drafts')
      .select(OWNED_COLUMNS)
      .eq('id', draftId)
      .eq('device_id', deviceId)
      .is('claimed_by', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    return error || !data ? null : (data as never)
  },
  // A CLAIMED draft is still viewable: by then its content is, or is about to be, a public shop, so the preview
  // link keeps working until it expires. The link grants no edit either way.
  findByViewToken: async (token) => {
    const { data, error } = await db
      .from('shop_drafts')
      .select(SHARED_COLUMNS)
      .eq('view_token', token)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    return error || !data ? null : (data as never)
  },
}
