import { redirect } from 'next/navigation'

/**
 * `/sell/bienvenida` left the main path (epic prompt-to-shop S3.3). The first run is now `/sell`'s describe box: a
 * merchant sees their shop before any intake question. The address stays alive as a redirect so an old link, an
 * email or a bookmark still lands somewhere useful.
 */
export default function BienvenidaPage() {
  redirect('/sell')
}
