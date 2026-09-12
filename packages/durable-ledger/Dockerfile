# syntax=docker/dockerfile:1
# Build context is the REPO ROOT (pnpm workspace root), not this directory:
#   docker build -f packages/durable-ledger/Dockerfile .
FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Honours "packageManager": "pnpm@11.1.3" from the root package.json.
RUN corepack enable
WORKDIR /repo

FROM base AS build
# CI=true is REQUIRED: without it, the `--prod` prune step below dies with
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY.
ENV CI=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/durable-ledger/package.json packages/durable-ledger/package.json
RUN pnpm install --frozen-lockfile --filter @apo/durable-ledger...
COPY packages/durable-ledger/tsconfig.json packages/durable-ledger/tsconfig.json
COPY packages/durable-ledger/src packages/durable-ledger/src
RUN pnpm --filter @apo/durable-ledger build
RUN pnpm install --frozen-lockfile --filter @apo/durable-ledger... --prod

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages/durable-ledger/node_modules /repo/packages/durable-ledger/node_modules
COPY --from=build /repo/packages/durable-ledger/package.json /repo/packages/durable-ledger/package.json
COPY --from=build /repo/packages/durable-ledger/dist /repo/packages/durable-ledger/dist
COPY packages/durable-ledger/drizzle /repo/packages/durable-ledger/drizzle
WORKDIR /repo/packages/durable-ledger
USER node
EXPOSE 3100
CMD ["node", "dist/main.js"]
