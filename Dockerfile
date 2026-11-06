# Zero npm dependencies: the image is just Node + this folder.
# Docker Hub unreachable? Set NODE_IMAGE in .env to a mirror, e.g. docker.m.daocloud.io/library/node:22-slim
ARG NODE_IMAGE=node:22-slim
FROM ${NODE_IMAGE}

# 014: the commit this image was built from — every backup file carries it in the name.
# `WB_VERSION=$(git rev-parse --short HEAD) docker compose build` puts it there.
ARG WB_VERSION=dev

WORKDIR /app
ENV NODE_ENV=production \
    WB_DB=/data/workbench.db \
    WB_BACKUP_PATH=/backups \
    WB_VERSION=${WB_VERSION} \
    PORT=3200 \
    TZ=Asia/Shanghai \
    WB_TZ=Asia/Shanghai

COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3200/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
