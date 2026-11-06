# 046 沙箱镜像：agent 容器、代理、网关共用这一个，入口不同。
#
#   npm run sandbox:build          # 打成 wb-sandbox:latest（要联网一次）
#
# Docker Hub 拉不动：--base docker.m.daocloud.io/library/node:22-bookworm-slim
# npm 慢：--npm-registry https://registry.npmmirror.com
# Debian 源报 502 / 很慢：--apt-mirror mirrors.tuna.tsinghua.edu.cn（只换主机名；apt 仍按签名校验软件包）
#
# 故意不装：curl、wget、ssh、sudo——少一个工具少一条路。要测网络的探针用 node。
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

ARG NPM_REGISTRY=https://registry.npmjs.org
ARG CLAUDE_CODE_VERSION=latest
ARG APT_MIRROR=

RUN if [ -n "${APT_MIRROR}" ]; then \
      case "${APT_MIRROR}" in *[!A-Za-z0-9.-]*) echo "APT_MIRROR 只能是主机名"; exit 1;; esac; \
      sed -i "s#deb.debian.org#${APT_MIRROR}#g" /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends git python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm config set registry "${NPM_REGISTRY}" \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && rm -f /root/.npmrc /usr/local/etc/npmrc \
 && (userdel -r node 2>/dev/null || true)

# 非 root 用户 agent（10001）；家目录运行时是 tmpfs，这里只占位。
RUN groupadd -g 10001 agent && useradd -u 10001 -g 10001 -d /home/agent -s /usr/sbin/nologin agent \
 && mkdir -p /work /run/wb /run/gw /home/agent && chown 10001:10001 /work /run/wb /run/gw /home/agent \
 # 去掉所有 setuid / setgid 位：容器里不该有任何「运行时提权」的程序。
 && (find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true)

# 确认没装多余的东西（构建时就失败，别等运行时才发现）。
RUN for t in curl wget ssh sudo su-exec gosu; do if command -v "$t" >/dev/null 2>&1; then echo "镜像里不该有 $t"; exit 1; fi; done \
 && test -z "$(find / -xdev -perm /6000 -type f 2>/dev/null)"

COPY scripts/lib/sandbox /opt/wb/lib/sandbox
COPY scripts/sandbox /opt/wb/sandbox

ENV HOME=/home/agent \
    WB_SANDBOX=1 \
    NODE_ENV=production
USER 10001:10001
WORKDIR /work
CMD ["sleep", "infinity"]
