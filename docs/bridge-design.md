# 桥接最终方案

> ⚠️ 2026-09-12 起改为**中转规则 v2（唯一闸门）**，见 `message-rules.md`。
> 本文件下面第一、二节里「dsh 直接给用户发消息」的部分是 v1 的历史设计，已作废：
> v2 下 dsh **不再直发用户**，只把结果落 `cache/outbox/`，由闸门取件转述。

## 结论
用 AstrBot 插件做通道，两句话概括：

- **上行（dsh → 闸门）**：dsh 把结果/通知写成本地文件 `cache/outbox/<id>.json`
  （v2 字段：source/ref/status/summary/content）。闸门取件后用自己的话转述给用户。
- **下行（闸门 → dsh）**：用户说的话先到闸门，闸门判断是指令才落盘
  `cache\inbox\<id>.json`，dsh 侧插件监听该目录读取。

另有本机 HTTP 通道（下面「插件」一节）：`http://127.0.0.1:6185/api/plug/astrbot_plugin_dsh_gateway/send`
可借用闸门的账号发消息。**注意它的收件人是用户本人**（私聊），所以 v2 下默认不用它
（插件 `uplinkMode` 默认 `off`），只在救火时显式打开。

## 插件：astrbot_plugin_dsh_gateway
位置：`<AstrBot目录>\data\plugins\astrbot_plugin_dsh_gateway`

- 路由：`/api/plug/astrbot_plugin_dsh_gateway/ping`（GET）与 `/send`（POST）。
- 鉴权：插件加载时用 `dashboard.jwt_secret` 自签一枚无过期时间的 HS256 令牌，
  写入 `bridge_access.json`（AstrBot data 目录与 `<项目目录>\cache\` 各一份）。
- 发送：内部用 `StarTools.send_message_by_id`，走 aiocqhttp 适配器。

## 上行调用样例
```http
POST http://127.0.0.1:6185/api/plug/astrbot_plugin_dsh_gateway/send
Authorization: Bearer <bridge_access.token>
Content-Type: application/json

{"text": "[dsh] 任务完成啦：……"}
```

## 下行流程
1. 用户在 QQ 私聊对闸门说指令。
2. 闸门判断是给 dsh 的任务，落盘为 `cache\inbox\<id>.json`：
   ```json
   {"id":"...","from":"gateway","to":"dsh","time":"...","type":"task","content":"...","status":"pending"}
   ```
   （`from` 写 `gateway`：v2 起 dsh 不直收用户原文，收到的一律是闸门筛选后的版本。）
3. dsh 端 cordis 插件监听 `cache\inbox\`，取走任务并把状态改为 `running`。
4. dsh 完成后写 `cache\outbox\<id>.json`（v2 全字段），**不再用上行接口即时通知用户**。

## 消息 JSON 约定
```json
{
  "id": "uuid",
  "from": "gateway | dsh",
  "to": "dsh | gateway",
  "source": "dsh",
  "time": "ISO8601",
  "type": "task | result | notice | question",
  "content": "文本",
  "status": "pending | running | done | failed | notice",
  "ref": "关联的上一条 id"
}
```

v2 要点：
- `source` 标明信息来源、`status` 标当前状态，**缺一不可**（用户明确要求）。
- dsh 写的文件 `to` 恒为 `gateway`；`to: "用户"` 只可能出现在 v1 历史文件里。
- 巡检通知落在 `outbox\<id>.notice.json`（`type: "notice"`、`notice: true`）。

## 分工
- **闸门端**：唯一闸门。下行负责筛选与落盘，上行负责取件（`outbox\`）并用自己的话转述给用户。
- **dsh 端**：cordis 插件；读 `bridge_access.json`、监听 inbox、把结果落 outbox。
  **不直发用户**（`uplinkMode` 默认 `off`，HTTP 通道仅在救火时开）。
- **用户**：只需在 QQ 里跟闸门说话。

## 已验证
- [x] 插件已加载（13 → 14 个插件）
- [x] `/ping` 返回 pong
- [x] `/send` 成功发出一条测试消息到用户的 QQ（v1 行为；v2 默认不再走这条路）
- [x] 下行：闸门落盘 `inbox\` → dsh 自动拉起会话 → `bridge_claim` → `bridge_complete`
- [x] 上行：`bridge_complete` 写 `outbox\<id>.json`（v2 全字段），闸门读取即得结果
- [x] v2 只落盘：离线自测断言「全程零上行」（dsh 一次 QQ 消息都不发）

## 待办
- [ ] 下行缓存接口（`/inbox`）与用户消息落盘
- [x] dsh 侧 cordis 插件
- [x] 端到端联调

## 降级备份
如果 dsh 发不了 HTTP，就全走文件：dsh 把结果写 `cache\outbox\`，闸门用 `future_task` 定时轮询后转述。延迟高但一定能通。

**v2 起这条「降级」就是默认路径**（文件通道唯一），HTTP 上行只在救火时用
（插件配置 `uplinkMode: 'on'`）。
