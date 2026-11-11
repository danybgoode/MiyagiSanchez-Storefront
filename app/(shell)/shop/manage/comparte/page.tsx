import { redirect } from 'next/navigation'

/**
 * The share tools moved into Canales (merchant-features-surfaced-by-promoter-kit D8): the catalog link, PDF and Meta
 * feed are channels. The old URL is kept as a redirect for saved links.
 */
export default function ComparteRedirect(): never {
  redirect('/shop/manage/canal-propio')
}
