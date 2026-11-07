# AstrBot 侧安装

AstrBot 侧插件叫「大肥鱼桥」，住在独立仓库
[`qzy033/astrbot_plugin_dsh_gateway`](https://github.com/qzy033/astrbot_plugin_dsh_gateway)。
**那个仓库的根目录就是插件本体**（`metadata.yaml`、`main.py`、`_conf_schema.json` 直接放在根下），
所以装的时候填干净地址即可，不用再带 `/tree/...`。

> 本项目有两半：本文是 AstrBot 侧；DSH 侧的安装见 [install-dsh.md](install-dsh.md)。
> 本仓库根目录的 `astrbot-plugin/` 从 2026-11-07 起只剩一份指针说明，**源码以独立仓库为准**。

## 三句话版

1. 面板装插件：插件市场搜 `astrbot_plugin_dsh_gateway`；搜不到就
   插件管理 → 安装插件 → 仓库地址填 `https://github.com/qzy033/astrbot_plugin_dsh_gateway`。
2. 配置页在「转达目标账号」里填你要转达给的 QQ 号（群聊填群号、类型改群聊）。
3. 桥接目录留空，它会和 DSH 侧默认目录自动对齐，不用手工填。

装完在浏览器打开 `http://127.0.0.1:6185/api/plug/astrbot_plugin_dsh_gateway/ping`，
看到 `pong` 就说明通道通了。

只装这一侧也很安全：DSH 那边还没装的时候，它就是个安静的本机接口，不报错也不刷屏。

## 装之前先确认

1. **AstrBot 4.0 – 4.29**（0.7.0 起兼容 4.26+；旧版 0.6.x 在 4.26+ 会因上游删接口而发不出消息）；
2. QQ 通道能正常发也能正常收；
3. 知道要转达给谁：私聊是 QQ 号，群聊是群号；
4. 你有面板权限，能改插件配置、能重载插件。

## 安装方式

### 方式一：插件市场

面板 → 插件管理 → 插件市场，搜 `astrbot_plugin_dsh_gateway`，点安装并启用。

### 方式二：从仓库一键装（市场还没收录时用）

面板 → 插件管理 → 安装插件 → 仓库地址填：

```
https://github.com/qzy033/astrbot_plugin_dsh_gateway
```

注意**不要带 `/tree/...` 后缀**、不要带 `.git`：AstrBot 只认仓库根目录那套文件，
而这个仓库的根目录就是插件本体。装完 AstrBot 会按 `metadata.yaml` 里的 `name`
把目录改名成 `astrbot_plugin_dsh_gateway`。

### 方式三：压缩包上传

把插件仓库根目录那套文件打成 zip，注意 zip 的**第一层就直接是** `metadata.yaml`、`main.py`、
`_conf_schema.json`、`README.md`，不要再套一层目录。
面板 → 插件管理 → 上传插件。

### 方式四：手动放

把插件仓库根目录那套文件放进 `AstrBot 数据目录/plugins/astrbot_plugin_dsh_gateway/`
（目录名用 `metadata.yaml` 里的 `name`），重启 AstrBot。

> AstrBot 数据目录：桌面版通常 `C:\Users\<用户名>\.astrbot`；源码版是安装目录下 `data/`。

### 历史说明：为什么以前要带 `/tree/astrbot-plugin`

早期两边放在同一个仓库，插件塞在 `astrbot-plugin/astrbot_plugin_dsh_gateway/` 子目录里。
AstrBot 从仓库装插件要求**仓库根目录**有 `metadata.yaml`，所以当时用
`tools/publish-astrbot-branch.ps1` 把子树 `git subtree split` 成 `astrbot-plugin` 分支，
安装地址写 `.../dsh-astrbot-gateway/tree/astrbot-plugin`。

这个绕法骗得过 AstrBot 本体，骗不过插件市场：市场 CI 直接 clone 主仓库、只认根目录。
所以 2026-09-13 把插件迁到了独立仓库，分支法不再需要，那个脚本也只作历史保留。

## 装完必须填的配置

面板 → 插件管理 → 大肥鱼桥 → 操作 → 插件配置：

| 配置项 | 填什么 | 默认 |
| --- | --- | --- |
| `target_id` 转达目标账号 | 私聊填 QQ 号；群聊填群号 | 空（必填） |
| `target_type` 消息类型 | `PrivateMessage` / `GroupMessage` | `PrivateMessage` |
| `project_dir` 桥接项目目录 | 两边共用的目录；留空 = `<用户主目录>/dsh-astrbot-gateway` | 空 |
| `platform` 平台适配器 | 一般是 `aiocqhttp` | `aiocqhttp` |
| `umo_platform` 平台实例 id | 平台那栏填适配器名时留空自动解析 | 空 |
| `wake_gatekeeper` 叫醒闸门 | 由助手自己开口转达 | 开 |
| `wake_delay_seconds` 叫醒延迟 | 建议 2–5 秒 | 3 |
| `instant_summary` 兜底总结 | 叫醒失败时即时总结直发 | 开 |
| `tag` 转达标签 | 转达内容前的小标签 | `[dsh]` |
| `memory_dir` 事件流水目录 | 留空 = AstrBot 插件数据目录 | 空 |
| `source_label` 来源标记 | 中转记录里的来源 | `dsh` |
| `relay_dir_name` | 中转箱目录名 | `dsh_relay` |
| `relay_done_dir_name` | 已转达子目录名 | `done` |
| `events_file_name` | 事件流水文件名 | `relay_events.jsonl` |
| `access_file_name` | 自签令牌文件名，两侧要一致 | `bridge_access.json` |
| `summary_prompt` | 兜底总结用的系统提示词 | 内置通用版 |
| `direct_enter_cmd` | 进直通的私聊指令 | `dsh/1` |
| `direct_exit_cmd` | 退直通的私聊指令 | `dsh/0` |
| `direct_new_cmd` | 直通里换新会话的指令 | `dsh/2` |
| `direct_echo` | 每条投递回一句「已直送」回执 | 关 |

其余配置一般不用动。配置存在 `data/config/astrbot_plugin_dsh_gateway_config.json`。

## 直通模式

装好即带，默认关闭，不用额外配置：

| 指令 | 作用 |
| --- | --- |
| `dsh/1` | 进直通：主人的话原文直送 DSH，回话原文转回，不叫醒助手、不做总结 |
| `dsh/0` | 退直通 |
| `dsh/2` | 换一条新 DSH 会话（直通仍开着） |

三条指令只在私聊里认、只认 `target_id`；状态落 `cache/direct_state.json`，重启不丢。
DSH 侧需要 0.7.0+ 才认 `newSession`（换会话用），旧版直通仍可用。

## 验证

1. 插件列表里出现「大肥鱼桥」并且是启用状态；
2. `GET /api/plug/astrbot_plugin_dsh_gateway/ping` 返回 `pong`，说明路由挂上了；
3. 项目目录下出现 `cache/bridge_access.json`，说明自签令牌写出来了；
4. 日志里有 `[dsh-gateway] 发送通道：StarTools.send_message(umo, chain)`，
   说明用的是 4.26+ 也有的接口；
5. 跟助手说一句给 DSH 的指令，比如「让 dsh 在桌面建一个 hello.txt」。DSH 侧也装好的话，
   干完之后你应该在几秒内收到助手的回报，并标明来自 DSH；`cache/dsh_relay/` 里那份中转件会被挪进 `done/`。

## 常见问题

| 现象 | 大概是什么事 | 怎么办 |
| --- | --- | --- |
| ping 显示未找到该路由 | 插件没启用，或目录名被改过 | 确认启用状态，重载一次 |
| 聊天里收不到任何转达 | 「转达目标账号」没填 | 填上，重载插件 |
| 日志写 `has no attribute 'send_message_by_id'` | AstrBot 4.26+ 删了旧接口，插件还是 0.6.x | 升到 0.7.0 |
| 日志写「宿主没找到匹配的平台」 | 平台名没对上 | `platform` 填适配器名；实例 id 不同就写进 `umo_platform` |
| 日志写 `Invalid session` | 会话串的消息类型不对 | 0.7.0 已内置换算，还出现就重载插件 |
| 收到了但语气像插件不像助手 | 闸门没被叫醒，回落到了即时总结直发 | 看 `wake_gatekeeper` 是否开着，日志里有叫醒结果 |
| 401 或 403 | 面板密钥改过，旧令牌失效 | 重载插件，重签 `bridge_access.json` |
| 直通发了没反应 | DSH 侧没跑 / inbox 没写进去 | 看 `cache/inbox/` 有没有新文件、DSH 日志里 `[dsh-gateway]` 那几行 |

想让助手别自动开口就关 `wake_gatekeeper`，想调叫醒快慢就改 `wake_delay_seconds`，建议二到五秒。

## 卸载

面板里点卸载即可；配置文件和数据目录默认保留，要一起删就在卸载对话框里勾上。

## 与 DSH 侧的关系

- 本插件负责「闸门」：判断、落盘、叫醒、转述、直通开关；
- DSH 侧插件负责「干活」：轮询 inbox、拉起会话、写 outbox；
- 两边只通过桥接目录和本机 HTTP 对接，**不写死对方的地址或版本**。

完整安装顺序与验收见 [install.md](install.md)。
