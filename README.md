# OmniRelay · 全域消息中继

> **One bridge. Many platforms. Clear rules.**
>
> 独立的多平台消息桥：把 **Discord** 与 **QQ 官方机器人（API v2）** 的事件统一成
> **OneBot 11 反向 WebSocket** 接口，任何 OneBot 11 兼容宿主都可以直接连接使用；
> 内置规则引擎、持久化队列与 React 管理控制台。

```text
Discord Gateway ─────┐
                     │
QQ 官方机器人 Gateway ─┼── OmniRelay Core ─── OneBot 11 Reverse WebSocket ──> 任意 OneBot 11 宿主
                     │          │
                     │          ├── Rule Engine
                     │          ├── SQLite Storage / Outbox Queue
                     │          └── Web API ─── React Console
```

OmniRelay 本身**不实现任何 AI 逻辑**，也不绑定特定机器人框架：它只负责“把平台事件交给
OneBot 宿主”和“把 OneBot 指令安全地投递回平台”。

---

## 1. 能力概览

| 能力 | 状态 |
| --- | --- |
| OneBot 11 反向 WebSocket 服务端（`/onebot/v11/ws`） | ✅ 已实现 |
| Bearer Token / `?access_token=` 鉴权，401 拒绝升级 | ✅ 已实现 |
| `message` 事件（私聊 / 群聊）、`meta_event`（lifecycle + heartbeat） | ✅ 已实现 |
| Action（必选 10 个）：`get_login_info` `get_status` `get_version_info` `get_group_list` `get_group_info` `get_group_member_info` `get_stranger_info` `send_msg` `send_private_msg` `send_group_msg` | ✅ 已实现 |
| Action（可选 3 个）：`get_msg` `delete_msg` `get_group_member_list` | ✅ 已实现（QQ 无撤回接口 → 1405） |
| Action 超时、`echo` 关联、断线清理、重复响应忽略 | ✅ 已实现 |
| Discord Gateway：HELLO/IDENTIFY/RESUME、心跳、重连退避、致命 close code | ✅ 已实现 |
| Discord REST 发送：文本、附件上传、回复引用、DM 通道自动创建 | ✅ 已实现 |
| QQ 官方机器人：Access Token、Gateway、`C2C_MESSAGE_CREATE`、`GROUP_AT_MESSAGE_CREATE` | ✅ 已实现 |
| QQ 发送：私聊/群聊、被动回复（`msg_id` + `msg_seq`）、媒体上传、主动消息开关 | ✅ 已实现 |
| 统一内部事件模型 + 双向转换（平台 ↔ OneBot） | ✅ 已实现 |
| 平台能力矩阵（不可用的能力一律标记 unsupported） | ✅ 已实现 |
| SQLite 持久化：ID 映射、去重、outbox、投递尝试、死信、限流桶、规则、日志 | ✅ 已实现 |
| 规则引擎（纯函数、可离线测试）+ 全局回复策略（`mention_only` 等 5 种） | ✅ 已实现 |
| 出站队列：指数退避 + 抖动、最大次数、死信、手动重试（重新过安全门） | ✅ 已实现 |
| Web 控制台：Dashboard、平台、规则、会话、身份、队列、日志、设置 | ✅ 已实现 |
| 控制台登录（scrypt + HMAC 签名 Cookie）、操作审计日志 | ✅ 已实现 |
| 控制台内配置平台凭据（写入 `.env`、权限 600、原子替换、热重载） | ✅ 已实现（`allow_console_write` 默认关闭） |
| 健康检查 `/healthz` `/readyz` `/status`、结构化日志、优雅关闭 | ✅ 已实现 |
| Dockerfile / docker-compose | ✅ 已提供（本机无 Docker，未实际构建） |

规范中的“可选/推荐”项里仍未做的部分（详见 [DEPLOYMENT.md](./DEPLOYMENT.md#已知限制) 与文末）：
入站媒体本地缓存、`notice`/`request` 事件、ESLint、多用户 RBAC。

---

## 2. 环境要求

- **Node.js ≥ 24**（使用内置 `node:sqlite`；Node 22.5–23.3 需要 `--experimental-sqlite`）
- npm ≥ 10
- 可选：Docker + Docker Compose（本地未验证，见部署文档）

---

## 3. 快速开始（本地）

```bash
# 1) 安装依赖（npm workspaces）
npm install

# 2) 准备配置
cp config.example.yaml config.yaml
cp .env.example .env

# 3) 生成控制台密码哈希与会话密钥，写入 .env
npm run hash-password -- "你的管理密码"
#   -> WEB_ADMIN_PASSWORD_HASH='scrypt$...'
#   -> WEB_SESSION_SECRET='...'
#
# 平台凭据（Discord Bot Token / QQ AppID+AppSecret）有两种配置方式：
#   A. 直接写进 .env 或宿主机环境变量（默认方式）
#   B. 在 Web 控制台「平台详情」页填写 —— 需先开启 credentials.allow_console_write: true

# 4) 类型检查 + 测试 + 构建
npm run typecheck
npm test
npm run build

# 5) 启动（读取 config.yaml 与 .env 中的环境变量）
npm start
```

启动后：

| 地址 | 用途 |
| --- | --- |
| `http://127.0.0.1:3000` | Web 控制台（默认需要登录） |
| `ws://127.0.0.1:8098/onebot/v11/ws` | OneBot 11 反向 WebSocket（建议只在内网暴露） |
| `http://127.0.0.1:8080/healthz` `/readyz` `/status` | 健康检查与状态 |

开发模式（前后端分离）：

```bash
npm run dev        # 后端 tsx watch，监听 3000 / 8098 / 8080
npm run web:dev    # Vite dev server，5173，/api 代理到 127.0.0.1:3000
```

---

## 4. npm 脚本

| 脚本 | 说明 |
| --- | --- |
| `npm run typecheck` | `tsc -b`（全部后端包）+ 前端 `tsc --noEmit` |
| `npm test` | Vitest 运行后端/集成/接口测试（35 文件 / 372 用例） |
| `npm run build` | 构建后端（`tsc -b`）与前端（Vite → `apps/web/dist`） |
| `npm run dev` | 后端热重载开发模式 |
| `npm run web:dev` | 前端 Vite 开发服务器 |
| `npm run web:build` | 仅构建前端 |
| `npm run web:test` | 前端组件/工具测试（4 文件 / 36 用例） |
| `npm start` | 运行构建产物 `apps/server/dist/index.js` |
| `npm run hash-password -- "密码"` | 生成 `WEB_ADMIN_PASSWORD_HASH` / `WEB_SESSION_SECRET` |
| `npm run format` / `format:check` | Prettier |
| `npm run clean` | 清理所有 `dist/` |

---

## 5. 项目结构

```text
omni-relay（当前工作区根目录）
├── apps/
│   ├── server/                  # Fastify HTTP API + 运行时编排 + 入口
│   └── web/                     # React 18 + Vite + Tailwind + ECharts 控制台
├── packages/
│   ├── shared-types/            # 全部跨包契约（平台/消息/OneBot/规则/队列/API DTO）
│   ├── capabilities/            # 平台能力矩阵与投递能力判定
│   ├── core/                    # 统一事件、双向转换、去重键、脱敏、ID 生成
│   ├── rules/                   # 纯函数规则引擎（匹配/策略/时间窗/测试器）
│   ├── storage/                 # node:sqlite 持久化（迁移 + 各仓储）
│   ├── queue/                   # 出站队列（退避/分类/worker/投递计划）
│   ├── onebot/                  # OneBot 11 反向 WebSocket 服务端
│   ├── adapters-discord/        # Discord Gateway + REST + 适配器
│   └── adapters-qq/             # QQ 官方机器人 Token + Gateway + REST + 适配器
├── tests/                       # core / rules / storage / queue / onebot / adapters / api / integration
├── data/                        # SQLite 数据库（.gitignore，仅保留 .gitkeep）
├── scripts/                     # hash-password / clean
├── .env.example
├── config.example.yaml
├── Dockerfile
├── docker-compose.yml
├── ARCHITECTURE.md
├── PROTOCOL.md
├── RULES.md
├── SECURITY.md
└── DEPLOYMENT.md
```

> 目录名说明：规范中的仓库目录名为 `omni-relay`，当前工作区为 `F:\projects\OmniRelay`，
> 即项目根目录直接位于工作区根，未再嵌套一层子目录。

---

## 6. OneBot 用法要点

```bash
# 典型客户端连接参数
WS URL:  ws://<bridge-host>:8098/onebot/v11/ws
Token:   Authorization: Bearer $ONEBOT_BRIDGE_TOKEN
         （或 ?access_token=$ONEBOT_BRIDGE_TOKEN）
```

- 平台原生 ID **不会**直接充当 OneBot ID：桥维护 `platform + kind + native_id → onebot_id`
  的持久映射，重启后不变，且 user/group 号段互不冲突。
- `send_msg` 系列 Action 进入**持久化 outbox**，立即返回 `{"status":"async","retcode":1}`，
  由队列异步投递；平台能力不允许时会立刻返回 `failed` 并给出明确 retcode。
- QQ 的被动回复窗口由桥自动利用：只要该会话近期有入站消息，出站会带上 `msg_id`/`msg_seq`；
  否则视为主动消息，遵从配置的主动消息开关。

完整契约见 [PROTOCOL.md](./PROTOCOL.md)。

---

## 7. 管理与安全默认值

- 平台默认**全部关闭**；QQ 主动群发默认关闭；群聊默认需要白名单或 `@`。
- 真实 Token / AppSecret **只从环境变量读取**，控制台只显示掩码（如 `abcd…wxyz`），永不回传明文。
- 开启 `credentials.allow_console_write: true` 后，控制台可把凭据写入 `.env`（权限 600、
  原子替换、写入前备份、热重载对应平台）。写入只允许白名单键，且 `credentials.env_file`
  必须位于项目根目录内。
- 日志与会话记录对 `Authorization`、`token`、`secret`、Cookie 等键做脱敏；
  测试用例断言了脱敏行为。
- 控制台密码使用 scrypt 哈希，会话使用 HMAC 签名 + 过期时间，Cookie 为 HttpOnly。
- 手动重试死信/队列**同样经过**平台能力与限流门禁，无法绕过安全规则。

详见 [SECURITY.md](./SECURITY.md)。

---

## 8. 测试与验收

```bash
npm run typecheck   # 后端 10 个 project + 前端，0 错误
npm test            # 35 files / 372 tests 通过
npm run build       # 后端 tsc -b + 前端 vite build 成功
npm run web:test    # 4 files / 36 tests 通过
docker compose config   # 本机未安装 Docker，需在具备 Docker 的环境执行
```

最近一次本地结果（开发机 Windows / Node 24.18）：

- `npm run typecheck`：通过（0 错误）
- `npm test`：**35 文件 / 372 用例全部通过**
- `npm run web:test`：**4 文件 / 36 用例全部通过**
- `npm run build`：成功，前端产物 `index.html 0.86 kB` + `css 25.77 kB` + `js 817.89 kB`（gzip 267.86 kB）
- 进程级冒烟：`node apps/server/dist/index.js` 后 `/healthz`、`/readyz`、`/status`、
  控制台 SPA、`/api/session` 均返回预期结果

验收清单逐项对照见 [DEPLOYMENT.md](./DEPLOYMENT.md#验收对照)。

---

## 9. 尚未实现 / 已知限制

说明：这是**规范标注为“可选/推荐”且尚未实现**的清单，不是技术不可行项。第六节“必须支持”的
10 个 Action、事件、鉴权、超时、`echo` 等均已实现。

1. 入站媒体**不做本地落盘缓存**：QQ 临时附件 URL 会在 OneBot 段的
   `url_expires_at` 字段中透出过期时间（非标准扩展），但桥自身不下载保存；
   请在宿主侧按该时间立即下载。
2. `notice` / `request` 事件未推送：只推送 `message` 与 `meta_event`。
3. 全量群消息（`GROUP_MESSAGE_CREATE`）仅在配置显式开启时接收，且需官方权限；
   默认按 `groupMentionReceive` 语义工作。
4. Discord 的 `privateProactiveSend` 保守标记为不支持（机器人无法向无共同服务器的用户发起 DM）。
5. 控制台未做多用户/角色体系，仅单管理员会话（规范未要求 RBAC）。
6. Docker 相关文件已提供，但本机无 Docker，未实际执行 `docker compose up` 验证。
7. 未配置 ESLint（Prettier 已配置），此为规范“推荐”项。

### 可选 Action 的实现边界

- `get_msg` / `delete_msg` 只能作用于**桥已存储**的入站消息；未知 id → `1404`，参数非法 → `1400`。
- `delete_msg` 在 Discord 上真实撤回；**QQ 官方机器人没有撤回接口**，启用状态下返回
  `1405 capability_unsupported`，平台停用时返回 `1500`。桥不会假装成功。
- `get_group_member_list` 只返回桥**观察到过**的成员（QQ 无法枚举全量群成员）。
