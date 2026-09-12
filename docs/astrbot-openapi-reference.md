# AstrBot 开放接口速查（桥接用）

## 服务
- WebUI 与 OpenAPI 同端口，Quart + Hypercorn。
- 监听：`0.0.0.0:6185`（本机走 `http://127.0.0.1:6185`）。
- 端口配置：`data\cmd_config.json` → `dashboard.port`（默认 6185，也可用环境变量 `DASHBOARD_PORT` / `ASTRBOT_DASHBOARD_PORT`）。
- 所有接口统一前缀：`/api`。

## 鉴权
- `/api/v1/*` 需要 API Key，四选一：
  - Header `X-API-Key: <key>`
  - Header `Authorization: Bearer <key>`
  - Header `Authorization: ApiKey <key>`
  - Query `?api_key=<key>` 或 `?key=<key>`
- 作用域 scopes：`chat` / `config` / `file` / `im`（也支持 `*`）。
- Key 存储：`data_v4.db` 的 `api_keys` 表。
- 哈希算法：`pbkdf2_hmac("sha256", key, b"astrbot_api_key", 100000).hex()`。
- 创建接口：`POST /api/apikey/create`，body `{"name": "...", "scopes": ["im"]}`（需 WebUI 登录）。
- 当前状态：`api_keys` 表为空，还没有创建任何 Key。

## 发消息接口（上行核心）
```
POST /api/v1/im/message        scope: im
Header: X-API-Key: <key>
Body:
{
  "umo": "<platform_id>:<MessageType>:<session_id>",
  "message": "纯文本内容"
}
```
- `message` 既可以是字符串，也可以是消息组件列表（图片等）。
- 成功返回 `Response.ok`，失败返回 `Response.error`。
- 解析逻辑来源：`dashboard/routes/open_api.py` 的 `send_message`。

## umo 格式
- 结构：`platform_id:message_type:session_id`
- 拆解来源：`core/platform/message_session.py` 的 `MessageSesion.from_str`。
- 本机平台 id 是 `闸门`，类型 aiocqhttp。
- 用户的私聊 umo：`<平台>:FriendMessage:<你的QQ号>`
- MessageType 取值示例：`FriendMessage` / `GroupMessage` / `OtherMessage`。

## 其它接口
| 接口 | 方法 | scope | 说明 |
| --- | --- | --- | --- |
| `/api/v1/im/bots` | GET | im | 返回 `{"bot_ids": ["闸门"]}` |
| `/api/v1/chat` | POST | chat | 走一次 AI 对话 |
| `/api/v1/chat/sessions` | GET | chat | 会话列表 |
| `/api/v1/configs` | GET | config | 配置列表 |
| `/api/v1/file` | POST/GET | file | 文件上传/下载 |
