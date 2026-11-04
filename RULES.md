# 规则引擎说明（RULES）

规则引擎是一个**纯函数**模块（`packages/rules`）：不读数据库、不发请求、不看当前时间以外的环境，
因此可以完全离线做单元测试（`tests/rules`，共 60+ 用例）。

```ts
const decision = evaluateMessageRule(event, rules, capabilities, {
  replyPolicy,      // 全局回复策略
  engine,           // { enabled, defaultAction, stopOnFirstMatch }
  now: new Date(),  // 可注入时钟
  isRateLimited,    // 可选：由调用方提供的实时限流查询
});
```

---

## 1. 数据结构

```ts
interface MessageRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;                 // 越大越先匹配
  platforms: ('discord' | 'qq-official')[];
  conversationKinds: ('private' | 'group' | 'channel')[];
  groupIds: string[];               // 原生 group ID
  channelIds: string[];             // 原生 channel ID
  userIds: string[];                // 原生 user ID
  trigger: TriggerConfig;
  response: ResponsePolicy;
  rateLimit?: RateLimitConfig;
  schedule?: ScheduleConfig;
  createdAt: string;
  updatedAt: string;
}

interface TriggerConfig {
  requireMention?: boolean;         // 必须 @ 机器人
  requireReplyToBot?: boolean;      // 必须是回复机器人消息
  textIncludes?: string[];          // 任一子串命中（大小写敏感）
  textPrefix?: string;
  textRegex?: string;               // JS 正则；非法正则 → 不匹配（text_regex_invalid）
  messageTypes?: ('text' | 'image' | 'file' | 'mixed')[];
  userAllowlist?: string[];
  groupAllowlist?: string[];
  channelAllowlist?: string[];
  privateOnly?: boolean;
  groupOnly?: boolean;
  ignoreBots?: boolean;             // 默认 true：忽略其他机器人
}

interface ResponsePolicy {
  enabled: boolean;                 // false 表示该规则“终止但不回复”
  allowProactive: boolean;
  allowPrivate: boolean;
  allowGroup: boolean;
  allowChannel: boolean;
  maxResponseSegments?: number;     // 出站段数预算，超出则投递失败
}

interface RateLimitConfig { maxMessages: number; windowSeconds: number; scope: 'user'|'conversation'|'platform'|'global'; }

interface ScheduleConfig {
  timezone?: string;                // 缺省 UTC
  weekdays?: number[];              // 1=周一 … 7=周日
  startTime?: string;               // "22:00"，支持跨午夜
  endTime?: string;                 // "02:00"
}
```

`response.enabled = false` 的用途：写一条高优先级规则“命中即忽略”，挡住某些群/用户。

---

## 2. 评估顺序（严格按此实现）

```text
1. 自己/其他机器人发的消息          → ignored  reason=bot_message_ignored
2. 平台接收能力
     private → privateReceive
     group   → mentionsBot ? groupMentionReceive : groupReceive
     channel → mentionsBot ? groupMentionReceive : groupReceive
     不支持                            → blocked reason=capability_unsupported:<flag>
3. 规则引擎开关 engine.enabled=false  → ignored reason=rules_engine_disabled
4. 全局回复策略（见下一节）
5. 规则匹配（priority 降序，同优先级按 createdAt 升序）
     - enabled=false                  → 跳过（detail: rule_disabled）
     - schedule 不在窗口               → 跳过（detail: schedule_inactive）
     - 条件不满足                      → 跳过（detail: platform_mismatch / conversation_kind_mismatch /
                                                  group_not_allowlisted / channel_not_allowlisted /
                                                  user_not_allowlisted / mention_required / reply_required /
                                                  text_prefix_mismatch / text_includes_mismatch /
                                                  text_regex_mismatch / text_regex_invalid /
                                                  message_type_mismatch / private_only_violation /
                                                  group_only_violation / author_is_bot）
     - 命中但被限流                    → blocked  reason=rule_rate_limited:<ruleId>
     - 命中且 response.enabled=false   → ignored  reason=rule_response_disabled:<ruleId>
     - 命中                            → reply    reason=matched:<ruleId>
     - stopOnFirstMatch=true（默认）时立刻结束；false 时继续收集，最终结论取第一条 reply
6. 没有任何命中                       → ignored reason=no_rule_matched
```

`status` 与 `decision` 的映射：`reply → queued`，`ignored → ignored`，`blocked → blocked`。
**`ignored` 不是错误**，控制台与日志按此区分。

---

## 3. 全局回复策略

配置位置：`config.yaml` 的 `reply_policy`，或控制台 `/settings`（写入数据库后覆盖 YAML）。

```yaml
reply_policy:
  default_mode: mention_only          # always | mention_only | private_only | whitelist | disabled
  allow_private_without_mention: true
  allow_group_without_mention: false
  allow_channel_without_mention: false
  whitelist_user_ids: []
  whitelist_group_ids: []
```

| 模式 | 行为 | 不满足时 |
| --- | --- | --- |
| `always` | 通过策略层，交给规则判断 | — |
| `mention_only` | 非私聊必须 `@` 机器人或回复机器人消息 | ignored `mention_required_missing` |
| `private_only` | 只处理私聊 | blocked `private_only_violation` |
| `whitelist` | 发送者或会话必须在白名单 | blocked `whitelist_mismatch` |
| `disabled` | 暂停所有自动回复 | ignored `reply_policy_disabled` |

规则可以**收紧**策略（例如 `trigger.requireMention: true`），但**不能放宽平台能力**。

示例：管理员命令即使在 `mention_only` 模式下也无需 @ ——

```json
{
  "name": "管理员命令",
  "priority": 500,
  "platforms": ["discord"],
  "conversationKinds": ["group"],
  "trigger": { "textPrefix": "!", "requireMention": false, "userAllowlist": ["1234567890"] },
  "response": { "enabled": true, "allowProactive": false, "allowPrivate": true, "allowGroup": true, "allowChannel": true }
}
```

> 注意：`mention_only` 模式下，非私聊消息在**策略层**就会被拦下，规则不会被执行。
> 若要让某些规则豁免，请把 `default_mode` 改为 `always`，再用规则自身条件收敛。

---

## 4. 限流

- 规则级 `rateLimit` 在**投递计划**阶段消费（`rate_limit_buckets` 固定窗口计数）；
  超出时返回 `blocked / rate_limited`，不进入 outbox。
- OneBot Action 出站另有**平台级安全上限**：每平台 60 条/分钟（`actions.ts` 中的 `ACTION_RATE_LIMIT`），
  超出返回 `retcode 1429`。
- 平台侧的 429 会被分类为可重试错误，按退避策略重试，不会无限快速重试。

---

## 5. 时间段与工作日

- `timezone` 缺省 `UTC`，使用 `Intl.DateTimeFormat` 取该时区的星期与时分。
- `weekdays: [1,2,3,4,5]` 表示仅工作日。
- `startTime`/`endTime` 为 `HH:mm`，支持跨午夜（如 `22:00`–`02:00`）。
- 全部字段缺省 = 全天有效。

```json
{
  "schedule": { "timezone": "Asia/Shanghai", "weekdays": [1,2,3,4,5], "startTime": "09:00", "endTime": "18:30" }
}
```

---

## 6. 规则测试器

控制台 `/rules` 页面内置测试器，调用 `POST /api/rules/test`：

```json
// 请求
{
  "platform": "discord",
  "conversationKind": "group",
  "conversationId": "300300300",
  "userId": "200200200",
  "text": "hello bot",
  "mention": false,
  "replyToBot": false,
  "ruleIds": null
}

// 响应
{
  "matched": false,
  "matchedRules": [],
  "decision": "ignore",
  "status": "ignored",
  "reason": "mention_required_missing",
  "explanation": "...",
  "appliedPolicyMode": "mention_only",
  "evaluatedRules": [
    { "id": "rule_xxx", "name": "群内 @ 回复", "matched": false, "reason": "mention_required" }
  ]
}
```

测试器使用与线上完全相同的纯函数实现，因此“测试通过”与“线上行为”一致。

---

## 7. 编写建议

1. 用**高优先级 + 窄条件**的规则做特例（管理员命令、关键词），用**低优先级 + 宽条件**做兜底。
2. `ignored` 与 `blocked` 分清：权限问题用 `blocked` 语义（能力/白名单），规则不感兴趣用 `ignored`。
3. 需要“命中即静音”时使用 `response.enabled: false`，而不是删除消息。
4. 主动消息（`allowProactive: true`）在 QQ 上受额度与用户开关限制，默认应保持关闭。
