FROM node:22-bookworm-slim

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      fonts-liberation \
      fonts-noto-color-emoji \
      gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/patch-whatsapp-web.mjs ./scripts/
RUN npm ci --include=dev

COPY . .
RUN npm run build
RUN npm prune --omit=dev
RUN mkdir -p /var/data \
    && chown -R root:root /app \
    && chown -R node:node /var/data \
    && chmod 0755 /app/docker-entrypoint.sh

ENV NODE_ENV=production
ENV WEB_CONCURRENCY=1

EXPOSE 10000

ENTRYPOINT ["/app/docker-entrypoint.sh"]

CMD ["npm", "start"]
