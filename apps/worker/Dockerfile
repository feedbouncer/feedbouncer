# syntax=docker/dockerfile:1
# FeedBouncer worker image. Build context: repo root.
#   dev     - used by compose.yaml: source bind-mounted, tsx watch, hot reload.
#   runtime - LAST stage, so it is the default target CI builds.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.replace(/^pnpm@/, '').split('+')[0]")"
# Lockfile-only layer: cached until pnpm-lock.yaml changes.
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline

FROM base AS dev
RUN mkdir -p /var/lib/feedbouncer/privacy-exports \
  && chown node:node /var/lib/feedbouncer/privacy-exports
ENV NODE_ENV=development \
    NODE_OPTIONS=--conditions=@feedbouncer/source
WORKDIR /repo/apps/worker
USER node
CMD ["node_modules/.bin/tsx", "watch", "--clear-screen=false", "src/main.ts"]

FROM base AS build
RUN pnpm turbo run build --filter=@feedbouncer/worker...

FROM node:${NODE_VERSION}-slim AS runtime
RUN mkdir -p /var/lib/feedbouncer/privacy-exports \
  && chown node:node /var/lib/feedbouncer/privacy-exports
ENV NODE_ENV=production
# Dev-stack scope: ships the built workspace unpruned (see apps/api/Dockerfile).
COPY --from=build --chown=node:node /repo /repo
WORKDIR /repo/apps/worker
USER node
CMD ["node", "dist/main.js"]
