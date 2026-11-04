# 架构说明（ARCHITECTURE）

本文描述 OmniRelay 的分层、关键数据流与不变量。目标：**平台适配层不感知 OneBot**，
**OneBot 层不感知平台**，两者只通过统一内部模型与能力矩阵交互。

---

## 1. 分层与依赖方向

```text
        ┌─────────────────────────────────────────────┐
        │ apps/web  (React 控制台，只调用 /api)         │
        └───────────────────────┬─────────────────────┘
                                │ HTTP (Cookie 认证)
        ┌───────────────────────▼─────────────────────┐
        │ apps/server  (Fastify API + 运行时编排)      │
        └───┬────────┬────────┬────────┬────────┬─────┘
            │        │        │        │        │
   ┌────────▼──┐ ┌───▼────┐ ┌─▼─────┐ ┌▼──────┐ ┌▼──────────────┐
   │  onebot   │ │ queue  │ │ rules │ │storage│ │ adapters-*    │
   └────┬──────┘ └───┬────┘ └───┬───┘ └───┬───┘ └──┬───────┬────┘
        └────────────┴──────────┴─────────┴────────┴───────┘
                                │
                     ┌──────────▼──────────┐
                     │ shared-types / core │  ← 唯一契约与纯模型层
                     └─────────────────────┘
```

强制约束（由 `tsconfig` project references 与 package 依赖表达）：

| 包 | 允许依赖 | 禁止 |
| --- | --- | --- |
| `shared-types` | 无 | 依赖任何业务包 |
| `core` | `shared-types`（含 `node:crypto`） | 网络、存储、平台 SDK |
| `rules` | `shared-types` | 任何 IO（纯函数，便于离线测试） |
| `capabilities` | `shared-types` | 任何 IO |
| `storage` | `shared-types` | 业务逻辑、平台调用 |
| `queue` | `shared-types` `storage` `capabilities` | 直接调用平台 API（仅通过 `OutboxSender` 接口） |
| `onebot` | `shared-types`（+ `ws`） | 感知 Discord/QQ |
| `adapters-*` | `shared-types` `core`（+ `ws`） | 感知 OneBot |
| `apps/server` | 以上全部 + Fastify | — |

---

## 2. 入站数据流（平台 → OneBot）

```text
Gateway 事件
  → Adapter 结构映射 + 允许列表过滤            (packages/adapters-*)
  → 统一事件 UnifiedMessageEvent              (packages/core)
  → 去重（discord:<id> / qq:<id>:<seq>）       (storage.inbound_dedupe)
  → 身份映射（platform+kind+native_id → onebot_id，事务内分配，绝不重用）
  → 能力检查（能否接收该会话类型）
  → 全局回复策略（always / mention_only / private_only / whitelist / disabled）
  → 规则匹配（priority 降序，命中即决策）       (packages/rules)
  → 统一事件 → OneBot message 事件             (packages/core)
  → WebSocket 广播给所有已连接宿主             (packages/onebot)
  → 写入 messages 读模型（控制台可见，状态 sent/queued/ignored/blocked）
```

决策语义与状态严格区分：

| 结果 | 含义 |
| --- | --- |
| `ignored` | 被规则或策略忽略，不是错误 |
| `blocked` | 无权限 / 能力不支持 / 被限流 |
| `queued` | 已进入发送队列（或已转发但当前无 OneBot 客户端） |
| `sent` | 已交付（转发给 ≥1 个宿主，或平台已接受） |
| `failed` | 平台永久拒绝（进入死信） |

---

## 3. 出站数据流（OneBot → 平台）

```text
宿主 Action (send_msg / send_private_msg / send_group_msg)
  → onebot registry 解析 + 参数校验 + 超时控制
  → 反查 onebot_id → 平台 + 原生会话 ID（storage.id_mappings）
  → OneBot 消息段 → 统一消息段（packages/core，含 CQ 字符串解析）
  → 平台限流（每平台 60 条/分钟）+ 规则级 rateLimit（若存在）
  → 能力检查（private/group/channel × 被动回复/主动消息）
  → 序列化进入 outbox（SQLite 持久化）
  → 立即响应 {"status":"async","retcode":1,"data":{"message_id":"<outbox-id>"}}
  → OutboxWorker 轮询 claimDue → 适配器 send()
      成功 → markSent + delivery_attempts(success)
      可重试错误 → markRetry（指数退避 + 抖动）→ 下次 tick 再试
      永久错误 / 超过上限 → markDead + dead_letters
```

**被动回复优先**：桥缓存每个会话最近一条入站消息的 `nativeMessageId` 与过期时间。
QQ 出站时若仍在窗口内，会自动带上 `msg_id` + 递增的 `msg_seq`（被动回复不消耗主动消息额度）；
窗口外才按“主动消息”处理，并受 `allow_proactive_*` 开关与能力矩阵约束。

队列状态机：

```text
queued ──claimDue──> sending ──ok──> sent
   ▲                    │
   │                    ├─ retryable ──> retrying ──(next_attempt_at)──> queued
   └────────────────────┴─ permanent/max attempts ──> dead（移入 dead_letters）
requeue（手动重试）: retrying/dead → queued（先重新过能力+限流门禁）
```

---

## 4. 关键不变量

1. **平台原生 ID ≠ OneBot ID**。映射表 `(platform, native_kind, native_id)` 唯一，
   `(onebot_kind, onebot_id)` 唯一；user 号段 `1000000001+`，group 号段 `2000000001+`，
   分配在事务内完成，**绝不复用**已分配 ID。
2. **桥自身发出的消息不会回流**。入站只来自两个 Adapter；OneBot Action 出站路径不复入
   `handleInbound`，避免自环。
3. **能力不确定即“不支持”**。`capabilities` 默认保守；配置只可覆盖已声明的 flag。
4. **永久错误不重试**。错误分类集中在 `queue.classifyDeliveryError`：`rate_limited` /
   `platform_unavailable` / `timeout` / `internal` 可重试，其余一律永久失败。
5. **Action 一定被响应或一定被清理**。超时先结算再 abort；迟到响应丢弃；断线时 abort 全部 pending。
6. **凭据不落库、不入日志、不回前端**。只从 `process.env` 读取；控制台只暴露
   “已配置/未配置”。

---

## 5. 存储模型（SQLite，`node:sqlite`）

| 表 | 用途 |
| --- | --- |
| `id_mappings` | 原生 ID ↔ OneBot ID（重启稳定） |
| `id_allocator` | 按 kind 的 OneBot 号段游标（不回退） |
| `inbound_dedupe` | 入站去重键 + TTL |
| `outbox_messages` | 待发送/重试中的出站消息（JSON payload） |
| `delivery_attempts` | 每次投递尝试（成功/可重试/永久） |
| `dead_letters` | 永久失败消息 + 原因码 |
| `rate_limit_buckets` | 固定窗口限流计数 |
| `rules` | 规则（JSON 字段 + 优先级） |
| `settings` | 控制台改动（回复策略、引擎开关、重试参数、平台开关/设置、self_id） |
| `messages` | 控制台读模型（入站时间线、会话聚合、24h 趋势） |
| `logs` | 结构化日志环形保留（供 `/logs` 页面） |
| `schema_migrations` | 迁移版本 |

迁移是**版本化且幂等**的；启动时自动补齐，`storage.migrate()` 可重复调用。
WAL 模式下 `busy_timeout=5000`；`:memory:` 时自动跳过 WAL 设置（测试用）。

---

## 6. 并发模型

- 单进程、事件循环驱动；存储层**全同步**（`node:sqlite`），避免事务竞态。
- `claimDue` 在单事务内把到期记录置为 `sending`，天然防止重复投递。
- `OutboxWorker.tick()` 可并发调用，但 `start()` 轮询做了重入保护；`stop()` 等待在飞批次。
- Gateway 心跳与重连使用 `setInterval`/`setTimeout`（已 `unref()`，不阻塞进程退出）。
- 优雅关闭顺序：HTTP → health → runtime（worker → gateways → OneBot 服务端）→ storage。

---

## 7. 扩展点

| 想做的事 | 改哪里 |
| --- | --- |
| 新增平台 | 新增 `packages/adapters-<p>`：实现事件归一化 + `send()`；在 `runtime` 装配并登记能力矩阵 |
| 新增 OneBot Action | `apps/server/src/actions.ts` 注册 handler（返回 `{status:'ok'|'async', data}`） |
| 新增规则条件 | `shared-types/rules.ts` 扩字段 → `packages/rules/src/match.ts` 实现 → 控制台表单 |
| 调整重试策略 | `config.yaml` 的 `retry` 或控制台 `/settings`（持久化到 `settings` 表） |
| 更换存储 | 实现 `packages/storage/src/contracts.ts` 的 `Storage` 门面并在 `openStorage` 处切换 |
