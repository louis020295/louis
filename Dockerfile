FROM node:22-slim

WORKDIR /app

COPY package.json bun.lock* package-lock.json* ./
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
