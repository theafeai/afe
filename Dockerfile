# syntax=docker/dockerfile:1
#
# Afe container image: one image, roles selected by the command
# (`afe all` (default), `afe server`, `afe worker`, `afe migrate`,
# `afe reencrypt-credentials`). See docs/self-hosting/.
#
#   docker build -t afe .

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- build: install all deps, build the server bundle and the web UI ---------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
# A current corepack avoids signature-key errors of older bundled versions; it
# then provides the pnpm version pinned in package.json "packageManager".
RUN npm install -g corepack@latest && corepack enable
WORKDIR /src

# Download every locked package into the store using only the lockfile, so this
# layer is cached across source changes (pnpm's recommended Docker pattern).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile
# Server bundle (dist/cli.js + dist/migrations) and static web UI (apps/web/dist).
RUN pnpm --filter @afe/web build && pnpm --filter @afe/server build
# Production node_modules for the server only (third-party deps the bundle imports).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @afe/server deploy --prod --legacy /out

# ---- runtime -----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="Afe" \
      org.opencontainers.image.description="Live deployment visibility across GitHub, ArgoCD and Vercel" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/theafeai/afe"

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    AFE_HOST=0.0.0.0 \
    AFE_PORT=8080 \
    AFE_WEB_DIR=/app/web

WORKDIR /app
# Everything is owned by root and only readable by the runtime user, so the
# container works with a read-only root filesystem (nothing is written at runtime).
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/web/dist ./web
RUN chmod 0755 /app/dist/cli.js && ln -s /app/dist/cli.js /usr/local/bin/afe

# Unprivileged user provided by the node image (uid/gid 1000).
USER node
EXPOSE 8080

# Probes GET /healthz (database reachable). Applies to roles that serve HTTP
# (`all`, `server`); disable it for `worker` containers (see docker-compose.yml).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AFE_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["afe"]
CMD ["all"]
