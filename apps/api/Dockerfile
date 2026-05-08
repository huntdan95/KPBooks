# Single-stage build for the API on Cloud Run.
#
# We build from the monorepo root so workspace deps (@kpbooks/db, @kpbooks/money)
# resolve correctly via pnpm's symlink layout. Earlier multi-stage attempt copied
# only node_modules into a fresh /app and broke pnpm's .pnpm/-relative symlinks.
#
# Image is ~250 MB — a bit larger than a hyper-optimized multi-stage build but
# reliable, and Cloud Run cold-start is dominated by Node startup, not image size.

FROM node:20-slim
RUN corepack enable \
    && corepack prepare pnpm@9.12.0 --activate \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Install all workspace deps (pnpm hoists, symlinks resolve in-tree).
# --frozen-lockfile fails CI fast if pnpm-lock.yaml is out of date.
RUN pnpm install --frozen-lockfile

# Bundle the API into apps/api/dist via tsup.
RUN pnpm --filter @kpbooks/api build

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Cloud Run reads $PORT and expects the process to bind 0.0.0.0:$PORT.
# Our config.ts does exactly that.
CMD ["node", "apps/api/dist/server.js"]
