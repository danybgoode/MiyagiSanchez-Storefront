import { redirect } from 'next/navigation'

/**
 * `/sell/puertas` left the main path (epic prompt-to-shop S3.3). The three doors are now on `/sell` itself: describe
 * your business (the first run), «¿Ya tienes tu catálogo en un archivo?» (`/sell/setup`) and «Armar a mano» (the
 * wizard). The address stays alive as a redirect so an old link still lands somewhere useful.
 */
export default function PuertasPage() {
  redirect('/sell')
}
