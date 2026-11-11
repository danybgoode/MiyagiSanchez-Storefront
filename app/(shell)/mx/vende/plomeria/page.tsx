import { businessTypeMetadata, renderBusinessTypePage } from '../_components/business-type-route'

export const metadata = businessTypeMetadata('plomeria')

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default function Page({ searchParams }: PageProps) {
  return renderBusinessTypePage('plomeria', searchParams)
}
