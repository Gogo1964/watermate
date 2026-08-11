# Node 22 ships SQLite in core, so there is nothing to compile — the same image
# builds on arm64 and armv7 as fast as on amd64.
#
# bookworm-slim rather than alpine: it publishes a linux/arm/v7 image, which
# lets an older 32-bit Raspberry Pi OS (Buster, whose libstdc++ is too old for
# the Node 22 binary) run this container without touching the host at all.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    DATABASE_PATH=/data/watermate.db \
    LOG_FORMAT=json

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data
USER node

# Reports a failure if the process cannot open its own database.
HEALTHCHECK --interval=5m --timeout=20s --start-period=30s \
  CMD node --disable-warning=ExperimentalWarning src/index.js --status || exit 1

ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
