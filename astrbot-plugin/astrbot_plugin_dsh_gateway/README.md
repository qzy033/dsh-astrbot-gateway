# 大肥鱼桥 · AstrBot 侧

> 安装方式见仓库的 `docs/install-astrbot.md`：可以从仓库一键装、传 zip，也可以直接拷文件夹。

让 dsh（DeepSeek Harness 之类的本地 agent）通过本机 HTTP 接口，借用 AstrBot 里那个角色的通道，
把消息交给模型总结后用自然语言转达给你。AstrBot 这一侧是**唯一闸门**：agent 不再直连你的 QQ。

## 为什么需要它

AstrBot 的开放接口 `/api/v1/*` 需要 API Key；插件自带的 `/api/plug/*` 又受 Dashboard 登录鉴权保护。
本插件在加载时用 `dashboard.jwt_secret` 自签一枚长期有效的访问令牌，写进约定的访问文件，
agent 只要读文件、带上这个令牌，就能免配置地调用接口。

## 配置

装好后进插件配置页填两项，其余可留默认：

| 配置项 | 说明 |
| --- | --- |
| 桥接项目目录 | 存 `cache/` 和访问文件的目录，留空则用 `用户主目录/dsh-astrbot-gateway` |
| 转达目标账号 | 要转达给谁的账号；私聊就填 QQ 号，必填 |
| 消息类型 | `PrivateMessage` 私聊 / `GroupMessage` 群聊 |
| 平台适配器 | 一般保持 `aiocqhttp` |
| 收到立即总结转达 | 开着就是「一发消息一秒内转达」；关掉则只落中转箱等取件 |
| 转达前缀 | 默认 `[dsh]`，方便区分来源 |
| 事件流水目录 | `relay_events.jsonl` 的落点，留空用 AstrBot 标准插件数据目录 |

## 接口

基址：`http://127.0.0.1:6185/api/plug/astrbot_plugin_dsh_gateway`

### GET /ping
健康检查，返回 pong。

### POST /send
请求头：`Authorization: Bearer <token>`

```json
{
  "text": "要发送的文本",
  "target": "收件账号，可省略",
  "type": "PrivateMessage"
}
```

- `text` 必填。
- `target` / `type` 省略时用插件配置里的默认值。
- 落盘后立刻在后台叫一次模型总结并转达，接口本身不等模型，秒回。
- 想绕过闸门直发可以带 `"direct": true`，默认没人该用它。

### GET /relay
列出中转箱里还没转达出去的消息，排查用。

## 访问文件

插件加载时生成 `bridge_access.json`，内含 `base_url`、`token`、`ping_url`、`send_url`、`relay_url` 等，
写入两处：

1. `<AstrBot 数据目录>/bridge_access.json`
2. `<桥接项目目录>/cache/bridge_access.json`

dsh 那侧的插件只需要读第二个。

## 示例

```bash
curl -X POST http://127.0.0.1:6185/api/plug/astrbot_plugin_dsh_gateway/send ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer <token>" ^
  -d "{\"text\":\"[dsh] 任务完成啦\"}"
```

## 注意

- 令牌由 `dashboard.jwt_secret` 自签，改动 dashboard 密钥后需重载本插件以刷新。
- 接口仅供本机调用，别把端口暴露到公网。
- 消息以 AstrBot 里那个角色的账号发出，内容里带前缀方便区分来源。

## 配套

dsh 那一侧的 cordis 插件在本仓库的 `plugin/` 目录里，负责扫指令、拉起会话、把结果写进 outbox。
两侧的协议见 `docs/message-rules.md`。

## 配置项一览

| 键 | 作用 | 默认值 |
| --- | --- | --- |
| `project_dir` | 桥接项目目录，缓存区在它下面的 cache/ | 用户主目录/dsh-astrbot-gateway |
| `target_id` | 转达目标账号，留空只落盘不转达 | 空 |
| `target_type` | PrivateMessage 或 GroupMessage | PrivateMessage |
| `platform` | 用哪个平台发消息 | aiocqhttp |
| `instant_summary` | 收到就立刻总结转达 | true |
| `tag` | 转达内容前带的小标签 | [dsh] |
| `memory_dir` | 事件流水目录 | AstrBot 插件数据目录 |
| `source_label` | 中转记录里的来源标记 | dsh |
| `relay_dir_name` | 中转箱目录名 | dsh_relay |
| `relay_done_dir_name` | 转达成功后的子目录名 | done |
| `events_file_name` | 事件流水文件名 | relay_events.jsonl |
| `access_file_name` | 自签令牌写入的文件名，两边要一致 | bridge_access.json |
| `summary_prompt` | 总结用的系统提示词 | 内置通用版 |
