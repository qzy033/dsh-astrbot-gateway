# 用户指南：装什么、怎么装、怎么验

这份是给人看的。想直接扔给 AI 让它替你装，可以念 [install-dsh.md](install-dsh.md) 和 [install-astrbot.md](install-astrbot.md)。

## 一、这套东西是什么

本地跑着一个能干活的 AI 智能体，比如 DSH。它不在你的聊天软件里，你平时看不到它。
这套桥干的事就是：**让你在聊天里给它派活，也让它把干完的活讲给你听**。

- 你说话 → AstrBot 侧的助手判断是不是给它的 → 是就投进收件箱，交给 dsh；
- dsh 干完 → 把结果写回发件箱 → AstrBot 侧插件三秒内把助手叫醒 → 助手用自己的话讲给你听，并注明来自 dsh。

## 二、装完是什么效果

- 你在 QQ 里给 dsh 派活，例如「让 dsh 在桌面建一个 txt」，它会自己去干；
- 干完几秒内你会收到助手的一段话，语气是助手自己的，末尾标明来自 dsh，不是冷冰冰的机器回声；
- dsh 拿不到你的账号，也没有直发消息的能力，它的话一律经过助手这一道；
- 你闲聊、吐槽、说别的事，一句都不会外传给它。

## 三、装之前需要准备什么

| 需要什么 | 说明 |
| --- | --- |
| AstrBot 4.0 以上 | 已经能正常收发消息的实例，QQ 通道能发能收 |
| 一个接收方 | 私聊填你的 QQ 号，想发给群就填群号 |
| 面板权限 | 能进 AstrBot 面板改插件配置、重载插件 |
| 想装 dsh 侧的额外条件 | DSH 桌面端能启动，`node` 与 `pnpm` 可用，装插件时要能联网 |

## 四、两条路径

| 你想要的效果 | 装哪边 |
| --- | --- |
| 只让 dsh 有话说的时候能通过助手讲给你听 | 两边都要装，缺一边不闭环 |
| 先装一边看看，会不会报错 | 不会报错。任何一侧单独装都是安静状态，等另一边接上 |

## 五、五分钟装完

### 第 1 步：AstrBot 侧

1. 面板 → 插件管理 → 插件市场，搜 `astrbot_plugin_dsh_gateway` 装并启用；
   市场里还搜不到时，用插件管理 → 安装插件 → 仓库地址填 `https://github.com/qzy033/astrbot_plugin_dsh_gateway`，
   注意是干净地址，不带 `/tree/...` 后缀。
2. 配置页填「转达目标账号」：私聊填 QQ 号，群聊填群号并把消息类型改成群聊。
3. 「桥接项目目录」留空即可，它会和 dsh 侧的默认目录自动对齐。
4. 重载插件，然后浏览器打开 `http://127.0.0.1:6185/api/plug/astrbot_plugin_dsh_gateway/ping`，看到 `pong` 就算挂上了。
   端口以你面板的实际端口为准，插件日志里也会直接打出这个地址。

### 第 2 步：DSH 侧

推荐直接把 [install-dsh.md](install-dsh.md) 丢给帮你干活的 AI，照着做即可。手动版三步：

1. 插件包放进任意目录，路径别带中文和空格；
2. 在 profile 的 `package.json` 里登记 `dsh-astrbot-gateway`，然后在 profile 目录执行 `pnpm install`；
3. 在 profile 的 `cordis.patch.yml` 里写插件配置，重点是 `root`、`dispatchCwd`、`dispatchPromptFile` 三项指向你的桥接目录，然后重启 DSH。

### 第 3 步：自检三件套

| 看什么 | 正常的样子 |
| --- | --- |
| `GET .../api/plug/astrbot_plugin_dsh_gateway/ping` | 返回 `pong` |
| `<桥接目录>/cache/bridge_access.json` | 有 `base_url`、`token` 和三个接口地址，说明插件签好了令牌 |
| `<桥接目录>/cache/bridge_status.json` | `poller` 是定时器名不是 `none`，`autodispatch` 是 `true`，`uplinkMode` 是 `off` |

## 六、验收：真的通了吗

1. 在 QQ 里对助手说一句明确给 dsh 的指令，例如「让 dsh 在桌面建一个叫 hello 的 txt」；
2. 看 `<桥接目录>/cache/inbox/`，应该出现一条 JSON，`from` 是 `gateway`，`status` 先 `pending` 后 `running`；
3. 干完之后 `<桥接目录>/cache/outbox/` 出现同 id 的结果，`status` 是 `done`；
4. 同一时刻你应该已经在 QQ 里收到助手用它自己口吻写的回报，并标明来自 dsh；
5. `<桥接目录>/cache/dsh_relay/` 根目录应该是空的，对应文件被挪进了 `done/`。

一到两分钟没动静就翻下一节。

## 七、回报是怎么讲给你的

2026-09-13 起走「叫醒闸门」：

- 交付一落盘，AstrBot 侧插件立刻把它推进中转箱，并排一个一次性任务把助手叫醒，默认三秒；
- 醒来的是助手本人，它自己读中转件、用自己的话讲给你听，讲完把文件归档，插件全程不代替它发言；
- 叫不醒助手时插件会回退成即时总结直发，再失败还有每二十分钟一轮的兜底巡检，三层保底，消息不会被吞；
- 想让它别自动开口，把 `wake_gatekeeper` 关掉就回到旧的即时总结直发；想换叫醒的延迟，改 `wake_delay_seconds`，建议二到五秒；
- 助手的语气由它自己的人格设定决定，`summary_prompt` 只管兜底那条路。

## 八、常见问题排查

| 现象 | 大概是什么事 | 怎么办 |
| --- | --- | --- |
| 打开 ping 显示未找到该路由 | 插件没启用，或插件目录被改过名 | 面板确认插件是启用状态，重载一次 |
| 聊天里一直收不到东西 | 「转达目标账号」没填 | 填上，重载插件 |
| 日志写 `Invalid session` | 会话串的消息类型不对 | 0.6.0 已内置换算，还出现就重载插件 |
| 日志写 `cannot find platform for session` | 平台那一栏填成了平台实例 id | 填适配器名，或把实例 id 写进 `umo_platform` |
| 收到了，但语气像插件不像助手 | 闸门没被叫醒，回落到即时总结直发 | 检查 `wake_gatekeeper` 是否开着，日志里会写叫醒结果 |
| 令牌相关 401 或 403 | 面板密钥改过，旧令牌失效 | 重载插件，让它重签 `bridge_access.json` |
| dsh 收到指令但一直不干活 | 轮询被关，或会话没拉起来 | 看 `bridge_status.json` 的 `pollMs` 与 `autodispatch`，再看 dsh 日志里 `[dsh-gateway]` 那几行 |
| 一直显示 running | 会话被中断了 | 认领后超过 `runningTimeoutMs` 会被自动回收成 `failed`，等它回收或手工改状态 |

## 九、数据放在哪，能不能搬家

默认桥接目录是 `<用户主目录>/dsh-astrbot-gateway`，两边都留空时天然指向同一个地方。
缓存区 `cache/` 里就四样东西：

| 路径 | 作用 |
| --- | --- |
| `cache/inbox/` | 给 dsh 的指令，dsh 认领后回写状态 |
| `cache/outbox/` | dsh 的交付，闸门从这里读 |
| `cache/dsh_relay/` | 中转箱，插件推进来后叫醒闸门，处理后挪进 `done/` |
| `cache/bridge_access.json` | 自签令牌，含本机接口地址，别外传 |

想放到别处：AstrBot 侧填「桥接项目目录」，dsh 侧填 `root`，两边指同一个目录就行。
换目录后重载插件、重启 DSH，令牌会自动重签。

## 十、卸载与回滚

- AstrBot 侧：面板卸载插件即可，配置和日志默认保留，想一起删在卸载对话框里勾上；
- dsh 侧：profile 的 `bundles` 里去掉 `dsh-astrbot-gateway`，在 profile 目录执行 `pnpm remove dsh-astrbot-gateway`，删掉 `cordis.patch.yml` 里那段配置，重启 DSH；
- 只想回滚行为，不想卸载：把 `wake_gatekeeper` 关掉，立刻回到即时总结直发的旧行为，不用改代码。

## 十一、安全与隐私

- 智能体只能调本机 HTTP 接口，拿不到你的账号，也没有直发消息的通道；
- 令牌和缓存都在你自己电脑上，`cache/` 已在 .gitignore 里排除，切勿提交或外传；
- 接口只绑回环地址，不要把端口暴露到公网；
- 智能体在本机有文件读写和命令执行能力，等同于授权它操作这台电脑，请只在可信环境启用。
