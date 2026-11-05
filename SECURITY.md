# 安全说明（SECURITY）

OmniRelay 处理的是第三方平台凭据与用户消息，安全默认值优先于便利性。

---

## 1. 凭据处理

| 凭据 | 存放位置 | 代码中如何取值 |
| --- | --- | --- |
| Discord Bot Token | 环境变量 `DISCORD_BOT_TOKEN`（名称可配） | `process.env[config.discord.tokenEnv]` |
| QQ AppID / AppSecret | 环境变量 `QQ_APP_ID` / `QQ_APP_SECRET` | `process.env[config.qq.appIdEnv/appSecretEnv]` |
| OneBot 访问令牌 | 环境变量 `ONEBOT_BRIDGE_TOKEN` | `process.env[config.onebot.accessTokenEnv]` |
| 控制台密码哈希 | 环境变量 `WEB_ADMIN_PASSWORD_HASH` | 只做 scrypt 校验 |
| 会话签名密钥 | 环境变量 `WEB_SESSION_SECRET` | HMAC-SHA256 密钥 |

规则：

1. **代码、配置示例、测试、文档中不出现任何真实凭据**；仓库只含 `.env.example` 占位。
2. 令牌只在使用点读取，不写数据库、不写日志、不写控制台状态。
3. 控制台 `GET /api/platforms` 只返回 `configured | missing` 状态与**环境变量名**。
4. 日志中间件对以下键做脱敏：`authorization`、`cookie`、`token`、`accessToken`、
   `appSecret`、`app_secret`、`password`、`secret`、`api_key`。
5. 自由文本再做一遍正则脱敏：`Bearer <...>`、`token=...`、`access_token=...`、
   `secret=...`、Discord token 形态（`[MN]xx.xxxx.xxxx`）、`sk-...`。
6. 测试断言：
   - `tests/api/console.test.ts` 断言 `/api/platforms` 与 `/api/settings` 响应中**不含**环境变量里的令牌值；
   - `tests/onebot/errors.test.ts` 断言错误消息中令牌被替换为 `[redacted]`；
   - `tests/integration/qq-bridge.test.ts` 断言平台视图序列化后不含 AppSecret / access token。

轮换建议：Token/AppSecret 泄露时立即在平台侧重置，并重启桥（桥不缓存 Discord Token；
QQ access token 会在内存中缓存至过期前 60s，`invalidate()` 会强制刷新）。

---

## 2. 控制台认证

- 密码不存储：只保存 `scrypt$N$r$p$salt$hash`（N=16384, r=8, p=1, 64 字节），
  校验使用 `crypto.timingSafeEqual` 常量时间比较。
- 生成方式：`npm run hash-password -- "你的密码"`。
- 未设置 `WEB_ADMIN_PASSWORD_HASH` 且 `web.admin_auth: true` 时，**进程拒绝启动**（配置错误），
  避免“以为有密码其实没有”。
- 会话：HMAC-SHA256 签名 Cookie（`HttpOnly`、`SameSite=Lax`、`Path=/`、带 `exp`），
  默认 12 小时过期；密钥缺失时使用进程内随机密钥（重启即失效，仅限本地开发，会打印 warning）。
- 登录失败按来源 IP 限制：5 分钟内 10 次失败后返回 429。
- 所有 `/api/*` 除 `/api/session`、`/api/login`、`/api/logout` 外都要求有效会话。

生产部署建议再加一层 TLS 反向代理（见 DEPLOYMENT.md），并把 `secure` Cookie 标志打开
（当前代码固定 `secure:false`，因为在反向代理后由外部终止 TLS；如需端到端 HTTPS
可自行在 `apps/server/src/routes/auth.ts` 调整）。

---

## 3. 凭据存储与掩码策略

OmniRelay 支持两种凭据来源，二者最终都通过**环境变量**进入进程，代码里没有任何
「从数据库或 API 读取明文」的路径。

### 3.1 来源

| 来源 | 说明 |
| --- | --- |
| 宿主机环境变量 / `.env` 手工维护 | 默认方式，凭据由运维直接管理 |
| Web 控制台写入 | 需显式开启 `credentials.allow_console_write: true` |

### 3.2 落盘规则（控制台写入路径）

- 明文**只**落在 `credentials.env_file` 指定的文件（默认 `<项目根>/.env`），
  进程内仅存在于 `process.env`，**绝不写入 SQLite**。
- 写入使用 `临时文件 → chmod 600 → fs.rename` 原子替换；任何一步失败都回滚，
  原文件内容不受损。
- 写入前自动备份为 `.env.bak-<时间戳>`，最多保留 5 份；`.gitignore` 已排除
  `.env`、`.env.bak-*`、`.env.tmp-*`，备份不会进入版本库。
- 文件保留原有注释、空行与行序，只增改目标行。
- `credentials.env_file` 必须是项目根目录内的路径，`../` 越界在启动时即被拒绝。

### 3.3 掩码与回传

- `GET /api/platforms`、`GET /api/platforms/:platform` 只返回
  `{ env, state, writable, masked }`，`masked` 形如 `abcd…wxyz`（长度 ≥ 8 时保留首尾各 4 位，
  3–7 位显示 `••••`，1–2 位显示 `••`），**从不返回明文**。
- 不存在任何「读取明文凭据」的接口；`PUT`/`DELETE` 成功后的响应体同样只含掩码。
- 写入的键必须在白名单内：`discord → DISCORD_BOT_TOKEN`、
  `qq-official → QQ_APP_ID / QQ_APP_SECRET`、`onebot → ONEBOT_BRIDGE_TOKEN`。
  这可以阻止通过控制台注入 `NODE_OPTIONS` 等可改变进程行为的变量。
- 值会做校验：去首尾空白、非空、长度 ≤ 512、**拒绝换行与 NUL**（防止借换行注入额外键）。

### 3.4 审计

- 写入与删除分别记录 `platform.credential.write` / `platform.credential.delete`，
  字段只有 `platform` 与 `keys`（键名数组），**不含值**。
- 手工核对：以假 Token 执行一次写入后，`grep` 服务日志找不到该字符串。

### 3.5 前端

- 凭据输入框 `type="password"`、`autoComplete="new-password"`；提交成功立即清空组件 state。
- 明文不进入 localStorage / sessionStorage / URL / Query cache；渲染层只读 `masked`。
- 提交前有二次确认弹窗，文案只拼接环境变量名。

---

## 4. 网络暴露面

| 端口 | 默认绑定 | 建议 |
| --- | --- | --- |
| 8098 OneBot WS | `0.0.0.0`（示例配置） | **只监听内网/回环**；必须启用 `ONEBOT_BRIDGE_TOKEN` |
| 8080 健康检查 | `0.0.0.0` | 可只监听回环，交由监控系统内网访问 |
| 3000 控制台 | `0.0.0.0` | 仅内网或经反代 + HTTPS |

`docker-compose.yml` 默认把三个端口都绑定到 `127.0.0.1`，避免误暴露。
`/status` 与 `/healthz` 不含任何凭据。

---

## 5. 输入与内容安全

- 所有配置经 `zod` 严格校验（未知键会报错）；API 入参同样用 `zod` 校验。
- 规则中的 `textRegex` 由 `new RegExp` 编译，非法正则记为不匹配（不会抛出/拖垮进程）。
- OneBot Action 参数缺失或类型错误 → `1400`，不做隐式转换（`"123"` 会转数字，其余拒绝）。
- 出站内容长度受限：Discord 单条 2000 字符（自动分片），QQ 单条 1500 字符（自动分片）；
  媒体大小上限 Discord 8 MiB、QQ 20 MiB。
- 桥不会把平台原生 ID 当作跨平台 ID；未知 ID 一律 `1404`，不猜测。

---

## 6. 防循环与防滥用

- 桥自身发送的消息不会重新进入入站流水线（入站仅由两个 Adapter 产生）。
- 规则引擎默认忽略其他机器人（`trigger.ignoreBots` 缺省 true）。
- 入站去重（`discord:<id>`、`qq:<id>:<seq>`）避免平台重复推送造成重复转发。
- 出站有平台级 60 条/分钟安全阀 + 规则级限流；QQ 主动消息受官方额度与用户开关约束。
- 手动重试（队列/死信）**重新经过**能力与限流检查，无法用重试绕过策略。

---

## 7. 数据与隐私

- SQLite 文件位于 `data/`（已 `.gitignore`），含消息正文与用户原生 ID，属于敏感数据：
  请限制文件权限，并纳入备份加密策略。
- 控制台展示的消息文本来自入站内容，已对凭据形态做脱敏，但**不保证**对普通隐私内容脱敏。
- 日志保留在内存表（默认最多 5000 行，自动裁剪），消息读模型默认保留 30 天
  （`storage.message_retention_days`）。
- 不需要历史时可清除 `data/*.sqlite*` 后重启（会重建库并重新分配 OneBot ID）。

---

## 8. 漏洞与依赖

- 依赖面刻意保持最小：`ws`、`fastify`（+ cookie/static）、`pino`、`yaml`、`zod`、
  `react` 生态；SQLite 使用 Node 内置 `node:sqlite`（无原生编译依赖）。
- 建议在部署环境运行 `npm audit --omit=dev` 并定期升级。
- 自动化测试不访问网络：所有平台调用均通过注入的 `fetch` / 假 WebSocket 完成。
