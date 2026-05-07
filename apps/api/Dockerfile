# Multi-stage build for the API. Cloud Run needs a small, single-process container
# that listens on $PORT.

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/money/package.json packages/money/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @kpbooks/money build || true \
 && pnpm --filter @kpbooks/db build || true \
 && pnpm --filter @kpbooks/api build

FROM node:20-alpine AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/package.json ./package.json
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/node_modules ./node_modules
EXPOSE 8080
CMD ["node", "dist/server.js"]
