# syntax=docker/dockerfile:1
# Build context is the REPO ROOT (pnpm workspace root), not this directory:
#   docker build -f packages/pay-core/Dockerfile .
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
COPY packages/pay-core/package.json packages/pay-core/package.json
RUN pnpm install --frozen-lockfile --filter @apo/pay-core...
COPY packages/pay-core/tsconfig.json packages/pay-core/tsconfig.json
COPY packages/pay-core/src packages/pay-core/src
RUN pnpm --filter @apo/pay-core build
RUN pnpm install --frozen-lockfile --filter @apo/pay-core... --prod

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages/pay-core/node_modules /repo/packages/pay-core/node_modules
COPY --from=build /repo/packages/pay-core/package.json /repo/packages/pay-core/package.json
COPY --from=build /repo/packages/pay-core/dist /repo/packages/pay-core/dist
COPY packages/pay-core/drizzle /repo/packages/pay-core/drizzle
WORKDIR /repo/packages/pay-core
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
