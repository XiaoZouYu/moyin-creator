FROM node:20-alpine AS builder

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:web

FROM node:20-alpine AS runner

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8088
ENV DIST_DIR=/app/dist
ENV CLOUD_STORAGE_DRIVER=local
ENV CLOUD_STORAGE_DIR=/app/data/cloud-storage
ENV CLOUD_MEDIA_DRIVER=local
ENV CLOUD_MEDIA_DIR=/app/data/cloud-media
ENV GENERATION_TASK_STORE_DIR=/app/data/generation-tasks

WORKDIR /app

RUN apk add --no-cache su-exec

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/scripts ./scripts

RUN mkdir -p /app/data/cloud-storage /app/data/cloud-media /app/data/generation-tasks \
  && chown -R node:node /app/data \
  && chmod +x /app/scripts/docker-entrypoint.sh

EXPOSE 8088

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8088) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "scripts/web-server.mjs"]
