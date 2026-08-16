FROM node:22-bookworm-slim

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_DISABLE_SANDBOX=true

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
RUN npm ci --include=dev

COPY . .
RUN npm run build
RUN npm prune --omit=dev
RUN mkdir -p /var/data \
    && chown -R node:node /app /var/data \
    && chmod 0755 /app/docker-entrypoint.sh

ENV NODE_ENV=production

EXPOSE 10000

ENTRYPOINT ["/app/docker-entrypoint.sh"]

CMD ["npm", "start"]
