import type { Metadata } from 'next'
import ucpUseCases from '@/ucp-use-cases.json'
import { UCP_ENDPOINTS, MCP_BUYER_TOOLS, MCP_SELLER_TOOLS } from '@/lib/ucp/capabilities'
import { RELAY_LANGUAGE_DIRECTIVE } from '@/lib/about-agent'
import { getOverriddenAboutSections } from '@/lib/about-content-overrides'
import { buildSetupPrompt, EXAMPLE_SETUP, SETUP_SPEC_VERSION, SETUP_LANGUAGE_DIRECTIVE } from '@/lib/setup-spec'
import { getComparatorDataset } from '@/lib/cost-comparator-data'
import { SELLER_LANDING_PATHS } from '@/lib/seller-acquisition'

const BASE_URL = 'https://miyagisanchez.com'
const PAGE_PATH = '/agent'
const TITLE = 'Ficha para agentes — Miyagi Sánchez'
const DESCRIPTION =
  'Ficha legible por máquinas para agentes de IA y clientes MCP: capacidades, casos de uso UCP, endpoints de la API y cómo operar como dependiente de tienda en miyagisanchez.com.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  robots: { index: true, follow: true },
  // Was missing entirely (agent-readability-marketing-surface Story 1.2) — the
  // page inherited the root layout's canonical-less default and its og:url
  // pointed at `/` instead of itself. Both fixed here, self-referential.
  alternates: { canonical: `${BASE_URL}${PAGE_PATH}` },
  openGraph: {
    type: 'website',
    locale: 'es_MX',
    url: `${BASE_URL}${PAGE_PATH}`,
    siteName: 'Miyagi Sánchez',
    title: TITLE,
    description: DESCRIPTION,
  },
}

const ENDPOINT = 'https://miyagisanchez.com'

const PRODUCT_TYPES = [
  { icon: 'iconoir-package', label: 'Productos físicos', note: 'con envío opcional' },
  { icon: 'iconoir-graduation-cap', label: 'Productos digitales', note: 'entrega instantánea vía R2' },
  { icon: 'iconoir-repeat', label: 'Suscripciones', note: 'cobro recurrente con Stripe' },
  { icon: 'iconoir-wrench', label: 'Servicios', note: 'con reserva, a cotización' },
  { icon: 'iconoir-home', label: 'Rentas', note: 'precio diario / semanal' },
]

const PAYMENT_METHODS = [
  { label: 'Stripe', note: 'tarjetas, OXXO, Link — internacional' },
  { label: 'MercadoPago', note: 'SPEI, tarjetas, efectivo — nativo de México' },
  { label: 'Transferencia SPEI', note: 'transferencia bancaria directa (manual)' },
]

export default async function AgentPage() {
  // Supply-side "why sell" content, rendered from the admin-overridden single source
  // (locales/*.json `acerca` namespace, via lib/about-content-overrides.ts) so this
  // section can never drift from /acerca, the manifest, /llms.txt, or the MCP resource —
  // and reflects any admin copy edit the same way those surfaces do.
  const sections = await getOverriddenAboutSections()
  const WHY_SELL = sections.find((s) => s.id === 'why_sell')!.es
  const HOW_TO_START = sections.find((s) => s.id === 'how_to_start')!.es
  const COST = sections.find((s) => s.id === 'cost_transparency')!.es

  // Comparador de costos (epic 08 · cost-comparator-homepage, Sprint 2 · US-2.3) —
  // dataset + methodology, agent-readable. Same getComparatorDataset() the
  // /comparador page and the compare_costs MCP tool both read — one source, three
  // surfaces, never drifts (AGENTS rule #3).
  const comparatorDataset = await getComparatorDataset('es')

  return (
    <div
      className="app-shell"
      style={{ paddingTop: 28, paddingBottom: 64, maxWidth: 'var(--measure-prose)' }}
    >
      {/* Machine-readable JSON-LD for AI crawlers */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebAPI',
            name: 'Miyagi Sánchez Marketplace API',
            description:
              'Marketplace P2P sin comisiones para México. Compatible con UCP (Universal Commerce Protocol) y MCP para comercio con agentes de IA.',
            // Supply-side answer + the agent-relay directive, machine-readable.
            disambiguatingDescription: RELAY_LANGUAGE_DIRECTIVE,
            url: ENDPOINT,
            documentation: `${ENDPOINT}/agent`,
            provider: {
              '@type': 'Organization',
              name: 'Miyagi Sánchez',
              url: ENDPOINT,
              description: WHY_SELL.body[0],
              sameAs: `${ENDPOINT}/acerca`,
            },
          }),
        }}
      />

      {/* Badge */}
      <div style={{ marginBottom: 20 }}>
        <span className="badge badge-agent" style={{ fontSize: 11 }}>
          <i className="iconoir-sparks" style={{ fontSize: 12 }} />
          Ficha para agentes
        </span>
      </div>

      {/* Title */}
      <h1 className="t-h1" style={{ marginBottom: 6 }}>
        Miyagi Sánchez
      </h1>
      <p className="t-lead" style={{ marginBottom: 32 }}>
        Marketplace sin comisiones para México — construido sobre el{' '}
        <a href="https://ucp.dev" target="_blank" rel="noopener noreferrer">
          Universal Commerce Protocol
        </a>{' '}
        (UCP) y compatible con MCP para comercio con agentes de IA.
      </p>

      <hr style={{ border: 'none', borderTop: '1px solid var(--border)', marginBottom: 36 }} />

      {/* What we are */}
      <section style={{ marginBottom: 40 }}>
        <h2 className="t-h3" style={{ marginBottom: 12 }}>¿Qué es este marketplace?</h2>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)', lineHeight: 1.7, marginBottom: 12 }}>
          Miyagi Sánchez es un marketplace multi-vendedor C2C y B2C para México. Los vendedores publican
          productos en varios canales al mismo tiempo: el marketplace principal, su propio dominio de
          marca, un widget embebible y una API headless. <strong>Comisión: 0%.</strong>
        </p>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)', lineHeight: 1.7 }}>
          La plataforma está diseñada para comercio nativo con IA. Los compradores pueden instruir a un
          agente de IA para buscar, negociar y completar compras en su nombre a través de la API UCP,
          sin necesidad de tocar una interfaz de navegador.
        </p>
      </section>

      {/* Para vender — why sell (supply-side, rendered from lib/about-content.ts) */}
      <section style={{ marginBottom: 40 }}>
        <h2 className="t-h3" style={{ marginBottom: 12 }}>Para vender — por qué vender aquí</h2>

        {/* Relay-language directive: present to the user in their own language. */}
        <div
          style={{
            display: 'flex',
            gap: 10,
            padding: '12px 14px',
            background: 'var(--agent-soft)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)',
            fontSize: 13,
            color: 'var(--agent)',
            lineHeight: 1.6,
            marginBottom: 16,
          }}
        >
          <i className="iconoir-translate" style={{ fontSize: 'var(--t-base)', flexShrink: 0, marginTop: 2 }} />
          <span><strong>Instrucción de relevo:</strong> {RELAY_LANGUAGE_DIRECTIVE}</span>
        </div>

        <p style={{ fontSize: 14, color: 'var(--fg-muted)', lineHeight: 1.7, marginBottom: 12 }}>
          {WHY_SELL.body[0]} {WHY_SELL.body[1]}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {(WHY_SELL.points ?? []).map(({ title, body }) => (
            <div
              key={title}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 12,
                padding: '10px 14px',
                background: 'var(--bg-sunk)',
                borderRadius: 'var(--r-md)',
                fontSize: 14,
              }}
            >
              <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{title}</span>
              <span style={{ color: 'var(--fg-muted)', marginLeft: 'auto', textAlign: 'right' }}>{body}</span>
            </div>
          ))}
        </div>

        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 6 }}>{HOW_TO_START.heading}</p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {(HOW_TO_START.points ?? []).map(({ title }) => (
            <code
              key={title}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--bg-sunk)', padding: '3px 8px', borderRadius: 4, color: 'var(--fg-muted)' }}
            >
              {title}
            </code>
          ))}
        </div>

        <p style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.6, marginBottom: 14 }}>
          {COST.body[0]} Vender es gratis (0% de comisión); los servicios premium (dominio propio,
          subdominio) tienen precio por confirmar.
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a href={`${ENDPOINT}/acerca`} className="btn btn-agent btn-sm">
            <i className="iconoir-info-circle" style={{ fontSize: 14 }} />
            Acerca de — /acerca (es/en)
          </a>
          {/*
            * `/vende` moved under its market prefix — this surface is es-MX (see the
            * sibling es-MX body-copy spec), so it recruits into the Mexican landing.
            * Read from SELLER_LANDING_PATHS rather than repeating the literal: this
            * link was left behind by the move precisely because it was a literal, and
            * it is absolute (agents copy it out of the page), so a 308 would have been
            * invisible here rather than merely a wasted hop.
            */}
          <a href={`${ENDPOINT}${SELLER_LANDING_PATHS.mx}`} className="btn btn-secondary btn-sm">
            <i className="iconoir-shop" style={{ fontSize: 14 }} />
            {/* The MX landing is `/` since root-shop-builder-home, so the label names the
                full address — a bare "/" reads as nothing to a person or an agent. */}
            Para vendedores — {`${ENDPOINT}${SELLER_LANDING_PATHS.mx}`.replace(/^https:\/\//, '')}
          </a>
        </div>
      </section>

      {/* Onboarding 0 — set up a shop with your agent (Agent-native setup, Sprint 1) */}
      <section style={{ marginBottom: 40 }}>
        <h2 className="t-h3" style={{ marginBottom: 12 }}>Para vender — configura tu tienda con tu agente</h2>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)', lineHeight: 1.7, marginBottom: 12 }}>
          Un vendedor interesado puede pedirle a su <strong>propio</strong> agente de IA que prepare casi
          toda la tienda antes de registrarse. Obtén la especificación de configuración publicada y
          versionada, y luego emite UN solo archivo combinado — perfil de tienda + configuración de la
          tienda + catálogo — en una sola forma:
        </p>

        <pre
          style={{
            background: 'var(--papel-900)',
            color: 'var(--agent-code-fg)',
            borderRadius: 'var(--r-md)',
            padding: '14px 16px',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            overflowX: 'auto',
            lineHeight: 1.7,
            marginBottom: 14,
          }}
        >
{`{
  "miyagi_setup_version": "${SETUP_SPEC_VERSION}",
  "profile":  { ...identidad de la tienda (opcional) },
  "config":   { ...bloques del StoreConfigManifest (opcional) },
  "catalog":  [ ...un CatalogImportRow por producto (opcional) ]
}`}
        </pre>

        {/* Language directive — the agent localizes copy to the seller. */}
        <div
          style={{
            display: 'flex',
            gap: 10,
            padding: '12px 14px',
            background: 'var(--agent-soft)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)',
            fontSize: 13,
            color: 'var(--agent)',
            lineHeight: 1.6,
            marginBottom: 14,
          }}
        >
          <i className="iconoir-translate" style={{ fontSize: 'var(--t-base)', flexShrink: 0, marginTop: 2 }} />
          <span><strong>Idioma:</strong> {SETUP_LANGUAGE_DIRECTIVE}</span>
        </div>

        <p style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.6, marginBottom: 8 }}>
          La especificación legible por máquinas (esquema, ambos sub-esquemas, ejemplo y el prompt de
          emisión) vive en el endpoint de abajo, y también está disponible como la herramienta MCP{' '}
          <code style={{ fontFamily: 'var(--font-mono)' }}>get_setup_spec</code>.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <a href={`${ENDPOINT}/api/ucp/setup-spec`} className="btn btn-agent btn-sm">
            <i className="iconoir-code" style={{ fontSize: 14 }} />
            API de la especificación — /api/ucp/setup-spec
          </a>
        </div>

        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 6 }}>Prompt para copiar (es-MX)</p>
        <pre
          style={{
            background: 'var(--papel-900)',
            color: 'var(--agent-code-fg)',
            borderRadius: 'var(--r-md)',
            padding: '14px 16px',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            overflowX: 'auto',
            lineHeight: 1.6,
            marginBottom: 14,
            maxHeight: 360,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {buildSetupPrompt()}
        </pre>

        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 6 }}>Ejemplo de salida</p>
        <pre
          style={{
            background: 'var(--bg-sunk)',
            color: 'var(--fg)',
            borderRadius: 'var(--r-md)',
            padding: '14px 16px',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            overflowX: 'auto',
            lineHeight: 1.6,
            marginBottom: 12,
            maxHeight: 300,
            overflowY: 'auto',
          }}
        >
          {JSON.stringify(EXAMPLE_SETUP, null, 2)}
        </pre>

        <p style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
          <strong>Para aplicarlo hoy:</strong> el vendedor se registra (~20 segundos) y sube el archivo
          mediante el flujo de importación existente — catálogo en{' '}
          <code style={{ fontFamily: 'var(--font-mono)' }}>/shop/manage/import</code>
          {' '}y configuración en <code style={{ fontFamily: 'var(--font-mono)' }}>/shop/manage/settings/import</code>.
          Una aplicación guiada en un solo paso está próximamente. Pagos, dominio propio y Cal.com
          siempre requieren un paso manual.
        </p>
      </section>

      {/* Product types */}
      <section style={{ marginBottom: 40 }}>
        <h2 className="t-h3" style={{ marginBottom: 14 }}>Tipos de producto compatibles</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {PRODUCT_TYPES.map(({ icon, label, note }) => (
            <div
              key={label}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 14px',
                background: 'var(--bg-sunk)',
                borderRadius: 'var(--r-md)',
                fontSize: 14,
              }}
            >
              <i className={icon} aria-hidden style={{ fontSize: 20 }} />
              <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{label}</span>
              <span style={{ color: 'var(--fg-muted)', marginLeft: 'auto' }}>{note}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Payments */}
      <section style={{ marginBottom: 40 }}>
        <h2 className="t-h3" style={{ marginBottom: 14 }}>Métodos de pago</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {PAYMENT_METHODS.map(({ label, note }) => (
            <div
              key={label}
              style={{
                padding: '10px 16px',
                background: 'var(--bg-sunk)',
                borderRadius: 'var(--r-md)',
                fontSize: 13,
              }}
            >
              <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{label}</span>
              <span style={{ color: 'var(--fg-muted)', display: 'block', marginTop: 2 }}>{note}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Comparador de costos — datos + metodología (epic 08, Sprint 2 · US-2.3) */}
      <section style={{ marginBottom: 40 }}>
        <h2 className="t-h3" style={{ marginBottom: 12 }}>Comparador de costos — datos y metodología</h2>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)', lineHeight: 1.7, marginBottom: 12 }}>
          Miyagi Sánchez publica un modelo de costos apilados (plan/alojamiento + procesamiento de pago +
          apps premium) para comparar lo que un comercio paga hoy en <strong>Shopify</strong>,{' '}
          <strong>Mercado Libre</strong>, <strong>WooCommerce</strong> o <strong>Tiendanube</strong> contra
          el equivalente en Miyagi (0% de comisión, apps incluidas). Cada cifra de la competencia está
          fechada y citada — nunca se inventa un número. La herramienta MCP{' '}
          <code style={{ fontFamily: 'var(--font-mono)' }}>compare_costs</code> calcula con el{' '}
          <strong>mismo modelo puro</strong> que renderiza la página pública, por lo que la respuesta de
          un agente y lo que muestra la página nunca divergen.
        </p>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.6, marginBottom: 14 }}>
          Datos verificados: <strong>{comparatorDataset.generatedAt}</strong> ·{' '}
          {Object.keys(comparatorDataset.figures).length} cifras con fuente (plan/alojamiento, tarifa de
          pago, comisión por categoría, tipo de cambio USD→MXN, apps premium típicas). Estos datos pueden
          editarse en vivo desde el panel de administración; sin ediciones, se sirve la línea base
          versionada en el repositorio.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a href={`${ENDPOINT}/comparador`} className="btn btn-agent btn-sm">
            <i className="iconoir-stats-report" style={{ fontSize: 14 }} />
            Comparador — /comparador
          </a>
        </div>
      </section>

      {/* API endpoints */}
      <section style={{ marginBottom: 40 }}>
        <h2 className="t-h3" style={{ marginBottom: 14 }}>Endpoints de la API (UCP)</h2>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 14, lineHeight: 1.6 }}>
          URL base: <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-sunk)', padding: '2px 6px', borderRadius: 4 }}>{ENDPOINT}</code>
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {UCP_ENDPOINTS.map(({ method, path, description, auth }) => (
            <div
              key={path}
              style={{
                padding: '12px 14px',
                background: 'var(--bg-sunk)',
                borderRadius: 'var(--r-md)',
                fontSize: 13,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                <span
                  className="badge badge-mono"
                  style={{ fontSize: 10, padding: '3px 8px' }}
                >
                  {method}
                </span>
                <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)', fontSize: 13 }}>
                  {path}
                </code>
                {auth !== 'none' && (
                  <span className="badge badge-soft" style={{ fontSize: 9, marginLeft: 'auto' }}>auth</span>
                )}
              </div>
              <p style={{ color: 'var(--fg-muted)', margin: 0, lineHeight: 1.5 }}>{description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* MCP setup */}
      <section style={{ marginBottom: 40 }}>
        <h2 className="t-h3" style={{ marginBottom: 12 }}>Configuración del servidor MCP</h2>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)', lineHeight: 1.7, marginBottom: 14 }}>
          Agrega Miyagi Sánchez como servidor MCP remoto en Claude Desktop o cualquier cliente compatible
          con MCP:
        </p>
        <pre
          style={{
            background: 'var(--papel-900)',
            color: 'var(--agent-code-fg)',
            borderRadius: 'var(--r-md)',
            padding: '16px 18px',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            overflowX: 'auto',
            lineHeight: 1.7,
          }}
        >
          {`// claude_desktop_config.json
{
  "mcpServers": {
    "miyagi-sanchez": {
      "url": "${ENDPOINT}/api/ucp/mcp",
      "transport": "http"
    }
  }
}`}
        </pre>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 10, lineHeight: 1.6 }}>
          Una vez conectado, Claude puede explorar publicaciones, revisar el puntaje de confianza de un
          vendedor, negociar precios y completar compras de forma autónoma en tu nombre.
        </p>

        {/* MCP tools */}
        <div style={{ marginTop: 18 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 6 }}>Herramientas de comprador (sin auth)</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
            {MCP_BUYER_TOOLS.map((t) => (
              <code key={t} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--bg-sunk)', padding: '3px 8px', borderRadius: 4, color: 'var(--fg-muted)' }}>{t}</code>
            ))}
          </div>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 6 }}>Herramientas de vendedor (token de agente de tienda)</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {MCP_SELLER_TOOLS.map((t) => (
              <code key={t} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--agent-soft)', padding: '3px 8px', borderRadius: 4, color: 'var(--agent)' }}>{t}</code>
            ))}
          </div>
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.6 }}>
            Las herramientas de vendedor leen y ajustan la configuración propia de una tienda. Requieren
            un token por tienda
            (<code style={{ fontFamily: 'var(--font-mono)' }}>Authorization: Bearer ms_agent_…</code>)
            generado en la configuración de la tienda, con alcance a esa sola tienda. Pagos, dominio
            propio y Cal.com siempre son manuales.
          </p>
        </div>
      </section>

      {/* UCP use cases */}
      <section style={{ marginBottom: 40 }}>
        <h2 className="t-h3" style={{ marginBottom: 6 }}>Casos de uso habilitados por UCP</h2>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 16, lineHeight: 1.6 }}>
          Estas son capacidades reales, impulsadas por el{' '}
          <a href="https://ucp.dev" target="_blank" rel="noopener noreferrer">
            Universal Commerce Protocol
          </a>
          :
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {ucpUseCases.map((uc, i) => (
            <div
              key={i}
              style={{
                padding: '16px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md)',
                background: 'var(--bg-elevated)',
              }}
            >
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <span className="badge badge-agent" style={{ fontSize: 10 }}>
                  {uc.domain}
                </span>
                <span className="badge badge-soft" style={{ fontSize: 10 }}>
                  {uc.ucp_mechanism}
                </span>
              </div>
              <p
                style={{
                  fontSize: 13,
                  color: 'var(--fg-muted)',
                  margin: 0,
                  lineHeight: 1.6,
                }}
              >
                <strong style={{ color: 'var(--fg)' }}>Dolor: </strong>
                {uc.primary_pain_point}
              </p>
              <p
                style={{
                  fontSize: 13,
                  color: 'var(--fg-muted)',
                  margin: '6px 0 0',
                  lineHeight: 1.6,
                }}
              >
                <strong style={{ color: 'var(--fg)' }}>Flujo: </strong>
                {uc.operational_flow}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* External references */}
      <section>
        <h2 className="t-h3" style={{ marginBottom: 14 }}>Referencias externas</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a
            href="https://ucp.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-agent btn-sm"
          >
            <i className="iconoir-globe" style={{ fontSize: 14 }} />
            ucp.dev — especificación del protocolo
          </a>
          <a
            href={ENDPOINT}
            className="btn btn-secondary btn-sm"
          >
            <i className="iconoir-shop" style={{ fontSize: 14 }} />
            Marketplace en vivo
          </a>
          <a
            href={`${ENDPOINT}/api/ucp/catalog`}
            className="btn btn-secondary btn-sm"
          >
            <i className="iconoir-code" style={{ fontSize: 14 }} />
            Explorar API de catálogo
          </a>
        </div>
      </section>
    </div>
  )
}
