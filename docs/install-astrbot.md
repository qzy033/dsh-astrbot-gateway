# AstrBot 侧安装

## 三句话版

1. 面板装插件：插件市场里搜 `astrbot_plugin_dsh_gateway`；市场里还搜不到时，插件管理 → 安装插件 → 仓库地址填
   `https://github.com/qzy033/astrbot_plugin_dsh_gateway`（干净地址，不带 `/tree/...`）。
2. 配置页在「转达目标账号」里填你要转达给的 QQ 号。
3. 桥接目录留空，它会和 DSH 侧默认目录自动对齐，不用手工填。

装完在浏览器打开 `http://127.0.0.1:6185/api/plug/astrbot_plugin_dsh_gateway/ping`，看到 `pong` 就说明通道通了。

只装这一侧也很安全：dsh 那边还没装的时候，它就是个安静的本机接口，不报错也不刷屏，等 dsh 侧装好自己就接上了。

## 装之前先确认

1. AstrBot 版本 4.0 以上，QQ 通道能正常发也能正常收；
2. 知道要转达给谁：私聊是 QQ 号，群聊是群号；
3. 你有面板权限，能改插件配置、能重载插件。

下面是想自己改路径、或者手动装的人的详细版。

AstrBot 的插件就是一个文件夹，装好以后出现在 `data/plugins/` 下面。
**AstrBot 插件现在有自己的仓库**：<https://github.com/qzy033/astrbot_plugin_dsh_gateway>，
仓库**根目录就是插件本体**——`metadata.yaml`、`main.py`、`_conf_schema.json`、`README.md`、`logo.png` 直接放在根下。
本仓库（dsh-astrbot-gateway）根目录是 DSH 侧项目本体，`astrbot-plugin/` 下那份是搬迁前的历史副本，不再作为安装来源。

## 方式一：插件市场

面板 → 插件管理 → 插件市场，搜 `astrbot_plugin_dsh_gateway`，点安装并启用。

插件正在走市场收录流程；市场里暂时还搜不到就用方式二，装的是同一个仓库的同一份代码。

## 方式二：从仓库一键装

面板 → 插件管理 → 安装插件 → 仓库地址填：

```
https://github.com/qzy033/astrbot_plugin_dsh_gateway
```

注意**不要带 `/tree/...` 后缀**：AstrBot 和插件市场都只认仓库根目录那套文件，而这个仓库的根目录就是插件本体。
装完 AstrBot 会按 `metadata.yaml` 里的 `name` 把目录改名成 `astrbot_plugin_dsh_gateway`。

### 为什么以前要带 `/tree/astrbot-plugin`（历史说明，已废弃）

以前本仓库是「桥两边放一起」的结构：仓库根放 DSH 侧项目本体，AstrBot 插件塞在
`astrbot-plugin/astrbot_plugin_dsh_gateway/` 子目录里。AstrBot 从仓库装插件时会整包下载仓库，
再要求**仓库根目录**有 `metadata.yaml`，所以直接填本仓库地址会报「未找到 metadata.yaml」。
当时的绕法是 `tools/publish-astrbot-branch.ps1` 把插件子树 `git subtree split` 成一个
`astrbot-plugin` 分支，安装地址写成 `.../dsh-astrbot-gateway/tree/astrbot-plugin`。

这个绕法只能骗过 AstrBot 本体安装，骗不过插件市场的校验：市场 CI 是直接 clone 主仓库、
只认根目录那套文件，藏在分支里的插件它看不见。所以 2026-09-13 把插件本体迁到了独立仓库
`qzy033/astrbot_plugin_dsh_gateway`，根目录直接放 `metadata.yaml`，分支法不再需要；
那个发布脚本也只作历史保留，别再当发布流程用。

## 方式三：压缩包上传

把插件仓库根目录那套文件打成 zip，注意 zip 的**第一层就直接是** `metadata.yaml`、`main.py`、
`_conf_schema.json`、`README.md`，不要再套一层目录。
面板 → 插件管理 → 上传插件。

## 方式四：手动放

把插件仓库根目录那套文件放进 `data/plugins/astrbot_plugin_dsh_gateway/`（目录名用 `metadata.yaml` 里的 `name`），
重启 AstrBot。

## 装完必须填的配置

面板 → 插件管理 → 大肥鱼桥 → 配置，至少填两项：

| 配置项 | 填什么 |
| --- | --- |
| 桥接项目目录 `project_dir` | 两边共用的那个目录，缓存区 `cache/` 在它下面 |
| 转达目标账号 `target_id` | 消息要转达给谁，私聊就填 QQ 号 |

其余 14 项都有默认值，见插件 `README.md` 里的配置项一览。其中 wake_gatekeeper 与 wake_delay_seconds 决定要不要叫醒助手、隔几秒叫醒，默认开着、三秒，一般不用动。
配置存在 `data/config/astrbot_plugin_dsh_gateway_config.json`。

## 验证

1. 插件列表里出现「大肥鱼桥」并且是启用状态；
2. `GET /api/plug/astrbot_plugin_dsh_gateway/ping` 返回 `pong`，说明路由挂上了；
3. 项目目录下出现 `cache/bridge_access.json`，说明自签令牌写出来了；
4. 这时候跟助手说一句给 dsh 的指令，比如「让 dsh 在桌面建一个 hello.txt」。dsh 侧也装好的话，
   干完之后你应该在几秒内收到助手的回报，并标明来自 dsh；`cache/dsh_relay/` 里那份中转件会被挪进 `done/`。

## 常见问题

| 现象 | 大概是什么事 | 怎么办 |
| --- | --- | --- |
| ping 显示未找到该路由 | 插件没启用，或目录名被改过 | 面板确认启用状态，重载一次 |
| 聊天里收不到任何转达 | 「转达目标账号」没填 | 填上，重载插件 |
| 日志写 `Invalid session` | 会话串的消息类型不对 | 0.6.0 已内置换算，还出现就重载插件 |
| 日志写 `cannot find platform for session` | 平台那栏填成了平台实例 id | 填适配器名，或把实例 id 写进 `umo_platform` |
| 收到了但语气像插件不像助手 | 闸门没被叫醒，回落到了即时总结直发 | 看 `wake_gatekeeper` 是否开着，日志里有叫醒结果 |
| 401 或 403 | 面板密钥改过，旧令牌失效 | 重载插件，重签 `bridge_access.json` |

想让助手别自动开口就关 `wake_gatekeeper`，想调叫醒快慢就改 `wake_delay_seconds`，建议二到五秒。

## 卸载

面板里点卸载即可；配置文件和数据目录默认保留，要一起删就在卸载对话框里勾上。
