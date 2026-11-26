# Incident Triage (Node.js). Python is included only for the demo's sample shop (DEMO_MODE=true).
FROM node:22-bookworm-slim AS build
WORKDIR /app/node
COPY node/package.json node/package-lock.json ./
RUN npm ci
COPY node/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY config ./config
COPY fixtures/sample_alerts.json ./fixtures/sample_alerts.json
COPY sample_app/__init__.py sample_app/shop.py ./sample_app/
COPY --from=build /app/node/package.json ./node/package.json
COPY --from=build /app/node/node_modules ./node/node_modules
COPY --from=build /app/node/dist ./node/dist
COPY node/views ./node/views
# The default DATABASE_URL (sqlite:///data/triage.db) writes here. On Render set DATABASE_URL to
# Postgres instead: the container's disk is wiped on every deploy.
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production PORT=8000
EXPOSE 8000
USER node
CMD ["node", "node/dist/src/server.js"]
