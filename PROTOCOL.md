# OneBot 11 协议契约（PROTOCOL）

OmniRelay 作为 **OneBot 11 反向 WebSocket 服务端**运行：由宿主应用主动连接到桥，
桥向宿主推送事件，宿主在同一连接上发送 Action。

---

## 1. 连接

```text
URL:   ws://<host>:8098/onebot/v11/ws      （监听地址/端口/路径均可配置）
```

鉴权（二选一，推荐 Header）：

```http
Authorization: Bearer <ONEBOT_BRIDGE_TOKEN>
```

```text
ws://<host>:8098/onebot/v11/ws?access_token=<ONEBOT_BRIDGE_TOKEN>
```

| 情况 | 行为 |
| --- | --- |
| 路径不匹配 | HTTP 404，连接关闭 |
| 缺少/错误 Token | HTTP 401，连接关闭；**响应与日志都不包含 Token** |
| `ONEBOT_BRIDGE_TOKEN` 为空且 `require_access_token=false` | 不鉴权（仅建议回环地址使用） |
| 未配置 Token 但 `require_access_token=true` | 桥拒绝启动（配置错误） |

连接成功后立即收到 `lifecycle`，随后按 `onebot.heartbeat_interval_seconds`（默认 30s）收到
`heartbeat`。

---

## 2. 桥 → 宿主 事件

### 2.1 私聊消息

```json
{
  "time": 1730000000,
  "self_id": 1000000000,
  "post_type": "message",
  "message_type": "private",
  "sub_type": "friend",
  "user_id": 1000000001,
  "message_id": "brg_discord_1a2b3c4d5e6f7a8b",
  "message": [{ "type": "text", "data": { "text": "你好" } }],
  "raw_message": "你好",
  "sender": { "user_id": 1000000001, "nickname": "alice" }
}
```

### 2.2 群聊消息

```json
{
  "time": 1730000000,
  "self_id": 1000000000,
  "post_type": "message",
  "message_type": "group",
  "sub_type": "normal",
  "group_id": 2000000001,
  "user_id": 1000000002,
  "message_id": "brg_qq-official_9f8e7d6c5b4a3210",
  "message": [{ "type": "text", "data": { "text": "在吗" } }],
  "sender": { "user_id": 1000000002, "nickname": "bob", "role": "member" }
}
```

- Discord 的 **Guild 频道**映射为 `group`（`group_id` 来自 `platform:channel` 映射）。
- `message_id` 为桥生成的稳定 ID；平台原始 ID 不出现在 OneBot 字段里。
- `time` 为事件时间的 epoch 秒。

### 2.3 元事件

```json
{"post_type":"meta_event","meta_event_type":"lifecycle","sub_type":"connect","time":1730000000,"self_id":1000000000}
{"post_type":"meta_event","meta_event_type":"heartbeat","interval":30000,"time":1730000000,"self_id":1000000000,
 "status":{"online":true,"good":true}}
```

### 2.4 消息段

| OneBot 段 | 说明 |
| --- | --- |
| `{"type":"text","data":{"text":"..."}}` | 文本 |
| `{"type":"at","data":{"qq":1000000002,"name":"bob"}}` | 提及（`qq=all` 不产生该段；无法解析的提及被丢弃） |
| `{"type":"image","data":{"file":"<url>","url":"<url>"}}` | 图片（`file` 与 `url` 同为可访问 URL） |
| `{"type":"file","data":{"file":"<filename>","url":"<url>","name":"<filename>","file_size":123}}` | 文件 |
| `{"type":"reply","data":{"id":"..."}}` | 引用（入站事件中一般不出现） |

> 媒体 URL 可能是平台**临时链接**（尤其 QQ），请在宿主侧立即下载，不要当作永久 URL。

---

## 3. 宿主 → 桥 Action

请求格式：

```json
{ "action": "send_msg", "params": { }, "echo": "uuid" }
```

响应格式：

```json
{ "status": "ok",     "retcode": 0,   "data": { }, "echo": "uuid" }
{ "status": "async",  "retcode": 1,   "data": { "message_id": "out_xxx" }, "echo": "uuid" }
{ "status": "failed", "retcode": 100, "message": "platform rejected message", "echo": "uuid" }
```

- `echo` 原样回填；同一连接的重复/迟到响应会被忽略。
- 每个 Action 有超时（默认 `onebot.action_timeout_ms = 10000`），超时返回
  `{"status":"failed","retcode":1504,"message":"action_timeout"}`。
- 非法 JSON / 非 Action 对象 → `failed` / `1400`。
- 并发 pending 超过 `onebot.max_pending_actions` → 新 Action 返回 `failed` / `1429`。

### 3.1 支持的 Action

| Action | params | data |
| --- | --- | --- |
| `get_login_info` | — | `{user_id, nickname}` |
| `get_status` | — | `{online, good}` |
| `get_version_info` | — | `{app_name, app_version, protocol_version, app_full_name}` |
| `get_group_list` | — | `[{group_id, group_name}]`（来自已知映射，最多 200/类型） |
| `get_group_info` | `group_id` | `{group_id, group_name}` |
| `get_group_member_info` | `group_id`,`user_id` | `{group_id, user_id, nickname, card, role}` |
| `get_stranger_info` | `user_id` | `{user_id, nickname, sex, age}` |
| `send_msg` | `message_type?`,`user_id?`,`group_id?`,`message` | `{message_id}`（**async**） |
| `send_private_msg` | `user_id`,`message` | `{message_id}`（**async**） |
| `send_group_msg` | `group_id`,`message` | `{message_id}`（**async**） |
| `get_msg` | `message_id` | 完整 `message` 事件（回放已存储的入站消息） |
| `delete_msg` | `message_id` | `{}`（Discord 真实撤回；QQ 返回 `1405`） |
| `get_group_member_list` | `group_id` | `[{group_id, user_id, nickname, card, role}]`（仅桥观察到的成员） |

`message` 支持两种形式：

1. 段数组：`[{"type":"text","data":{"text":"hi"}}]`
2. CQ 字符串：`"hi [CQ:at,qq=1000000002]"`（支持 `&#91;`/`&#93;`/`&#44;`/`&amp;` 反转义）

`get_msg` / `delete_msg` / `get_group_member_list` 为规范中的**可选** Action，均已实现，但有如下边界：

- `get_msg` 与 `delete_msg` 只能作用于**桥已经存过**的消息（入站消息存在 `messages` 表）。
  未知 `message_id` 返回 `1404`；`message_id` 缺失或类型非法返回 `1400`。
- `delete_msg`：Discord 走 `DELETE /channels/{channel_id}/messages/{message_id}` 真实撤回；
  **QQ 官方机器人没有撤回接口**，因此启用状态下返回 `1405 capability_unsupported`（不会假装成功）。
  平台停用时返回 `1500 platform_unavailable`。
- `get_group_member_list` 只返回**桥实际观察到过**的成员（来自入站消息的时间线），
  因为 QQ 只推送 @ 消息、无法枚举全量群成员；未知 `group_id` 返回 `1404`。

### 3.2 为什么 `send_*` 是异步

出站消息先落 SQLite outbox 再异步投递：进程重启不会丢失待发消息，且能统一处理重试/退避/死信。
因此 `send_*` 返回 `status:"async"`、`retcode:1`、`data.message_id` 为 **outbox 记录 ID**，
最终投递结果可在控制台“队列/死信”页面查看。平台能力/限流拒绝时会**同步**返回 `failed`。

---

## 4. 返回码（retcode）

| retcode | 场景 |
| --- | --- |
| `0` | 成功（同步） |
| `1` | 已接受，异步投递中 |
| `100` | 平台永久拒绝（审核失败、目标不存在、内容被拒、主动消息额度耗尽等） |
| `1400` | 参数错误 / 非法 JSON / 空消息 / 内容超长 |
| `1403` | 鉴权失败、无权限（`unauthorized` / `forbidden`） |
| `1404` | 未知 Action、未知 `user_id`/`group_id` |
| `1405` | 平台能力不支持（例如向未开启主动消息的 QQ 群主动发送） |
| `1429` | 限流（Action 级 60 条/分钟、pending 过多、平台 429） |
| `1500` | 内部错误 / 平台临时不可用（可重试） |
| `1504` | Action 超时 |

错误消息经过凭据脱敏（`Bearer xxx`、`token=`、`secret=`、`access_token=` → `[redacted]`），
并截断到 512 字符。

---

## 5. ID 映射约定

```text
discord:user:<userId>        → user_id  1000000001…
discord:channel:<channelId>  → group_id 2000000001…
qq:user:<user_openid>        → user_id  1000000001…
qq:group:<group_openid>      → group_id 2000000001…
```

- 映射落库，**重启后不变**；不同平台号段不冲突。
- 未出现过的原生 ID 在首次出现时分配；未知 OneBot ID 反查失败会返回 `1404`。
- 平台 ID 变化不会静默复用旧 ID（新原生 ID 得到新 OneBot ID）。

---

## 6. 与真实 OneBot 实现的差异

| 点 | 说明 |
| --- | --- |
| 无 `get_friend_list` | 桥没有好友列表概念，未实现全量好友枚举 |
| `get_group_member_list` 不是全量 | 只返回桥观察到的成员（QQ 无法枚举全量群成员） |
| 无非消息事件 | 只推送 `message` + `meta_event`；`notice`/`request` 未实现 |
| 头像/昵称 | 昵称可能为 `null`，头像 URL 未透出（避免临时链接外泄） |
| `send_*` 语义 | 恒为异步接受，最终结果在控制台可见 |
