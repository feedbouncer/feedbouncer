# syntax=docker/dockerfile:1
# Placeholder image proving the CI Docker pipeline. Delete together with
# apps/placeholder-app. Real apps copy this shape: repo-root context,
# NODE_VERSION from .nvmrc (CI passes it), pnpm from packageManager.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS build
WORKDIR /repo
# Pin pnpm from package.json "packageManager" (corepack is not bundled from Node 25 on).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.replace(/^pnpm@/, '').split('+')[0]")"
# Lockfile-only fetch: this layer is cached until pnpm-lock.yaml changes.
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm turbo run build --filter=@feedbouncer/placeholder-app...

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo
# Placeholder simplicity: ships the built workspace. Real apps should
# prune to production deps (e.g. pnpm deploy) to shrink the image.
COPY --from=build --chown=node:node /repo /repo
USER node
CMD ["node", "apps/placeholder-app/dist/index.js"]
