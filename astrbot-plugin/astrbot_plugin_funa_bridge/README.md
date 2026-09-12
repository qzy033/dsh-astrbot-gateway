# astrbot_plugin_funa_bridge

dsh 传话桥：让 dsh（DeepSeek Harness）通过本机 HTTP 接口借用 Funa 的通道，主动向 qzy 发送消息。

配合 `E:\project\dsh-funa-bridge` 项目使用。

## 为什么需要它
AstrBot 的开放接口 `/api/v1/*` 需要 API Key；插件自带的 `/api/plug/*` 又受 Dashboard 登录鉴权保护。
本插件在加载时用 `dashboard.jwt_secret` 自签一枚长期有效的访问令牌，写入约定的访问文件，
dsh 只要读文件、带上这个令牌，就能免配置地调用接口。

## 接口
基址：`http://127.0.0.1:6185/api/plug/astrbot_plugin_funa_bridge`

### GET /ping
健康检查，返回 pong。

### POST /send
请求头：`Authorization: Bearer <token>`

```json
{
  "text": "要发送的文本",
  "target": "3582167749",
  "type": "PrivateMessage"
}
```

- `text` 必填。
- `target` 默认 `3582167749`（qzy 的 QQ）。
- `type` 取 `PrivateMessage` 或 `GroupMessage`，默认 `PrivateMessage`。

## 访问文件
插件加载时会生成 `bridge_access.json`，内含 `base_url`、`token`、`send_url`、`ping_url` 等。
写入两处：
1. `C:\Users\qzy\.astrbot\data\bridge_access.json`
2. `E:\project\dsh-funa-bridge\cache\bridge_access.json`

dsh 只需要读第二个文件即可。

## 示例
```bash
# 读取令牌（示例）
curl -X POST http://127.0.0.1:6185/api/plug/astrbot_plugin_funa_bridge/send ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer <token>" ^
  -d "{\"text\":\"[小鲸鱼] 任务完成啦\"}"
```

## 注意
- 令牌由 `dashboard.jwt_secret` 自签，改动 dashboard 密钥后需重载本插件以刷新。
- 接口仅监听本机使用，请勿把端口暴露到公网。
- 消息以 Funa 的账号发出，内容里建议加 `[小鲸鱼]` 前缀区分来源。

## 后续扩展
- 下行缓存：监听 qzy 的消息并入队，提供 `GET /inbox` 让 dsh 拉取。
- 支持图片、文件等富消息。
