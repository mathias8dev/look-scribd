# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --build-from-source=sqlite3

FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
  PORT=3000 \
  TZ=Europe/Paris \
  PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  LOOK_SCRIBD_DATA_DIR=/app/data \
  LOOK_SCRIBD_DOWNLOAD_DIR=/app/downloads

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules

RUN npm prune --omit=dev \
  && ./node_modules/.bin/playwright-core install --with-deps chromium \
  && chown -R node:node /ms-playwright

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server-dist ./server-dist
COPY docker-entrypoint.sh /usr/local/bin/look-scribd-entrypoint

RUN mkdir -p data downloads \
  && chown -R node:node data downloads \
  && chmod +x /usr/local/bin/look-scribd-entrypoint

EXPOSE 3000
VOLUME ["/app/data", "/app/downloads"]

ENTRYPOINT ["look-scribd-entrypoint"]
CMD ["node", "server-dist/index.js"]
