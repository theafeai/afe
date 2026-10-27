# syntax=docker/dockerfile:1
#
# Afe in-cluster ArgoCD agent (AFE-28): one bundled file on a distroless
# Node.js 22 image, running as the image's non-root user (uid 65532), with no
# shell and no package manager. Works with a read-only root filesystem.
#
#   docker build -f apps/argocd-agent/Dockerfile -t afe-argocd-agent .

ARG NODE_IMAGE=node:22-bookworm-slim
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian12:nonroot

# ---- build -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN npm install -g corepack@latest && corepack enable
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter @afe/argocd-agent...
RUN pnpm --filter @afe/argocd-agent build

# ---- runtime -----------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runtime
LABEL org.opencontainers.image.title="Afe ArgoCD agent" \
      org.opencontainers.image.description="Read-only in-cluster agent that sends ArgoCD Application changes to Afe" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/theafeai/afe"
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=build /src/apps/argocd-agent/dist/ /app/
USER 65532:65532
EXPOSE 8081
# The distroless image's entrypoint is `node`.
CMD ["/app/main.js"]
