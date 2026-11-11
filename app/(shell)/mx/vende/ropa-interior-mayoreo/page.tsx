import { businessTypeMetadata, renderBusinessTypePage } from '../_components/business-type-route'

export const metadata = businessTypeMetadata('ropa-interior-mayoreo')

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default function Page({ searchParams }: PageProps) {
  return renderBusinessTypePage('ropa-interior-mayoreo', searchParams)
}
