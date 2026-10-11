# syntax=docker/dockerfile:1
# FeedBouncer web image. Build context: repo root.
#   dev     - used by compose.yaml: next dev, src/ bind-mounted.
#   runtime - LAST stage, so it is the default target CI builds.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS base
ENV TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.replace(/^pnpm@/, '').split('+')[0]")"
# Lockfile-only layer: cached until pnpm-lock.yaml changes.
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline

FROM base AS dev
ENV NODE_ENV=development
WORKDIR /repo/apps/web
# next dev writes .next/ and next-env.d.ts into the app directory.
RUN mkdir -p .next && chown node:node . .next
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "dev", "--hostname", "0.0.0.0", "--port", "3000"]

FROM base AS build
RUN pnpm turbo run build --filter=@feedbouncer/web...

# Set API_INTERNAL_URL (the API's in-network URL) when running this image: the
# /api/* route handlers and server-rendered pages read it at request time.
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /repo /repo
WORKDIR /repo/apps/web
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
