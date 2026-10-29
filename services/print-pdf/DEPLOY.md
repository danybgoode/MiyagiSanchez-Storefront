# print-pdf — runbook

Headless Chromium that turns one of our print pages into a PDF. It runs as a container beside the app on the Oracle VM
(`panfleto-prod`) since share-kit S2.1. Before that it was a Cloud Run service, deleted with GCP on 2026-10-16, and every
PDF download answered 503 from then until S2.1 shipped.

## What talks to what
```
Seller «Descargar» / admin «Descargar PDF»
  → GET /api/catalogo/<slug>/pdf  ·  /api/admin/print/editions/<id>/pdf  ·  /api/admin/print/rate-card/pdf
  → lib/print-pdf-client.ts renderPrintPdf(url)
  → POST http://print-pdf:8080/pdf  { url }   x-internal-secret: PRINT_PDF_SECRET   (compose network only)
  → Chromium loads https://miyagisanchez.com/<print page> — and nothing off the allow-list (guard.js)
  → page.pdf({ preferCSSPageSize, printBackground }) → bytes back to the route
```

## Where it is configured
- **Image:** `ghcr.io/danybgoode/miyagisanchez-print-pdf:<sha>`, built by `.github/workflows/image-arm64.yml` (job
  `print-pdf`) when this directory changes on `main`.
- **Container:** root repo `infra/oci/docker-compose.yml` (service `print-pdf`). It sits on the `miyagi` network
  only, with no published port, `mem_limit 512m` and `cpus 0.2`. `infra/oci/update.sh` pins it by digest like the
  other two images; roll back with `PRINT_PDF_IMAGE_PIN=…:<sha>` in `infra/oci/.env`.
- **Env, renderer side (`infra/oci/print.env`, 0600):** `PRINT_PDF_SECRET`; `PRINT_PDF_ASSET_ORIGINS` (the public R2
  origin, `R2_PUBLIC_URL`'s scheme and host, so print-edition ad photos and QR codes load).
  `PRINT_PDF_ALLOWED_ORIGINS` defaults to `https://miyagisanchez.com`.
- **Env, app side (`infra/oci/web.env`):** `PRINT_PDF_URL=http://print-pdf:8080` and the same `PRINT_PDF_SECRET`.

## The rules it enforces (`guard.js`, tested by `node --test guard.test.js`, run in CI)
- The secret is compared in constant time. An unset secret refuses every call.
- The page URL must be on an allowed origin (403 otherwise, before Chromium starts), and Chromium loads that origin plus the path and query only, rebuilt from the allow-list. Every request the page makes,
  including each redirect hop, is checked too. Asset origins may serve images, fonts, stylesheets and media only.
- One render at a time, up to 4 waiting. The next caller gets 503 `busy`. Each render has a 45 s budget.

## Checking it on the VM
```bash
docker compose -f /opt/miyagi/infra/oci/docker-compose.yml logs --tail 50 print-pdf   # "[print-pdf] rendered …"
docker compose -f /opt/miyagi/infra/oci/docker-compose.yml exec web \
  node -e "fetch('http://print-pdf:8080/health').then(r=>r.text()).then(console.log)"
```
