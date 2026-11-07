# 用户指南：从零装好大肥鱼桥

这份文档是给**人**看的，全程不需要 AI 代劳。照着每一步做，每步都写了「你应该看到什么」；
哪一步不对，直接翻到最后的[排错表](#十一排错表)。

> 只想先跑起来、不看原理：按「第三章 → 第四章 → 第五章」的顺序做，大约 10 分钟。

---

## 一、这套东西是什么

本地跑着一个能干活的 AI 智能体（DSH）。它不在你的聊天软件里，你平时看不到它。
这套桥干的事是：**让你在聊天里给它派活，也让它把干完的活讲给你听。**

- 你说话 → AstrBot 侧的助手判断是不是给它的 → 是就投进收件箱，交给 DSH；
- DSH 干完 → 把结果写回发件箱 → AstrBot 侧插件三秒内把助手叫醒 → 助手用自己的话讲给你听，并注明来自 DSH。

它由两半组成，分别住在两个仓库：

| 一半 | 仓库 | 装在哪 |
| --- | --- | --- |
| AstrBot 侧插件 | [`qzy033/astrbot_plugin_dsh_gateway`](https://github.com/qzy033/astrbot_plugin_dsh_gateway) | AstrBot 面板 → 插件管理 |
| DSH 侧插件 | [`qzy033/dsh-astrbot-gateway`](https://github.com/qzy033/dsh-astrbot-gateway) | DSH 的 profile |

两边只通过同一个桥接目录（里面的 `cache/`）和本机 HTTP 接口对接，**谁先装、谁后装都不会报错**。

---

## 二、装之前准备什么

| 需要什么 | 说明 | 怎么确认 |
| --- | --- | --- |
| AstrBot 4.0 – 4.29 | 已经能正常收发消息的实例 | 面板左下角/设置里看版本号 |
| 一个接收方 | 私聊填你的 QQ 号；发群里就填群号 | — |
| 面板权限 | 能装插件、改插件配置、重载插件 | 能进「插件管理」即可 |
| DSH 桌面端 | 能正常启动，能打开设置看到 profile | — |
| Node 与 pnpm | DSH 装插件靠 pnpm | 终端跑 `node -v`、`pnpm -v`，都有版本号 |
| 网络 | 装 npm 包和从 GitHub 装插件时要能上网 | 能打开 GitHub 即可 |

桥接目录默认是 `<用户主目录>/dsh-astrbot-gateway`（Windows 下即
`C:\Users\你的用户名\dsh-astrbot-gateway`）。两边都留空时天然指向同一个地方；
想放别处，两边填同一个路径即可。

---

## 三、第 1 步：装 AstrBot 侧

### 3.1 安装插件（四种方式，选一种）

**方式 A：插件市场（最省事）**

面板 → 插件管理 → 插件市场 → 搜 `astrbot_plugin_dsh_gateway` → 安装 → 启用。

**方式 B：从仓库地址装（市场搜不到时用）**

面板 → 插件管理 → 安装插件 → 仓库地址填：

```
https://github.com/qzy033/astrbot_plugin_dsh_gateway
```

注意是**干净地址**，不要带 `/tree/...`、不要带 `.git`。

**方式 C：上传 zip**

把插件仓库根目录那套文件打成 zip，注意 zip 的**第一层就直接是** `metadata.yaml`、`main.py`、
`_conf_schema.json`，不要再套一层目录。面板 → 插件管理 → 上传插件。

**方式 D：手动放**

把插件仓库根目录那套文件放进 `AstrBot 数据目录/plugins/astrbot_plugin_dsh_gateway/`
（目录名用 `metadata.yaml` 里的 `name`），重启 AstrBot。

> AstrBot 数据目录在哪：桌面版通常是 `C:\Users\你的用户名\.astrbot`；
> 源码/服务器版通常是 AstrBot 安装目录下的 `data/`。面板的「数据与日志」页也能看到路径。

### 3.2 填配置

面板 → 插件管理 → 大肥鱼桥 → 操作 → 插件配置，至少填两项：

| 配置项 | 填什么 | 不确定怎么办 |
| --- | --- | --- |
| 转达目标账号 `target_id` | 私聊填你的 QQ 号；群聊填群号 | 先填自己的 QQ 号 |
| 消息类型 `target_type` | 私聊 `PrivateMessage`；群聊 `GroupMessage` | 保持默认 |
| 桥接项目目录 `project_dir` | 留空即 `<用户主目录>/dsh-astrbot-gateway` | **建议先留空** |

其余配置都有默认值，不用动。四个直通配置（`direct_enter_cmd` 等）也保持默认即可。

保存后**重载插件**（面板插件卡片上的「重载」，或重启 AstrBot）。

### 3.3 自检

用浏览器打开（端口以你面板实际端口为准）：

```
http://127.0.0.1:6185/api/plug/astrbot_plugin_dsh_gateway/ping
```

**你应该看到**：`{"ok": true, "plugin": "astrbot_plugin_dsh_gateway", "message": "pong"}`

看不到 `pong` 的话，看面板日志里 `[dsh-gateway]` 开头的行，通常会直接写出原因和自检地址。

---

## 四、第 2 步：装 DSH 侧

### 4.1 找到你的 profile

DSH 的 profile 在：

```
%USERPROFILE%\.dsh\profiles\
```

Windows 下展开就是 `C:\Users\你的用户名\.dsh\profiles\`。
里面通常有 `web` 和 `desktop` 两个：

- **DSH 桌面端**用 `desktop`；
- **命令行 / Web 版**用 `web`。

不确定就打开 `desktop` 目录，看有没有 `package.json`。本章下面用
`<PROFILE_DIR>` 代指你选中的那个目录。

### 4.2 安装插件包（二选一）

**方式 A：从 npm 装（推荐）**

打开终端，进入 profile 目录：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add dsh-astrbot-gateway@0.7.0
```

**你应该看到**：`node_modules\dsh-astrbot-gateway\` 出现，`package.json` 的 `dependencies`
里多了 `"dsh-astrbot-gateway": "^0.7.0"`。

> 先确认 npm 上真的有这个版本：`npm view dsh-astrbot-gateway version`。
> 如果显示的还是旧版本（作者还没登录 npm 发布），用方式 B 从仓库源码装，功能一样。

**方式 B：用仓库里的安装脚本**

```powershell
cd E:\project\dsh-funa-bridge\plugin\dsh-astrbot-gateway
powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Apply `
  -ProfileDir "$env:USERPROFILE\.dsh\profiles\desktop"
```

脚本会做四件事：检查 profile 冲突 → 跑离线自测和工具 schema 校验 → 登记 `file:` 依赖 →
把 `dsh-astrbot-gateway` 加进 `dsh.profile.bundles`。改 `package.json` 前会自动备份。

不加 `-Apply` 是 dry-run，只打印将要做什么，推荐先跑一遍看看。

### 4.3 把插件挂进 profile

打开 `<PROFILE_DIR>\package.json`，确认两处：

```json
{
  "dependencies": {
    "dsh-astrbot-gateway": "^0.7.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-astrbot-gateway"
      ]
    }
  }
}
```

`bundles` 数组末尾必须有 `"dsh-astrbot-gateway"`，没有就手动加上，然后在该目录跑一次
`pnpm install`。

> 用方式 B 的脚本装的话，这一步脚本已经做了。

### 4.4 写插件配置

打开 `<PROFILE_DIR>\cordis.patch.yml`，在文件末尾加：

```yaml
- id: dsh-astrbot-gateway
  config:
    root: C:\Users\你的用户名\dsh-astrbot-gateway\cache
    autoDispatch: true
    dispatchCwd: C:\Users\你的用户名\dsh-astrbot-gateway
    dispatchPreset: standard
    dispatchPromptFile: C:\Users\你的用户名\dsh-astrbot-gateway\config\dispatch-prompt.md
    reuseSession: true
    uplinkMode: off
```

三个必须按你的实际路径改的地方：`root`、`dispatchCwd`、`dispatchPromptFile`。

**两条硬规矩**：

1. **不要写 `- insert:`**。这个包是 bundle 插件，进了 `bundles` 就已经被插入一次；
   再 `insert` 同一个 id，DSH 启动会报 `duplicate loader entry id "dsh-astrbot-gateway"`
   并进恢复模式。
2. **`config` 是整块替换**这个插件的配置，写了就写全你想生效的键；没写的键用默认值。

### 4.5 重启 DSH

关掉 DSH 再启动（不是最小化）。bundle 插件 + ESM 缓存，**必须重启**才会加载新代码和新配置。

**你应该看到**：DSH 正常进入主界面，没有进「恢复模式」；侧边栏会话列表正常。

---

## 五、第 3 步：自检与验收

### 5.1 四个检查点

| 看什么 | 正常的样子 |
| --- | --- |
| AstrBot ping | 浏览器返回 `pong` |
| `<桥接目录>\cache\bridge_access.json` | 有 `base_url`、`token`、三个接口地址 |
| `<桥接目录>\cache\bridge_status.json` | `poller` 不是 `none`；`dispatch.autoDispatch` 是 `true`；`dispatch.reuseSession` 是 `true` |
| DSH 日志 | 有 `[dsh-gateway]` 开头的启动行，没有 `FAILED` |

`bridge_status.json` 里的 `hint` 是给人看的：断的时候它会直接写「AstrBot 侧还没装好，
去面板装哪个插件、填哪一项」。

### 5.2 真实验收：派一条活

1. 在 QQ 里对助手说一句明确给 DSH 的指令，例如：
   「让 dsh 在桌面建一个叫 hello.txt 的文件，里面写 hello」；
2. 看 `<桥接目录>\cache\inbox\`：应该出现一条 JSON，`from` 是 `gateway`，`status` 先 `pending` 后 `running`；
3. 干完后 `<桥接目录>\cache\outbox\` 出现同 id 的结果，`status` 是 `done`；
4. 同一时刻你应该在 QQ 里收到助手用自己的话写的回报，并标明来自 DSH；
5. `<桥接目录>\cache\dsh_relay\` 根目录应该是空的，对应文件被挪进了 `done\`。

一到两分钟没动静，翻[排错表](#十一排错表)。

### 5.3 直通模式验收（可选）

在私聊里给助手账号发：

```
dsh/1
```

**你应该收到**：「直通已开，会话 direct-……」。之后你说的话会原文直送 DSH，
DSH 的回话原文转回，不再经过助手总结。发 `dsh/0` 退出，发 `dsh/2` 换一条新会话。

---

## 六、直通模式怎么用

平时每句话都要过闸门：助手先判断、再总结、再转述。要连着跟 DSH 来回聊时，可以把闸门暂时撤掉：

| 指令 | 作用 | 什么时候用 |
| --- | --- | --- |
| `dsh/1` | 进直通 | 要连续追问、要原话、要调试 |
| `dsh/0` | 退直通 | 聊完回到正常模式 |
| `dsh/2` | 换一条新会话 | 上一段聊脏了，想重新开始 |

- 只在私聊里认、只认插件配置里的 `target_id`；
- 三条指令会被插件拦下，不会落进对话，也不会被当成任务投给 DSH；
- 开关状态写在 `cache/direct_state.json`，AstrBot 重启也认得；
- 直通期间助手不插嘴、不总结，消息也不进对话上下文。

---

## 七、回报是怎么讲给你的

2026-09-13 起走「叫醒闸门」：

- 交付一落盘，AstrBot 侧插件立刻把它推进中转箱，并排一个一次性任务把助手叫醒，默认三秒；
- 醒来的是助手本人，它自己读中转件、用自己的话讲给你听，讲完把文件归档，插件全程不代替它发言；
- 叫不醒助手时插件会回退成即时总结直发，再失败还有每二十分钟一轮的兜底巡检，三层保底，消息不会被吞；
- 想让它别自动开口，把 `wake_gatekeeper` 关掉就回到旧的即时总结直发；想换叫醒的延迟，改 `wake_delay_seconds`，建议二到五秒；
- 助手的语气由它自己的人格设定决定，`summary_prompt` 只管兜底那条路。

---

## 八、数据放在哪，能不能搬家

默认桥接目录是 `<用户主目录>/dsh-astrbot-gateway`，缓存区 `cache/` 里有：

| 路径 | 作用 |
| --- | --- |
| `cache/inbox/` | 给 DSH 的指令，DSH 认领后回写状态 |
| `cache/outbox/` | DSH 的交付，闸门从这里读 |
| `cache/dsh_relay/` | 中转箱，插件推进来后叫醒闸门，处理后挪进 `done/` |
| `cache/bridge_session.json` | DSH 侧记的「当前接着用的会话」 |
| `cache/direct_state.json` | AstrBot 侧记的直通开关 |
| `cache/bridge_access.json` | 自签令牌，含本机接口地址，别外传 |

想放到别处：AstrBot 侧填「桥接项目目录」，DSH 侧填 `root`，两边指同一个目录就行。
换目录后重载插件、重启 DSH，令牌会自动重签。

---

## 九、升级

**AstrBot 侧**：面板 → 插件管理 → 检查更新；或重新填仓库地址安装，再重载插件。
从 0.6.x 升到 0.7.0 不需要改配置（新增的直通配置都有默认值）。

**DSH 侧**：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add dsh-astrbot-gateway@latest
```

然后重启 DSH。`package.json` 里 `^0.7.0` 这种写法会跟随小版本，但不会跨大版本。

**两侧版本最好一致**：AstrBot 插件 0.7.0 配 DSH 插件 0.7.0，直通换会话才是完整的。

---

## 十、卸载与回滚

**AstrBot 侧**：面板 → 插件管理 → 卸载。配置和数据默认保留，想一起删在卸载对话框里勾上。

**DSH 侧**：

1. 从 `<PROFILE_DIR>/package.json` 的 `bundles` 里去掉 `dsh-astrbot-gateway`；
2. 在 `<PROFILE_DIR>` 执行 `pnpm remove dsh-astrbot-gateway`；
3. 删掉 `cordis.patch.yml` 里 `- id: dsh-astrbot-gateway` 那一段；
4. 重启 DSH。

**只想关掉某个行为，不想卸载**：

| 想关什么 | 改什么 |
| --- | --- |
| 不让助手自动开口 | AstrBot 配置 `wake_gatekeeper: false` |
| 不让 DSH 自动拉起会话 | DSH 配置 `autoDispatch: false`（退回只通知） |
| 不要会话复用 | DSH 配置 `reuseSession: false`（每条指令新开会话） |
| 不要直通 | 不用改配置，不发 `dsh/1` 就不会进 |

**DSH 恢复模式**：插件挂不上时 DSH 会自动回滚 profile，但回滚要跑 pnpm，**离线时连恢复都会失败**。
所以动 profile 之前先确认网络与 pnpm 都正常。万一进了恢复模式，手动把 `bundles` 和
`cordis.patch.yml` 里那段删掉，再启动。

---

## 十一、排错表

| 现象 | 大概是什么事 | 怎么办 |
| --- | --- | --- |
| 打开 ping 显示「未找到该路由」 | 插件没启用，或插件目录被改过名 | 面板确认插件是启用状态，重载一次 |
| 聊天里一直收不到东西 | 「转达目标账号」没填 | 填上，重载插件 |
| 日志写 `Invalid session` | 会话串的消息类型不对 | 0.7.0 已内置换算，还出现就重载插件 |
| 日志写 `cannot find platform for session` | 平台那一栏填成了平台实例 id | 填适配器名，或把实例 id 写进 `umo_platform` |
| 日志写 `has no attribute 'send_message_by_id'` | AstrBot 4.26+ 删了旧接口 | 升到本插件 0.7.0 |
| 日志写「宿主没找到匹配的平台」 | 平台名没对上 | 检查 `platform` 与 `umo_platform` |
| 收到了，但语气像插件不像助手 | 闸门没被叫醒，回落到即时总结直发 | 检查 `wake_gatekeeper` 是否开着，日志里会写叫醒结果 |
| 令牌相关 401 或 403 | 面板密钥改过，旧令牌失效 | 重载插件，让它重签 `bridge_access.json` |
| DSH 收到指令但一直不干活 | 轮询被关，或会话没拉起来 | 看 `bridge_status.json` 的 `pollMs` 与 `autodispatch`，再看 DSH 日志里 `[dsh-gateway]` 那几行 |
| DSH 启动报 `duplicate loader entry id` | profile 的 `cordis.patch.yml` 里写了 `- insert:` | 删掉 insert 行，改成 `- id: dsh-astrbot-gateway` 只覆盖 config |
| DSH 进了恢复模式 | 插件挂不上，自动回滚失败 | 手动删 `bundles` 与 patch 里那段，确认 pnpm 可用后重启 |
| 一直显示 running | 会话被中断了 | 认领后超过 `runningTimeoutMs` 会被自动回收成 `failed`，等它回收或手工改状态 |
| 桥接会话被 HOI4 预设接管 | 没设 `dispatchPreset` | 设成 `standard` |

更多按现象分类的排查见 [troubleshooting.md](troubleshooting.md)。

---

## 十二、安全与隐私

- 智能体只能调本机 HTTP 接口，拿不到你的账号，也没有直发消息的通道；
- 令牌和缓存都在你自己电脑上，`cache/` 已在 .gitignore 里排除，切勿提交或外传；
- 接口只绑回环地址，不要把端口暴露到公网；
- 智能体在本机有文件读写和命令执行能力，等同于授权它操作这台电脑，请只在可信环境启用。

---

## 十三、还想知道更多

| 想知道什么 | 看哪份 |
| --- | --- |
| 两个仓库为什么分开 | 仓库根目录 [README.md](../README.md#两个仓库) |
| 消息字段、直通规则 | [message-rules.md](message-rules.md) |
| 设计取舍 | [bridge-design.md](bridge-design.md) |
| AstrBot 侧细节 | [install-astrbot.md](install-astrbot.md) |
| DSH 侧细节 | [install-dsh.md](install-dsh.md) |
| 项目地图与维护手册 | [PROJECT-MEMORY.md](PROJECT-MEMORY.md) |
