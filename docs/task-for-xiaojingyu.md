# 给小鲸鱼的任务：dsh 端桥接插件

> ⚠️ 2026-09-12 起按**中转规则 v2**（`docs/message-rules.md`）执行，本卡已同步：
> 下面「一、上行」改成「只落盘、不直发 qzy」，「二、下行」的指令一律由 Funa 转达。
> 卡里保留原始任务描述，供追溯当时的需求。

## 背景
AstrBot 那边的 Funa（QQ 机器人）已经写好并装好插件 `astrbot_plugin_funa_bridge`，
它有一个本机 HTTP 接口可以借用 Funa 的账号发消息。v2 下**默认不用这条接口**
（它的收件人是 qzy 本人 = 绕过闸门），只保留为救火通道。

已归档的设计文档在 `E:\project\dsh-funa-bridge\docs\`（bridge-design.md、message-rules.md、astrbot-openapi-reference.md）。

## 你要做的两件事

### 一、上行（v2）：dsh → Funa（文件）
1. 完成任务后，把结果写成 `E:\project\dsh-funa-bridge\cache\outbox\<id>.json`。
2. 字段必须齐全：`id`、`from`(dsh)、`to`(funa)、`source`(xiaojingyu)、`time`、`type`(result)、
   `ref`、`status`(done/failed)、`summary`、`content`。
3. 不直发 qzy；即时告知也只能落盘（`outbox/<id>.notice.json`），由 Funa 取件转述。
4. 保留的 HTTP 上行（`bridge_access.json` 的 `send_url` + Bearer token）默认关闭
   （插件 `uplinkMode: 'off'`），只在桥接断掉需要救火时显式打开。

### 二、下行：接收 Funa 转达的指令
1. 监听目录 `E:\project\dsh-funa-bridge\cache\inbox\`。
2. Funa 会把筛选后的指令写成 JSON 文件放进来，格式：
   ```json
   {"id":"...","from":"funa","to":"dsh","time":"ISO8601","type":"task","content":"文本","status":"pending"}
   ```
3. 你取走任务后把 status 改成 `running`，执行完把结果写到 `outbox\<id>.json`。

## 注意
- 接口只监听本机 127.0.0.1，token 不要外传。
- token 由 AstrBot 启动时自签，长期有效；万一失效，重载 AstrBot 插件即可刷新。
- 别改 AstrBot 那边的插件，只做 dsh 这一侧。

## 完成后
把结果写进 `cache\outbox\<id>.json`（v2 全字段）即可，Funa 取件后会转述给 qzy。
