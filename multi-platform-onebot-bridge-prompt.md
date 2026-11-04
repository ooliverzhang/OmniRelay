# OmniRelay：独立的 Discord / QQ 官方机器人 → OneBot 11 多平台桥与控制中心

> 项目名称：**OmniRelay**
>
> 中文定位：**全域消息中继**
>
> 仓库名：`omni-relay`
>
> 这是一个独立的多平台消息中继、规则引擎和 Web 管理控制台项目。

你是一名资深的 Node.js / TypeScript、WebSocket、即时通讯协议和平台适配器工程师。

请在当前本地工作区创建一个**完全独立的新项目**：

```text
omni-relay
```

这是一个独立的多平台消息桥，不依赖任何特定宿主应用。它只需要对外提供标准的 **OneBot 11 Reverse WebSocket** 接口，任何兼容 OneBot 11 的上层应用都可以连接使用。

> 重要限制：
>
> - 只在本地开发和测试
> - 不要 SSH 到任何服务器
> - 不要上传任何文件
> - 不要调用宝塔 MCP
> - 不要修改已有项目、已有服务或系统配置
> - 不要读取或索取生产环境凭据
> - 不要把真实 Token、AppSecret、Cookie 写入代码、测试或日志

---

## 一、项目目标

实现如下架构：

```text
Discord Gateway ─────┐
                     │
QQ 官方机器人 Gateway ─┼── Multi-Platform Bridge
                     │             │
                     └─────────────┴── OneBot 11 Reverse WebSocket
                                                   │
                                                   ▼
                                      任意 OneBot 11 兼容宿主
```

桥接服务负责：

1. 连接 Discord Bot Gateway
2. 连接 QQ 官方机器人 Gateway 和 REST API
3. 将 Discord / QQ 事件转换成统一内部事件
4. 将统一内部事件转换成 OneBot 11 事件
5. 接收 OneBot 11 Action
6. 将 OneBot Action 转换成 Discord / QQ 的发送操作
7. 管理平台 ID 映射
8. 处理消息去重、限流、重试和死信
9. 根据平台能力拒绝不允许的操作
10. 提供健康检查、状态查询和结构化日志

项目本身不实现 AI 逻辑，也不绑定任何特定机器人框架。

---

```text
Discord Gateway ─────┐
                     │
QQ 官方机器人 Gateway ─┼── OmniRelay Core ─── OneBot 11 Reverse WebSocket
                     │          │
                     │          ├── Rule Engine
                     │          ├── SQLite Storage
                     │          └── Web API
                     │                    │
                     └────────────── OmniRelay Web Console
```

桥接服务负责：

1. 连接 Discord Bot Gateway
2. 连接 QQ 官方机器人 Gateway 和 REST API
3. 将 Discord / QQ 事件转换成统一内部事件
4. 将统一内部事件转换成 OneBot 11 事件
5. 接收 OneBot 11 Action
6. 将 OneBot Action 转换成 Discord / QQ 的发送操作
7. 管理平台 ID 映射
8. 处理消息去重、限流、重试和死信
9. 根据平台能力拒绝不允许的操作
10. 通过规则引擎决定消息是否触发、是否需要 @、是否允许主动发送
11. 提供 Web 管理控制台，用于配置平台、规则、群组、用户和日志
12. 提供健康检查、状态查询和结构化日志

项目本身不实现 AI 逻辑，也不绑定任何特定宿主应用。Web 控制台只负责管理 OmniRelay，不负责替代上层 AI 或机器人宿主。

---

## 二、产品定位与项目命名

项目正式名称：

```text
OmniRelay
```

中文名称：

```text
全域消息中继
```

仓库目录：

```text
omni-relay
```

建议产品副标题：

```text
One bridge. Many platforms. Clear rules.
```

OmniRelay 由三部分组成：

1. **Core**：平台连接、消息转换、OneBot 服务端、队列和存储
2. **Rule Engine**：消息触发条件、回复策略、权限和主动发送策略
3. **Web Console**：类似 AstrBot 的可视化管理面板

---

## 三、Web 管理控制台

必须为项目实现独立前端，不能只提供命令行配置。

推荐技术：

- React
- TypeScript
- Vite
- Tailwind CSS 或等价方案
- React Router
- TanStack Query 或等价数据请求库
- ECharts 或等价图表库

前端由后端静态托管，开发时允许使用 Vite dev server。

### 前端页面

至少实现以下页面：

```text
/login
/dashboard
/platforms
/platforms/:id
/rules
/rules/new
/rules/:id/edit
/conversations
/identities
/queues
/logs
/settings
```

### Dashboard

显示：

- Discord 连接状态
- QQ 官方机器人连接状态
- OneBot WebSocket 连接状态
- 当前启用平台数量
- 最近消息数
- 待发送队列数量
- 失败/死信数量
- 最近错误
- 各平台消息量
- 最近 24 小时消息趋势

### 平台管理

支持在前端配置：

- 启用/停用 Discord
- Discord Bot Token 环境变量名称
- Guild 白名单
- Channel 白名单
- QQ AppID 环境变量名称
- QQ AppSecret 环境变量名称
- QQ 群白名单
- QQ 主动私聊开关
- QQ 主动群聊开关
- 平台连接测试
- 平台重连
- 平台能力查看

真实 Token 和 AppSecret 不允许通过普通 API 返回给前端。前端只能看到：

```text
已配置
未配置
已连接
连接失败
```

### 规则管理

前端必须支持规则的增删改查、启用/停用、排序和测试。

规则字段至少包括：

```ts
interface MessageRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  platforms: ('discord' | 'qq-official')[];
  conversationKinds: ('private' | 'group' | 'channel')[];
  groupIds: string[];
  channelIds: string[];
  userIds: string[];
  trigger: TriggerConfig;
  response: ResponsePolicy;
  rateLimit?: RateLimitConfig;
  schedule?: ScheduleConfig;
  createdAt: string;
  updatedAt: string;
}
```

规则匹配条件至少支持：

- 平台
- 私聊/群聊/频道
- 指定群组
- 指定频道
- 指定用户
- 是否 @机器人
- 是否回复机器人消息
- 是否包含文本
- 文本前缀
- 文本正则表达式
- 消息类型
- 是否包含图片或文件
- 时间段
- 工作日
- 规则优先级

### “只有 @ 才回复”模式

必须提供简单的全局设置：

```yaml
reply_policy:
  default_mode: mention_only
```

可选模式：

```text
always       收到符合权限的消息就处理
mention_only  只有 @机器人时处理
private_only  只处理私聊
whitelist     只处理白名单用户/群组
disabled      暂停自动回复
```

建议前端显示为：

```text
默认回复模式：
○ 始终回复
● 只有 @机器人时回复
○ 只回复私聊
○ 仅白名单回复
○ 暂停自动回复
```

规则级别可以覆盖全局设置。例如：

```json
{
  "name": "管理员命令",
  "trigger": {
    "requireMention": false,
    "userAllowlist": ["discord:user:123", "qq:user:openid_xxx"]
  },
  "response": {
    "enabled": true
  }
}
```

### 规则执行顺序

```text
收到平台事件
    ↓
规范化消息
    ↓
去重
    ↓
平台/群/用户权限检查
    ↓
全局回复策略检查
    ↓
规则按 priority 从高到低匹配
    ↓
命中第一条终止规则或继续匹配
    ↓
生成 OneBot 事件
```

必须明确区分：

- `ignored`：消息被规则忽略，不是错误
- `blocked`：没有权限
- `queued`：已进入发送队列
- `sent`：平台已接受
- `failed`：平台永久拒绝

### 规则测试器

前端应提供“测试规则”功能：

用户输入：

- 平台
- 会话类型
- 是否 @机器人
- 用户 ID
- 群组 ID
- 模拟消息文本

返回：

```json
{
  "matched": true,
  "matchedRules": ["rule-1"],
  "decision": "reply",
  "reason": "mention_required_and_present"
}
```

### 会话与消息查看

前端支持：

- 按平台筛选
- 按群组/频道筛选
- 按用户筛选
- 查看最近消息
- 查看消息来源平台
- 查看 OneBot 映射 ID
- 查看投递状态
- 查看失败原因

默认脱敏消息中的 Token、Cookie、AppSecret 和 Authorization Header。

### 队列与日志

前端支持：

- 查看待处理消息
- 查看重试次数
- 查看死信
- 手动重试可重试失败
- 删除死信
- 按平台过滤
- 按错误类型过滤
- 查看结构化日志

手动重试必须再次经过规则和平台能力检查，不能绕过安全规则。

---

## 四、规则引擎数据模型

规则引擎必须独立于平台 Adapter 和 OneBot 层。

```ts
interface TriggerConfig {
  requireMention?: boolean;
  requireReplyToBot?: boolean;
  textIncludes?: string[];
  textPrefix?: string;
  textRegex?: string;
  messageTypes?: ('text' | 'image' | 'file' | 'mixed')[];
  userAllowlist?: string[];
  groupAllowlist?: string[];
  channelAllowlist?: string[];
  privateOnly?: boolean;
  groupOnly?: boolean;
}

interface ResponsePolicy {
  enabled: boolean;
  allowProactive: boolean;
  allowPrivate: boolean;
  allowGroup: boolean;
  allowChannel: boolean;
  maxResponseSegments?: number;
}

interface RateLimitConfig {
  maxMessages: number;
  windowSeconds: number;
  scope: 'user' | 'conversation' | 'platform' | 'global';
}

interface ScheduleConfig {
  timezone?: string;
  weekdays?: number[];
  startTime?: string;
  endTime?: string;
}
```

规则引擎需要提供纯函数式测试入口：

```ts
const decision = evaluateMessageRule(message, rules, capabilities);
```

规则判断不能直接调用 Discord 或 QQ API，以便进行离线单元测试。

---

## 五、技术要求

使用：

- Node.js 22+
- TypeScript
- ESM
- `ws` 或等价 WebSocket 库
- Node 原生 `fetch` / `undici`
- SQLite 作为默认持久化数据库
- `zod` 或等价方案做配置和消息校验
- `pino` 或等价方案做结构化日志
- Vitest 或 Jest 做自动化测试
- Docker Compose 支持本地运行

必须支持：

```bash
npm install
npm run typecheck
npm test
npm run build
```

推荐启用：

- React
- Vite
- Tailwind CSS 或等价方案
- React Router
- TanStack Query 或等价数据请求库
- ECharts 或等价图表库
- `strict` TypeScript
- ESLint
- Prettier
- 数据库迁移机制
- 优雅关闭
- SIGTERM / SIGINT 处理

前端构建必须支持：

```bash
npm run web:dev
npm run web:build
npm run web:test
```

---

## 六、OneBot 11 Reverse WebSocket 服务端

桥必须提供 OneBot 11 Reverse WebSocket 服务端，而不是让上层应用暴露服务端端口。

默认地址示例：

```text
ws://multi-platform-bridge:8098/onebot/v11/ws
```

配置示例：

```yaml
onebot:
  listen_host: 0.0.0.0
  listen_port: 8098
  websocket_path: /onebot/v11/ws
  access_token_env: ONEBOT_BRIDGE_TOKEN
```

### 连接鉴权

支持以下方式之一，并在文档中明确：

```http
Authorization: Bearer <ONEBOT_BRIDGE_TOKEN>
```

或：

```text
?access_token=<ONEBOT_BRIDGE_TOKEN>
```

推荐优先使用 `Authorization` Header。

Token 错误时：

- 拒绝 WebSocket 升级
- 返回合适的 HTTP 状态码
- 日志中不能打印 Token

### 桥 → OneBot 事件

至少实现 `message` 事件。

私聊事件格式：

```json
{
  "time": 1730000000,
  "self_id": 1000000001,
  "post_type": "message",
  "message_type": "private",
  "sub_type": "friend",
  "user_id": 2000000001,
  "message_id": "discord:message-id",
  "message": [
    {
      "type": "text",
      "data": {
        "text": "你好"
      }
    }
  ]
}
```

群聊事件格式：

```json
{
  "time": 1730000000,
  "self_id": 1000000001,
  "post_type": "message",
  "message_type": "group",
  "sub_type": "normal",
  "group_id": 3000000001,
  "user_id": 2000000002,
  "message_id": "qq:message-id",
  "message": [
    {
      "type": "text",
      "data": {
        "text": "你好"
      }
    }
  ]
}
```

可选支持：

- `meta_event`
- `heartbeat`
- `notice`
- `request`

### OneBot Action

上层应用通过同一条 WebSocket 发送 Action：

```json
{
  "action": "send_msg",
  "params": {
    "message_type": "group",
    "group_id": 3000000001,
    "message": [
      {
        "type": "text",
        "data": {
          "text": "你好"
        }
      }
    ]
  },
  "echo": "uuid"
}
```

桥必须返回对应的 `echo`：

```json
{
  "status": "ok",
  "retcode": 0,
  "data": {
    "message_id": "platform-message-id"
  },
  "echo": "uuid"
}
```

异步接受：

```json
{
  "status": "async",
  "retcode": 1,
  "data": {
    "message_id": "queued-id"
  },
  "echo": "uuid"
}
```

永久失败：

```json
{
  "status": "failed",
  "retcode": 100,
  "message": "platform rejected message",
  "echo": "uuid"
}
```

### 必须支持的 Action

```text
get_login_info
get_status
get_version_info
get_group_list
get_group_info
get_group_member_info
get_stranger_info
send_msg
send_private_msg
send_group_msg
```

可选支持：

```text
delete_msg
get_msg
get_group_member_list
get_group_member_info
```

实现要求：

- 所有 Action 都必须有超时
- 所有 Action 都必须通过 `echo` 关联响应
- WebSocket 断开时，所有等待中的 Action 必须失败并释放内存
- 不允许无限积累 pending Action
- 对同一个 `echo` 的重复响应要安全忽略

---

## 七、统一内部事件模型

Discord 和 QQ 适配器不能直接操作 OneBot JSON，必须先转换为统一内部模型。

```ts
export type Platform = 'discord' | 'qq-official';

export type ConversationKind = 'private' | 'group' | 'channel';

export interface UnifiedMessageEvent {
  eventId: string;
  platform: Platform;
  conversation: {
    kind: ConversationKind;
    nativeId: string;
    displayName?: string;
  };
  sender: {
    nativeId: string;
    displayName?: string;
    username?: string;
    avatarUrl?: string;
  };
  message: UnifiedSegment[];
  timestamp: string;
  replyContext?: {
    nativeMessageId?: string;
    eventId?: string;
    expiresAt?: string;
    canReply: boolean;
  };
  raw?: unknown;
}
```

统一消息段：

```ts
export type UnifiedSegment =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'mention';
      userId: string;
    }
  | {
      type: 'image';
      url: string;
      filename?: string;
      width?: number;
      height?: number;
    }
  | {
      type: 'file';
      url: string;
      filename: string;
      size?: number;
    }
  | {
      type: 'reply';
      messageId: string;
    };
```

必须实现：

```text
UnifiedMessageEvent -> OneBot Event
OneBot Action       -> Platform Outgoing Message
```

---

## 八、Discord Adapter

实现 Discord Gateway 连接：

1. 获取 Gateway URL
2. 建立 WebSocket
3. 处理 Hello
4. 发送 Identify
5. 根据 `heartbeat_interval` 发送心跳
6. 处理 READY
7. 处理 `MESSAGE_CREATE`
8. 处理 reconnect
9. 处理 invalid session
10. 处理 Gateway close code
11. 支持断线重连和指数退避
12. 做消息去重

### Discord 配置

```yaml
discord:
  enabled: false
  token_env: DISCORD_BOT_TOKEN
  guild_allowlist: []
  channel_allowlist: []
  intents:
    guilds: true
    guild_messages: true
    message_content: true
    direct_messages: true
```

### Discord 权限

文档中说明需要：

- View Channel
- Read Message History
- Send Messages
- Attach Files
- Message Content Intent

### Discord 映射

| Discord | 统一模型 | OneBot |
|---|---|---|
| DM | `private` | `private_message` |
| Guild text channel | `group` | `group_message` |
| Discord user ID | `sender.nativeId` | `user_id` 映射值 |
| Discord channel ID | `conversation.nativeId` | `group_id` 映射值 |
| Discord attachment | `image` / `file` | OneBot segment |
| Discord mention | `mention` | `at` segment |

发送使用 Discord REST：

```text
POST /channels/{channel_id}/messages
```

不要把 Discord 原生 ID 直接当成 OneBot ID。

---

## 九、QQ 官方机器人 Adapter

使用 QQ 官方机器人 API v2：

- QQ 文档首页：<https://bot.q.qq.com/wiki/develop/api-v2/>
- 消息收发概述：<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html>
- 群 @ 机器人事件：<https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html>
- Access Token：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html>

### QQ 鉴权

使用：

```text
AppID
AppSecret
Access Token
```

Access Token 获取接口：

```text
https://bots.qq.com/app/getAppAccessToken
```

AppSecret、Access Token 只能从环境变量读取，不能写入日志。

### QQ 接收事件

至少支持：

```text
C2C_MESSAGE_CREATE
GROUP_AT_MESSAGE_CREATE
```

可选支持：

```text
GROUP_MESSAGE_CREATE
```

但全量群消息模式必须由配置显式开启，并且要验证官方权限是否允许。

### QQ 群 @ 事件关键字段

```text
group_openid
author.member_openid
author.member_role
content
attachments
id
timestamp
msg_seq
```

官方文档说明，`GROUP_AT_MESSAGE_CREATE` 的 `content` 已自动移除 @机器人前缀。

相同 `msg_id` 可能重复推送，需要使用：

```text
qq:<msg_id>:<msg_seq>
```

做幂等去重。

### QQ 发送接口

私聊：

```text
POST /v2/users/{user_openid}/messages
```

群聊：

```text
POST /v2/groups/{group_openid}/messages
```

支持：

- 文本
- Markdown（按官方能力判断）
- 图片
- 文件
- 被动回复
- 主动消息

### QQ 主动消息限制

必须实现平台能力声明，不能把 QQ 当作无限广播平台。

```ts
interface PlatformCapabilities {
  privateReceive: boolean;
  privateReply: boolean;
  privateProactiveSend: boolean;
  groupReceive: boolean;
  groupMentionReceive: boolean;
  groupReply: boolean;
  groupProactiveSend: boolean;
  broadcast: boolean;
}
```

QQ 初始能力建议：

```json
{
  "privateReceive": true,
  "privateReply": true,
  "privateProactiveSend": true,
  "groupReceive": false,
  "groupMentionReceive": true,
  "groupReply": true,
  "groupProactiveSend": true,
  "broadcast": false
}
```

必须处理：

- 用户关闭主动消息
- 被动回复时间窗口
- 每个用户/群的频率限制
- 每日额度
- 互动召回规则
- HTTP 429
- 权限不足
- 审核失败

QQ 永久失败不能无限重试。

---

## 十、平台 ID 映射

必须使用 SQLite 持久化：

```text
platform + kind + native_id -> onebot_id
```

示例：

```text
discord:user:123456789
    -> OneBot user_id 1000000001

discord:channel:987654321
    -> OneBot group_id 2000000001

qq:user:openid_xxx
    -> OneBot user_id 1000000002

qq:group:group_openid_xxx
    -> OneBot group_id 2000000002
```

要求：

- 重启后 ID 不变
- 不同平台不能 ID 冲突
- 可以从 OneBot ID 反查平台 ID
- 平台用户不存在时返回明确错误
- 平台 ID 变更不能静默复用旧 ID

---

## 十一、去重、防循环与统一消息元数据

Discord 去重键：

```text
discord:<message_id>
```

QQ 去重键：

```text
qq:<message_id>:<msg_seq>
```

每条内部消息携带：

```ts
interface MessageMeta {
  origin: 'discord' | 'qq-official' | 'onebot';
  bridgeMessageId: string;
  nativeMessageId?: string;
  createdAt: string;
}
```

桥自身发送的消息不能再次转回 OneBot，避免循环。

---

## 十二、持久化队列、限流和失败分类

SQLite 表至少包括：

```text
id_mappings
inbound_dedupe
outbox_messages
delivery_attempts
dead_letters
rate_limit_buckets
```

可重试：

```text
连接断开
连接超时
HTTP 429
临时 5xx
Gateway reconnect
```

不可重试：

```text
Token 无效
Bot 无权限
目标不存在
QQ 用户关闭主动消息
每日额度耗尽
Discord 频道删除
平台能力不支持
```

重试策略：

```text
指数退避 + 随机抖动
最大重试次数
dead-letter 状态
```

不能无限重试永久错误。

---

## 十三、媒体消息

### 入站

QQ 的附件 URL 有时效性，不能长期存成永久链接。

收到图片/文件后：

1. 记录原始 URL 和过期信息
2. 必要时立即下载
3. 转换成 OneBot `image` / `file` segment
4. 下载失败时返回明确错误

### 出站

从 OneBot 收到图片/文件：

1. 下载或读取文件
2. QQ 走官方上传接口拿到 `file_info`
3. Discord 走附件上传
4. 发送最终消息

不同平台的文件上传接口不能混用。

---

## 十四、配置文件

生成：

```text
.env.example
config.example.yaml
```

示例：

```yaml
server:
  host: 0.0.0.0
  onebot_port: 8098
  health_port: 8080
  websocket_path: /onebot/v11/ws

web:
  enabled: true
  host: 0.0.0.0
  port: 3000
  admin_auth: true
  session_secret_env: WEB_SESSION_SECRET
  admin_password_hash_env: WEB_ADMIN_PASSWORD_HASH
  cors_origins: []

reply_policy:
  default_mode: mention_only
  allow_private_without_mention: true
  allow_group_without_mention: false
  allow_channel_without_mention: false

rules:
  enabled: true
  default_action: ignore
  stop_on_first_match: true

onebot:
  access_token_env: ONEBOT_BRIDGE_TOKEN

discord:
  enabled: false
  token_env: DISCORD_BOT_TOKEN
  guild_allowlist: []
  channel_allowlist: []
  message_content_intent: true

qq:
  enabled: false
  app_id_env: QQ_APP_ID
  app_secret_env: QQ_APP_SECRET
  group_allowlist: []
  allow_proactive_private: true
  allow_proactive_group: false

storage:
  sqlite_path: ./data/bridge.sqlite

retry:
  max_attempts: 5
  initial_delay_ms: 1000
  max_delay_ms: 60000
```

安全默认值：

- OneBot WebSocket 只面向内网
- 不开放公网端口
- 默认所有平台关闭
- 默认 QQ 主动群发关闭
- 默认群聊需要白名单
- Token 只从环境变量读取

---

## 十五、健康检查与状态接口

实现：

```text
GET /healthz
GET /readyz
GET /status
```

`/status` 至少返回：

```json
{
  "onebot": {
    "connected": true,
    "last_event_at": "...",
    "pending_actions": 0
  },
  "discord": {
    "connected": true,
    "last_gateway_event_at": "..."
  },
  "qq": {
    "connected": true,
    "last_gateway_event_at": "..."
  },
  "queue": {
    "pending": 0,
    "dead": 0
  }
}
```

绝对不能在状态接口返回 Token、AppSecret 或 Cookie。

---

## 十六、测试要求

不能依赖真实平台 Token。

### OneBot 测试

- Mock OneBot 客户端连接 Reverse WebSocket
- 检查 Token 鉴权
- 接收 bridge 发出的 private_message
- 接收 bridge 发出的 group_message
- 发送 OneBot Action
- 检查 `echo` 响应匹配
- 测试断线和重连
- 测试 pending Action 超时

### Discord Mock

模拟：

- Hello
- Ready
- Heartbeat
- MESSAGE_CREATE
- DM
- Guild message
- Reconnect
- Invalid Session
- Gateway close

### QQ Mock

模拟：

- Access Token 获取
- C2C_MESSAGE_CREATE
- GROUP_AT_MESSAGE_CREATE
- 单聊发送
- 群聊发送
- 附件上传
- HTTP 429
- 主动消息关闭
- 权限失败
- 配额耗尽

### Core 单元测试

- Discord → Unified Event
- QQ → Unified Event
- Unified Event → OneBot Event
- OneBot Action → Discord
- OneBot Action → QQ
- ID 映射稳定性
- 消息去重
- 限流
- 重试和死信
- 平台能力判断

---

## 十七、项目文件

```text
omni-relay/
├── apps/
│   ├── server/
│   └── web/
├── packages/
│   ├── core/
│   ├── onebot/
│   ├── rules/
│   ├── storage/
│   ├── queue/
│   ├── capabilities/
│   ├── adapters-discord/
│   ├── adapters-qq/
│   └── shared-types/
├── tests/
├── data/
│   └── .gitkeep
├── .env.example
├── config.example.yaml
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── README.md
├── ARCHITECTURE.md
├── PROTOCOL.md
├── RULES.md
├── SECURITY.md
└── DEPLOYMENT.md
```

---

## 十八、开发顺序

### Phase 1：核心模型与规则引擎

- Unified Event
- Message Segment
- Capabilities
- ID mapping
- SQLite migration
- Dedupe
- Queue
- Rule Engine
- 全局回复策略
- 仅 @ 回复策略
- 规则匹配纯函数和测试

### Phase 2：后端 Web API 与认证

- 配置 API
- 平台管理 API
- 规则 CRUD API
- Dashboard 统计 API
- 队列与日志 API
- Web 控制台认证
- Token 脱敏
- 操作审计日志

### Phase 3：Web 管理控制台

- Dashboard
- 平台配置
- 规则列表/编辑器
- 仅 @ 回复设置
- 群组/频道白名单
- 会话和消息查看
- 队列与死信管理
- 日志查看
- 规则测试器

### Phase 4：OneBot Server

- Reverse WebSocket
- Bearer Token
- Event sending
- Action receiving
- Echo correlation
- Mock client tests

### Phase 5：Discord Adapter

- Gateway
- Heartbeat
- Reconnect
- MESSAGE_CREATE
- DM
- Guild message
- Attachments

### Phase 6：QQ Adapter

- Access Token
- Gateway
- C2C
- GROUP_AT
- send private/group
- Active-message capability and quota errors

### Phase 7：Integration

- Docker Compose
- Health endpoints
- Structured logs
- Config validation
- Full test suite
- Frontend production build
- Browser smoke tests

---

## 十九、严格限制

- 只在本地实现
- 不要 SSH
- 不要调用任何服务器管理工具
- 不要上传服务器
- 不要修改现有项目
- 不要提交真实 Token
- 不要将 Token 写进测试或日志
- 不要默认启用 QQ 主动群发
- 不要把平台原生 ID 当作跨平台统一 ID
- 不要把 QQ 临时附件 URL 当作永久 URL
- 能力不确定时必须标记为 unsupported，不可臆造

---

## 二十、最终验收标准

```bash
npm run typecheck
npm test
npm run build
docker compose config
```

必须明确验证：

1. Web 控制台可以登录
2. Dashboard 可以显示平台连接状态和队列统计
3. 平台配置可以新增、编辑、启用和停用
4. 规则可以新增、编辑、排序、启用和停用
5. “只有 @机器人时回复”模式生效
6. 私聊和群聊可以使用不同回复策略
7. 规则测试器可以返回命中规则和忽略原因
8. OneBot Reverse WebSocket 能被客户端连接
9. Discord 私聊能转换成 OneBot private_message
10. Discord 群消息能转换成 OneBot group_message
11. QQ C2C 能转换成 OneBot private_message
12. QQ GROUP_AT 能转换成 OneBot group_message
13. OneBot send_msg 能正确发送到 Discord
14. OneBot send_msg 能正确发送到 QQ
15. Echo 不会错配
16. 重复消息不会重复投递
17. QQ 主动消息限制返回明确错误，不会无限重试
18. Token 不会出现在日志中
19. Web 控制台不会向浏览器返回 Token 或 AppSecret

完成后只输出：

- 项目目录结构
- 运行原理
- OneBot 协议契约
- Discord / QQ 能力差异
- 测试结果
- 尚未实现的部分
- 未来部署步骤

不要上传服务器，等待人工审阅后再部署。
