# syntax=docker/dockerfile:1
# Build context is the REPO ROOT, because the pnpm lockfile lives there:
#   docker build -f apps/api/Dockerfile -t agent-evals/api:dev .

ARG NODE_IMAGE=node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

# ---- base: Node plus pnpm pinned through corepack ----
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_update_notifier=false
RUN corepack enable pnpm && corepack prepare pnpm@10.34.9 --activate
WORKDIR /repo
# Only the manifests, so the install layers are cached until dependencies change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/

# ---- build: all dependencies, compile TypeScript to dist ----
FROM base AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @agent-evals/api
COPY apps/api/ apps/api/
RUN pnpm --filter @agent-evals/api build

# ---- prod-deps: production dependencies only, from the same frozen lockfile ----
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @agent-evals/api

# ---- runtime: no pnpm, no dev dependencies, no sources; the server runs as node ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /repo
# pnpm keeps packages in the root node_modules/.pnpm and symlinks them from the app;
# COPY --from keeps the symlinks. Files stay root-owned, so the app cannot rewrite itself.
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY apps/api/package.json ./apps/api/package.json
# Plain SQL, applied in order at startup (src/database/migrate.ts reads ../../migrations).
COPY apps/api/migrations ./apps/api/migrations
# The grader framework's spec schema, at its repo path, so the catalogue checks each task's graders
# against the very file the grader checks them against (A5). Copied, not mounted: the grader image
# copies it too, so both containers built from one checkout hold the same schema.
COPY graders/src/evals_graders/grader-spec.schema.json ./graders/src/evals_graders/grader-spec.schema.json
# The start-up step: as root, it makes the three folders the API writes (mounted from the host)
# usable by node, uid 1000, then runs the server as node with setpriv, which the base image has.
# The server never runs as root. See the script for exactly what it changes, and when.
COPY --chmod=0755 apps/api/docker-entrypoint.sh /usr/local/bin/api-entrypoint
WORKDIR /repo/apps/api
EXPOSE 3000
# Node 22 has fetch built in, so the check needs no curl. Healthy only on HTTP 200, so the
# container reports unhealthy while a configured database is down or a folder the API writes is
# not writable (503); the reply's plain words land in `docker inspect`'s health log.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(async (r) => { if (!r.ok) console.error(await r.text()); process.exit(r.ok ? 0 : 1); }, (e) => { console.error(String(e)); process.exit(1); })"]
ENTRYPOINT ["/usr/local/bin/api-entrypoint"]
CMD ["node", "dist/main.js"]
