# 桥接最终方案

> ⚠️ 2026-09-12 起改为**中转规则 v2（Funa 唯一闸门）**，见 `message-rules.md`。
> 本文件下面第一、二节里「dsh 直接给 qzy 发消息」的部分是 v1 的历史设计，已作废：
> v2 下 dsh **不再直发 qzy**，只把结果落 `cache/outbox/`，由 Funa 取件转述。

## 结论
用 AstrBot 插件做通道，两句话概括：

- **上行（dsh → Funa）**：dsh 把结果/通知写成本地文件 `cache/outbox/<id>.json`
  （v2 字段：source/ref/status/summary/content）。Funa 取件后用自己的话转述给 qzy。
- **下行（Funa → dsh）**：qzy 说的话先到 Funa，Funa 判断是指令才落盘
  `cache\inbox\<id>.json`，dsh 侧插件监听该目录读取。

另有本机 HTTP 通道（下面「插件」一节）：`http://127.0.0.1:6185/api/plug/astrbot_plugin_funa_bridge/send`
可借用 Funa 的账号发消息。**注意它的收件人是 qzy 本人**（私聊），所以 v2 下默认不用它
（插件 `uplinkMode` 默认 `off`），只在救火时显式打开。

## 插件：astrbot_plugin_funa_bridge
位置：`C:\Users\qzy\.astrbot\data\plugins\astrbot_plugin_funa_bridge`

- 路由：`/api/plug/astrbot_plugin_funa_bridge/ping`（GET）与 `/send`（POST）。
- 鉴权：插件加载时用 `dashboard.jwt_secret` 自签一枚无过期时间的 HS256 令牌，
  写入 `bridge_access.json`（AstrBot data 目录与 `E:\project\dsh-funa-bridge\cache\` 各一份）。
- 发送：内部用 `StarTools.send_message_by_id`，走 aiocqhttp 适配器。

## 上行调用样例
```http
POST http://127.0.0.1:6185/api/plug/astrbot_plugin_funa_bridge/send
Authorization: Bearer <bridge_access.token>
Content-Type: application/json

{"text": "[小鲸鱼] 任务完成啦：……"}
```

## 下行流程
1. qzy 在 QQ 私聊对 Funa 说指令。
2. Funa 判断是给 dsh 的任务，落盘为 `cache\inbox\<id>.json`：
   ```json
   {"id":"...","from":"funa","to":"dsh","time":"...","type":"task","content":"...","status":"pending"}
   ```
   （`from` 写 `funa`：v2 起 dsh 不直收 qzy 原文，收到的一律是 Funa 筛选后的版本。）
3. dsh 端 cordis 插件监听 `cache\inbox\`，取走任务并把状态改为 `running`。
4. dsh 完成后写 `cache\outbox\<id>.json`（v2 全字段），**不再用上行接口即时通知 qzy**。

## 消息 JSON 约定
```json
{
  "id": "uuid",
  "from": "funa | dsh",
  "to": "dsh | funa",
  "source": "xiaojingyu",
  "time": "ISO8601",
  "type": "task | result | notice | question",
  "content": "文本",
  "status": "pending | running | done | failed | notice",
  "ref": "关联的上一条 id"
}
```

v2 要点：
- `source` 标明信息来源、`status` 标当前状态，**缺一不可**（qzy 明确要求）。
- dsh 写的文件 `to` 恒为 `funa`；`to: "qzy"` 只可能出现在 v1 历史文件里。
- 巡检通知落在 `outbox\<id>.notice.json`（`type: "notice"`、`notice: true`）。

## 分工
- **Funa 端**：唯一闸门。下行负责筛选与落盘，上行负责取件（`outbox\`）并用自己的话转述给 qzy。
- **dsh 端**：cordis 插件；读 `bridge_access.json`、监听 inbox、把结果落 outbox。
  **不直发 qzy**（`uplinkMode` 默认 `off`，HTTP 通道仅在救火时开）。
- **qzy**：只需在 QQ 里跟 Funa 说话。

## 已验证
- [x] 插件已加载（13 → 14 个插件）
- [x] `/ping` 返回 pong
- [x] `/send` 成功发出一条测试消息到 qzy 的 QQ（v1 行为；v2 默认不再走这条路）
- [x] 下行：Funa 落盘 `inbox\` → dsh 自动拉起会话 → `bridge_claim` → `bridge_complete`
- [x] 上行：`bridge_complete` 写 `outbox\<id>.json`（v2 全字段），Funa 读取即得结果
- [x] v2 只落盘：离线自测断言「全程零上行」（dsh 一次 QQ 消息都不发）

## 待办
- [ ] 下行缓存接口（`/inbox`）与 qzy 消息落盘
- [x] dsh 侧 cordis 插件
- [x] 端到端联调

## 降级备份
如果 dsh 发不了 HTTP，就全走文件：dsh 把结果写 `cache\outbox\`，Funa 用 `future_task` 定时轮询后转述。延迟高但一定能通。

**v2 起这条「降级」就是默认路径**（文件通道唯一），HTTP 上行只在救火时用
（插件配置 `uplinkMode: 'on'`）。
