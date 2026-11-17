# syntax=docker/dockerfile:1
# Game proxy image. Node is pinned to the oldest LTS line still in support; rebuild with
# `docker compose build --pull` to pick up the latest patch release of that line.
ARG NODE_VERSION=22

# ---- build: compile TypeScript with Vite ------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
# better-sqlite3 (a dev dependency: local SQLite and tests) compiles a native addon here; the tools stay in this stage and never reach the runtime image
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# ---- deps: production dependencies only -------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime ----------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine
ENV NODE_ENV=production \
    PORT=3001 \
    IMENG_PATH=imengs/lighthouse \
    SAVE_DIR=/data/saves \
    LOG_FILE=/data/logs/model-responses.jsonl
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY imengs ./imengs
COPY migrations ./migrations
# /data is the only writable place; compose mounts a volume there. The base image's non-root
# "node" user (uid 1000) owns it.
RUN mkdir -p /data/saves /data/logs && chown -R node:node /data
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/healthz >/dev/null || exit 1
CMD ["node", "dist/server.js"]
