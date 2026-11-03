# syntax=docker/dockerfile:1
# Build context is the REPO ROOT, because the pnpm lockfile lives there:
#   docker build -f apps/ui/Dockerfile -t agent-evals/ui:dev .

# ---- build: install with the frozen lockfile, typecheck and bundle ----
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_update_notifier=false
RUN corepack enable pnpm && corepack prepare pnpm@10.34.9 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/ui/package.json apps/ui/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @agent-evals/ui
COPY apps/ui/ apps/ui/
RUN pnpm --filter @agent-evals/ui build

# ---- runtime: static files served by nginx as the unprivileged nginx user ----
FROM nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236 AS runtime
# Our nginx.conf includes no conf.d files, so drop the stock server on port 80.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY apps/ui/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/apps/ui/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
