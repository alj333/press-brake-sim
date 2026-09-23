# syntax=docker/dockerfile:1.7
# Press Brake Simulator — multi-stage image (build the Vite front-end, then a slim runtime that
# serves dist/ + the shared tool-library API with Express 5 through tsx).
#
#   docker build -t press-brake-sim .
#   docker run -d -p 8080:8080 -v ./data:/data --name pbsim press-brake-sim
#
ARG NODE_IMAGE=node:22-alpine

# ── 1. build: type-check and bundle the front-end ───────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV CI=true NODE_OPTIONS=--max-old-space-size=2048
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY server ./server
RUN npm run build

# ── 2. deps: runtime node_modules — only what server/ needs (express) + tsx to run TypeScript ────
# The root package.json lists the client libraries (three, react, occt …) as dependencies because
# Vite bundles them; the runtime image must not carry them. A runtime manifest is derived from the
# root lockfile so the versions stay the ones the project was tested with.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN mkdir runtime && node -e " \
      const p = require('./package.json'), l = require('./package-lock.json'); \
      const keep = ['express', 'tsx']; \
      const deps = Object.fromEntries(keep.map(k => { const e = l.packages['node_modules/' + k]; if (!e) throw new Error('not in lockfile: ' + k); return [k, e.version]; })); \
      require('fs').writeFileSync('runtime/package.json', JSON.stringify({ name: p.name + '-runtime', version: p.version, private: true, type: 'module', dependencies: deps }, null, 2));" \
 && cd runtime && npm install --omit=dev --no-package-lock --no-audit --no-fund \
 && npm cache clean --force

# ── 3. runtime ──────────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="press-brake-sim" \
      org.opencontainers.image.description="Press brake bending simulator: import STEP/DXF, plan the bend program, simulate the folding"
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    DIST_DIR=/app/dist
WORKDIR /app
# su-exec: start as root to make the mounted /data writable, then drop to the unprivileged 'node' user
RUN apk add --no-cache su-exec
COPY --from=deps /app/runtime/node_modules ./node_modules
COPY --from=deps /app/runtime/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY server ./server
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/api/health" > /dev/null || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "server/index.ts"]
