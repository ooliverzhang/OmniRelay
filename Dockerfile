# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# OmniRelay 生产镜像：多阶段构建，运行阶段只保留构建产物与生产依赖。
# 说明：本机未安装 Docker，`docker compose config` 无法在开发环境验证，
#       详见 DEPLOYMENT.md「本地验证限制」。
# ---------------------------------------------------------------------------

FROM node:24-alpine AS build
WORKDIR /app
ENV NODE_ENV=development

# 依赖清单优先复制，最大化利用构建缓存
COPY package.json package-lock.json* ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

RUN npm ci --no-audit --no-fund
RUN npm run build

# 只保留运行期依赖
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    OMNI_RELAY_CONFIG=/app/config.yaml \
    OMNI_RELAY_DATA_DIR=/app/data \
    OMNI_RELAY_SQLITE_PATH=/app/data/bridge.sqlite

RUN addgroup -S omni && adduser -S omni -G omni

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/config.example.yaml ./config.example.yaml

RUN mkdir -p /app/data && chown -R omni:omni /app

USER omni
EXPOSE 8098 8080 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
