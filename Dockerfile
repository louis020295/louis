FROM node:22-slim

WORKDIR /app

# package-lock.json is required for reproducible npm ci (node:sqlite lives in Node 22+).
# bun.lock remains for local bun install; do not switch this image to Bun (no node:sqlite).
COPY package.json package-lock.json bun.lock* .npmrc ./
RUN npm ci

COPY . .
RUN npm run build

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV RADAR_SQLITE_PATH=/app/data/radar_phase2.sqlite
ENV AUTO_BACKTEST_ENABLED=true

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
