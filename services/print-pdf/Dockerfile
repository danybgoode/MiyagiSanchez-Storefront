# PDF renderer — linux/arm64 image for the Oracle VM (share-kit S2.1, D12; was a Cloud Run image until 2026-10-16).
# node:24 on Debian bookworm + the distro Chromium (it pulls its own runtime libs), so puppeteer-core drives a system
# binary instead of downloading one. Built by `.github/workflows/image-arm64.yml` (job `print-pdf`) and pulled by
# digest by the root repo's `infra/oci/update.sh`.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

# Chromium + fonts (Liberation ≈ Arial for the retro headlines, DejaVu for accents) + CA certs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-dejavu-core \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY guard.js server.js ./

# Chromium never runs as root: the image's own `node` user (uid 1000).
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
