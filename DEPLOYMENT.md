# 部署与验收（DEPLOYMENT）

> 本项目按规范要求**仅在本地开发与测试**：不 SSH、不上传服务器、不调用任何服务器管理工具、
> 不使用真实平台凭据。部署步骤供人工审阅后执行。

---

## 1. 本地验证限制

| 项目 | 状态 |
| --- | --- |
| `npm run typecheck` | ✅ 通过 |
| `npm test` | ✅ 35 文件 / 372 用例 |
| `npm run build` | ✅ 通过（后端 + 前端） |
| `npm run web:test` | ✅ 4 文件 / 36 用例 |
| 进程级冒烟（真实启动构建产物） | ✅ `/healthz` `/readyz` `/status` / SPA / `/api/session` |
| `docker compose config` | ⛔ **开发机未安装 Docker**，无法执行；`docker-compose.yml` 与 `config.example.yaml` 已用 YAML 解析器校验语法正确 |
| 真实平台联调 | ⛔ 按规范禁止使用真实 Token，全部用 Mock 覆盖 |

---

## 2. 本地运行

```bash
npm install
cp config.example.yaml config.yaml
cp .env.example .env        # 填入凭据（仅本地）
npm run build
npm start
```

必需环境变量（`web.admin_auth: true` 时）：

```bash
WEB_ADMIN_PASSWORD_HASH='scrypt$16384$8$1$...'   # npm run hash-password -- "密码"
WEB_SESSION_SECRET='<32 字节随机串>'
ONEBOT_BRIDGE_TOKEN='<长随机串>'                  # 若 require_access_token=true 则必填
```

可选：`OMNI_RELAY_CONFIG`、`OMNI_RELAY_ONEBOT_PORT`、`OMNI_RELAY_HEALTH_PORT`、
`OMNI_RELAY_WEB_PORT`、`OMNI_RELAY_DATA_DIR`、`OMNI_RELAY_SQLITE_PATH`、
`OMNI_RELAY_LOG_LEVEL`、`OMNI_RELAY_LOG_PRETTY`。

---

## 3. Docker Compose

```bash
cp config.example.yaml config.yaml
cp .env.example .env
docker compose config            # 校验
docker compose up -d --build
docker compose logs -f omni-relay
```

- 镜像：`Dockerfile` 多阶段构建（`node:24-alpine` → 构建 → 生产依赖），以非 root 用户 `omni` 运行。
- 端口默认全部绑定 `127.0.0.1`（8098 / 8080 / 3000），需要外部访问时请自行改绑定并配置 TLS。
- 数据卷：命名卷 `omni-relay-data` 挂载到 `/app/data`；配置以只读方式挂载 `/app/config.yaml`。
- 健康检查：容器内 `fetch http://127.0.0.1:8080/healthz`，失败 3 次标记 unhealthy。
- `latest` 不是一个好的生产标签：建议把 `docker-compose.yml` 的 `image:` 改成带版本号/摘要的标签。

> 注意：`docker-compose.yml` 中以只读方式挂载 `./config.yaml`，若该文件不存在，
> Docker 会创建一个同名**目录**导致启动失败。请先 `cp config.example.yaml config.yaml`。

---

## 3b. 在控制台配置平台凭据

方案 A：控制台把凭据写入 `.env` 文件，并**热重载该平台的适配器**（不重启进程、
不中断 OneBot 连接）。默认关闭，需要显式开启。

### 开启步骤

1) `config.yaml`

```yaml
credentials:
  env_file: ./.env           # 必须在项目根目录内，否则启动即报错
  allow_console_write: true  # 默认 false
```

也可用环境变量覆盖：`OMNI_RELAY_ENV_FILE`、`OMNI_RELAY_ALLOW_CONSOLE_WRITE=1`。

2) 重启一次服务让配置生效（之后改凭据无需再重启）。

3) 打开控制台 → 「平台」→ 选择平台 → 凭据行点「填写」/「更换」→ 输入 → 二次确认。

### 行为说明

| 行为 | 细节 |
| --- | --- |
| 写入目标 | `credentials.env_file`（默认 `<项目根>/.env`） |
| 权限 | 强制 `600` |
| 原子性 | 临时文件 → chmod → `fs.rename` 替换；失败回滚，原文件不受损 |
| 备份 | `.env.bak-<时间戳>`，最多保留 5 份（`.gitignore` 已排除） |
| 保留原内容 | 注释/空行/行序不动，只改目标键；值为空即删除该键 |
| 生效方式 | 只重建被修改平台的适配器，OneBot 服务与出站队列不受影响 |
| 白名单 | `discord→DISCORD_BOT_TOKEN`、`qq-official→QQ_APP_ID/QQ_APP_SECRET`、`onebot→ONEBOT_BRIDGE_TOKEN` |
| 审计 | 日志记录 `platform.credential.write` 与键名，不含值 |

### 接口

```http
PUT /api/platforms/:platform/credentials
{ "values": { "DISCORD_BOT_TOKEN": "<token>" } }   -> 200 PlatformView（凭据为掩码）

DELETE /api/platforms/:platform/credentials/:env   -> 200 PlatformView
```

错误码：`403 credential_write_disabled`（未开启）、`400 invalid_credential_key`（非白名单）、
`400 invalid_credential_value`（空/超长/含换行）、`400 unsupported_platform`、`401`（未登录）。

### 关闭控制台写入

`credentials.allow_console_write: false` 时：所有写接口返回 403，
`PlatformCredentialView.writable` 为 `false`，控制台按钮禁用并提示
「请由运维在服务器 .env 中配置」。

### 为什么选择热重载而不是重启进程

重启进程会中断 OneBot 反向 WebSocket 的所有宿主连接，并让未完成的重试/队列状态
进入不必要的抖动。凭据只影响单个平台的适配器，因此：

1. 先 `close()` 旧网关（**必须**，否则旧 websocket 会泄漏，因为
   `initDiscord`/`initQq` 在缺少凭据时会提前返回而不替换旧实例）；
2. 重新构造该平台适配器；
3. 若平台已启用则重新 `connect()`；
4. 清空该平台的入站回复窗口缓存。

OneBot、outbox worker、storage 均不重建。对应测试见
`tests/server/runtime-credentials.test.ts`（断言旧 socket 被 `close`、QQ 重载不影响 Discord）。

---

## 4. 反向代理（可选，推荐生产）

```nginx
server {
    listen 443 ssl http2;
    server_name relay.example.com;

    ssl_certificate     /etc/ssl/fullchain.pem;
    ssl_certificate_key /etc/ssl/privkey.pem;

    # 控制台 + API
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # OneBot 反向 WebSocket（仅内网/受信客户端）
    location /onebot/v11/ws {
        proxy_pass http://127.0.0.1:8098;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

要点：

- OneBot 端口**不要**暴露公网；若必须，务必启用强随机 `ONEBOT_BRIDGE_TOKEN`。
- 反向代理后 Cookie 使用 `secure:false`（由外部 TLS 终止）；若端到端 HTTPS 可自行改为 `secure:true`。
- 健康检查 `/healthz` `/readyz` `/status` 建议单独走内网地址，不要暴露给公网。

---

## 5. 数据与备份

SQLite 文件：`data/bridge.sqlite`（WAL 模式，另有 `-wal`/`-shm`）。

```bash
# 一致性快照（应用运行中也安全）
node -e "const {DatabaseSync}=process.getBuiltinModule('node:sqlite');const db=new DatabaseSync('data/bridge.sqlite');db.exec(\"VACUUM INTO 'data/backup-'+Date.now()+'.sqlite'\");db.close()"

# 或停机后直接拷贝（先停进程，避免 WAL 未合并）
cp data/bridge.sqlite data/bridge-$(date +%F).sqlite
```

- 表清单与用途见 [ARCHITECTURE.md](./ARCHITECTURE.md#5-存储模型sqlitenodesqlite)。
- 消息读模型默认保留 30 天（`storage.message_retention_days`），日志表最多 5000 行（自动裁剪）。
- 不需要历史时可停机后删除 `data/*.sqlite*` 重启（会重建库；OneBot ID 将重新分配）。

---

## 6. 健康检查与监控

| 端点 | 用途 | 期望 |
| --- | --- | --- |
| `GET /healthz` | 存活 | 200 `{"status":"ok"}` |
| `GET /readyz` | 就绪 | 200 `{"status":"ready"}`；启动中返回 503 |
| `GET /status` | 详细状态 | 平台连接、OneBot 客户端数、pending actions、队列/死信计数 |

建议监控 `queue.dead` 增长、`discord/qq connected=false` 持续时长、`onebot.clients=0` 预警。

---

## 7. 升级 / 回滚

1. 停止进程（`docker compose down` 或 `Ctrl+C`，会走优雅关闭：HTTP → runtime → storage）。
2. 备份 `data/`（见上）。
3. 拉取新代码 → `npm ci` → `npm run typecheck && npm test && npm run build`。
4. 启动；SQLite 迁移在启动时自动执行（版本化、幂等）。
5. 回滚：切回旧版本代码 + 还原备份的 `data/`。

> 迁移只做向前兼容的新增；若要跨大版本回滚，必须同时还原数据库备份。

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动报 `web.admin_auth is enabled but WEB_ADMIN_PASSWORD_HASH is not set` | 运行 `npm run hash-password -- "密码"` 并导出变量，或临时设 `web.admin_auth: false` |
| `config file must contain a mapping at the root` | `config.yaml` 顶层必须是映射（缩进/空文件问题） |
| OneBot 客户端连不上（401） | Token 不匹配；检查 `Authorization: Bearer` 或 `?access_token=` |
| OneBot 客户端连上但收不到消息 | 平台未启用 / 未配置凭据 / 规则未命中（看 `/logs` 的 `inbound.ignored` reason） |
| `send_msg` 返回 1405 | 平台能力不支持（例：向未开启主动消息的 QQ 群主动发送） |
| 队列持续 `retrying` 后进入死信 | 查看死信原因码；`platform_unavailable` 属平台侧问题，恢复后手动重试 |
| QQ 报 `quota_exceeded` | 主动消息额度/用户关闭主动消息；这类错误**不会**无限重试 |
| 控制台 404（前端资源） | 未执行 `npm run web:build`，或 `web.static_dir` 指向错误 |
| 端口冲突 | 修改 `server.onebot_port` / `server.health_port` / `web.port`（三者必须互不相同） |

---

## 9. 验收对照

规范“最终验收标准”19 项与本仓库的对应证据：

| # | 验收项 | 证据 |
| --- | --- | --- |
| 1 | Web 控制台可以登录 | `tests/api/console.test.ts`（错误/正确密码、Cookie 会话）；前端 `LoginPage` |
| 2 | Dashboard 显示平台状态与队列统计 | `tests/api/console.test.ts`（dashboard 结构、24 桶趋势）；`DashboardPage.tsx` |
| 3 | 平台配置可新增/编辑/启停 | `PATCH /api/platforms/:platform` + `tests/api` 平台视图；`PlatformsPage`/`PlatformDetailPage` |
| 4 | 规则可新增/编辑/排序/启停 | `tests/api/console.test.ts`（CRUD + toggle + reorder）；`RulesPage`/`RuleEditorPage` |
| 5 | “只有 @ 机器人时回复”生效 | `tests/integration/discord-bridge.test.ts`（未 @ 不转发，reason=`mention_required_missing`） |
| 6 | 私聊与群聊可用不同回复策略 | `RULES.md` 策略矩阵 + `packages/rules` 的 `allowPrivate/allowGroup/allowChannel` 与 `private_only`/`mention_only` 测试 |
| 7 | 规则测试器返回命中规则与忽略原因 | `POST /api/rules/test` + `tests/api/console.test.ts`（reason 断言）+ `tests/rules/tester.test.ts` |
| 8 | OneBot 反向 WS 可被客户端连接 | `tests/onebot/server.test.ts`（header/query 鉴权、401、路径 404）；`tests/integration/*` 真实连接 |
| 9 | Discord 私聊 → OneBot private_message | `tests/adapters/discord.test.ts`（DM 归一化）；集成测试覆盖群聊路径 + `tests/core/normalize-discord.test.ts` |
| 10 | Discord 群消息 → OneBot group_message | `tests/integration/discord-bridge.test.ts` |
| 11 | QQ C2C → OneBot private_message | `tests/integration/qq-bridge.test.ts` |
| 12 | QQ GROUP_AT → OneBot group_message | `tests/integration/qq-bridge.test.ts` |
| 13 | OneBot send_msg 能发到 Discord | `tests/integration/discord-bridge.test.ts`（outbox → REST 断言 content） |
| 14 | OneBot send_msg 能发到 QQ | `tests/integration/qq-bridge.test.ts`（被动回复 `msg_id`/`msg_seq`） |
| 15 | Echo 不会错配 | `tests/onebot/registry.test.ts` + `tests/onebot/server.test.ts`（echo 回填、迟到响应丢弃） |
| 16 | 重复消息不会重复投递 | `tests/integration/discord-bridge.test.ts` 去重用例 + `tests/storage/dedupe.test.ts` |
| 16b | 可选 Action `get_msg`/`delete_msg`/`get_group_member_list` 可用 | `tests/integration/optional-actions.test.ts`（10 用例：回放、真实撤回、1404、1400、QQ 1405、成员列表） |
| 16c | QQ 附件过期时间透传到 OneBot | `tests/integration/optional-actions.test.ts` + `tests/core/onebot.test.ts`（`url_expires_at`） |
| 17 | QQ 主动消息限制返回明确错误、不无限重试 | `tests/integration/qq-bridge.test.ts`（死信 `capability_unsupported`，outbox 清空） |
| 18 | Token 不出现在日志中 | `tests/onebot/errors.test.ts`（`[redacted]`）+ `apps/server/src/logger.ts` 脱敏实现 |
| 19 | 控制台不返回 Token/AppSecret | `tests/api/console.test.ts` 与 `tests/integration/qq-bridge.test.ts` 的“不含凭据”断言 |

---

## 10. 已知限制

以下均为规范标注为“可选/推荐”且尚未实施的项，不是技术不可行项：

1. 入站媒体不做本地落盘缓存：QQ 临时附件 URL 的过期时间会通过 OneBot 段的
   `url_expires_at` 透出（非标准扩展），但桥不代为下载，请在宿主侧按时间立即抓取。
2. 只推送 `message` 与 `meta_event`；`notice` / `request` 未实现。
3. `get_group_member_list` 只返回桥观察到的成员（QQ 无法枚举全量群成员）。
4. `delete_msg` 在 QQ 上返回 `1405`（官方无撤回接口），Discord 上真实撤回。
5. 控制台为单管理员会话，无多用户与 RBAC（规范未要求）。
6. Docker 镜像未在本机实际构建验证（无 Docker 环境）。
7. 未接入 ESLint（仅 Prettier）。
