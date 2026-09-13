> 本目录是搬迁前的历史副本，装插件请去独立仓库 https://github.com/qzy033/astrbot_plugin_dsh_gateway 。
> 内容已与发布版 v0.6.1 保持同步，仅作离线查阅；有出入时以独立仓库为准。

<div align="center">

# astrbot_plugin_dsh_gateway

_✨ 大肥鱼桥 · AstrBot 侧 ✨_

[![License](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://www.python.org/)
[![AstrBot](https://img.shields.io/badge/AstrBot-4.0%2B-orange.svg)](https://github.com/Soulter/AstrBot)
[![Repo](https://img.shields.io/badge/%E4%BB%93%E5%BA%93-astrbot__plugin__dsh__gateway-blue)](https://github.com/qzy033/astrbot_plugin_dsh_gateway)

</div>

---

## 🤝 介绍

让本地 AI 智能体（dsh / DeepSeek Harness 这类）借你的 AstrBot 通道，把消息讲给你听。

智能体说的话不会直发到你的聊天窗口，而是先送到这一侧的**唯一闸门**：消息落盘后，插件立刻排一个一次性任务把 AstrBot 里那个助手角色叫醒，由它自己读中转件、用自己的话讲给你听，讲完归档。哪句话是给智能体的、哪句是闲聊，也由这一侧判断。

- 🔒 智能体拿不到你的账号，只能调本机 HTTP 接口
- ⚡ 收到消息三秒内叫醒助手，由助手本人开口；叫不动才回退到即时总结直发
- 🧠 助手说话时带着自己的人设和记忆，不是插件拿模板替你转述
- 🧩 只装这一侧也能跑，安安静静待着，不报错也不刷屏
- 🔗 与 dsh 侧插件 `dsh-astrbot-gateway` 配对使用，两侧各装各的

## 📦 安装

**方式一：从仓库一键装（现在就能用）**

AstrBot 面板 → 插件管理 → 安装插件 → 仓库地址填本仓库地址：

```
https://github.com/qzy033/astrbot_plugin_dsh_gateway
```

本仓库根目录就是插件本体（`metadata.yaml`、`main.py`、`_conf_schema.json` 直接放在根下），
所以填干净地址即可，**不要带 `/tree/...` 后缀**。装完 AstrBot 会按 `metadata.yaml` 里的 `name` 把目录改名成
`astrbot_plugin_dsh_gateway`。

**方式二：插件市场**

等本插件通过市场收录后，可以直接在 AstrBot 插件市场搜索 `astrbot_plugin_dsh_gateway`，点击安装并启用。
市场里暂时还搜不到就用方式一，装的是同一个仓库的同一份代码。

**方式三：手动**

把本目录放进 `AstrBot 数据目录/plugins/` 下，或者在面板的插件管理里上传本目录打成的 zip，然后按下面的「装完三步走」配置。

**装完三步走**

1. 打开插件配置，填「转达目标账号」：私聊填 QQ 号，群聊填群号。
2. 「桥接项目目录」可以留空，留空就用 `用户主目录/dsh-astrbot-gateway`；如果 dsh 侧已经指定过目录，这里填同一个就行。
3. 重载或重启 AstrBot 让配置生效，然后在本机浏览器打开下面这个地址自检：

```
http://127.0.0.1:6185/api/plug/astrbot_plugin_dsh_gateway/ping
```

看到 `pong` 就说明通道通了。端口以你 Dashboard 的实际端口为准，插件日志里也会直接打出这个自检地址。

> 还没装 dsh 侧插件也没关系：这一侧就是个安静的本机接口，装上不会报错，等 dsh 那侧装好自己就会接上。

## ⚙️ 配置

面板路径：插件管理 → astrbot_plugin_dsh_gateway → 操作 → 插件配置。

| 配置项 | 说明 | 默认值 |
| --- | --- | --- |
| project_dir | 桥接项目目录，缓存区 cache/ 就在它下面，dsh 侧要填同一个 | 用户主目录/dsh-astrbot-gateway |
| target_id | 转达目标账号，私聊填 QQ 号，群聊填群号 | 空 |
| target_type | PrivateMessage 私聊 / GroupMessage 群聊 | PrivateMessage |
| platform | 平台适配器 ID | aiocqhttp |
| wake_gatekeeper | 叫醒闸门，由助手自己开口转达 | 开 |
| wake_delay_seconds | 落盘后隔几秒叫醒助手，建议 2 到 5 | 3 |
| umo_platform | 会话串里的平台实例 id，留空自动解析 | 空 |
| instant_summary | 叫醒失败时的兜底：即时总结直发 | 开 |
| tag | 转达内容前的小标签 | [dsh] |
| memory_dir | 事件流水目录 | AstrBot 插件数据目录 |
| source_label | 中转记录里的来源标记 | dsh |
| relay_dir_name | 中转箱目录名 | dsh_relay |
| relay_done_dir_name | 已转达子目录名 | done |
| events_file_name | 事件流水文件名 | relay_events.jsonl |
| access_file_name | 自签令牌写入的文件名，两侧要一致 | bridge_access.json |
| summary_prompt | 总结用的系统提示词 | 留空用内置通用版 |

## ⌨️ 使用说明

基址：`http://127.0.0.1:6185/api/plug/astrbot_plugin_dsh_gateway`

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| /ping | GET | 健康检查，返回 pong |
| /send | POST | 把消息交给闸门，闸门被叫醒后自己转达 |
| /relay | GET | 查看中转箱里还没转达出去的消息 |

### POST /send

请求头：`Authorization: Bearer <token>`，令牌在访问文件里，不用自己配。

```json
{
  "text": "要发送的文本",
  "target": "收件账号，可省略",
  "type": "PrivateMessage",
  "direct": false
}
```

- `text` 必填；`target` 与 `type` 省略时用插件配置里的默认值。
- 接口本身不等模型，落盘即秒回；插件随后排一个一次性任务把助手叫醒，由它自己开口。
- `"direct": true` 会绕过闸门直发，默认没人该用它。

```bash
curl -X POST http://127.0.0.1:6185/api/plug/astrbot_plugin_dsh_gateway/send ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer <token>" ^
  -d "{\"text\":\"[dsh] 任务完成啦\"}"
```

## 🔍 排查

| 现象 | 大概原因和做法 |
| --- | --- |
| 打开 ping 显示「未找到该路由」 | 插件没启用，或者插件目录改过名。去面板确认插件是启用状态，重载一次 |
| send 返回 401 或 403 | 令牌过期或 Dashboard 密钥改过。重载本插件，让它重新签发访问文件 |
| 消息只落中转箱，没转达 | 「转达目标账号」没填。填上再重载 |
| 日志里写 Invalid session | 会话串的消息类型不对。0.6.0 已内置换算，若还出现请重载插件 |
| 日志里写 cannot find platform for session | 平台那一栏被填成了平台实例 id。填适配器名，或把实例 id 写进 umo_platform |
| 日志里没有自检地址 | 没读到 dashboard.jwt_secret。确认面板密码配置在，重载插件 |
| 想让智能体直发用户 | 不建议。真要救火就用 `direct: true` |

## 🧱 实现方式

AstrBot 的开放接口 `/api/v1/*` 需要 API Key，插件自带的 `/api/plug/*` 又受 Dashboard 登录鉴权保护。
本插件在加载时用 Dashboard 的 `jwt_secret` 自签一枚长期令牌，写进约定的访问文件：

1. `AstrBot 数据目录/bridge_access.json`
2. `桥接项目目录/cache/bridge_access.json`

dsh 侧只读第二份，带上令牌就能调接口。改过 Dashboard 密钥后，重载本插件即可刷新。

转达不走插件的模型调用，而是用 AstrBot 自带的定时任务管理器排一个 `active_agent` 一次性任务：
到点由框架把助手那个会话叫醒，唤醒词里写明读哪个中转文件、讲给谁、讲完归档。
助手是自己那一轮的说话人，插件全程不代替它发言。

## 📄 许可

MIT，详见仓库的 LICENSE。

## 📝 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。
