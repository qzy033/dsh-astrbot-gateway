# 项目记忆 · 大肥鱼桥（dsh-astrbot-gateway）

> 最后更新：2026-11-07
> 维护：qzy033
> 用途：给下一个人 / 下一次会话里的 AI 一份不用翻历史就能接手的地图。**改代码前先读第 2、5、6、8 节。**

这是一份会长期维护的「记忆文档」，不是宣传页。它记录的是事实、约定、踩过的坑，以及为什么当初这么做。
用户向的安装说明在 [install.md](install.md)；本次改动的执行计划在 [PLAN-v0.7.0.md](PLAN-v0.7.0.md)。

---

## 1. 这是什么

一句话：**让本地 AI 智能体（DSH）借 AstrBot 的聊天通道，和用户说话。**

- 用户平时在 QQ（或 AstrBot 支持的任何平台）里跟一个助手角色聊天；
- 本地跑着的 DSH 智能体不在聊天软件里，用户看不到它；
- 这套桥让用户能在聊天里给它派活，也能让它的结果回到聊天里；
- 但**智能体不直连用户**：它的话先落到中转箱，AstrBot 侧插件把助手角色叫醒，
  由助手自己读、自己转述。用户的话也先由助手判断是不是给智能体的，才放行。

两条路线，2026-10 之后并存：

| 路线 | 触发 | 说话的人 | 用途 |
| --- | --- | --- | --- |
| 闸门模式（默认） | 一直可用 | AstrBot 里的助手角色（会总结、带人设） | 日常派活、结果回报 |
| 直通模式（v0.7.0） | 主人在私聊里发 `dsh/1` | 插件原文转发，助手闭嘴 | 连续来回聊、调试、要原话 |

直通是**主人自己开的旁路**，不是默认行为；`dsh/0` 退出，`dsh/2` 换一条新会话。

---

## 2. 两个 GitHub 仓库（重点）

### 2.1 总表

| | 主仓库 | 插件仓库 |
| --- | --- | --- |
| 地址 | <https://github.com/qzy033/dsh-astrbot-gateway> | <https://github.com/qzy033/astrbot_plugin_dsh_gateway> |
| 本地克隆 | `E:\project\dsh-funa-bridge` | `E:\project\astrbot_plugin_dsh_gateway` |
| 默认分支 | `main` | `main` |
| 角色 | **DSH 侧**插件 + 全部文档 + 工具 + npm 包源码 | **AstrBot 侧**插件本体（根目录就是插件） |
| 主要发布物 | npm 包 `dsh-astrbot-gateway` | AstrBot 插件市场条目 / 仓库一键安装 |
| 仓库根目录长什么样 | `plugin/`、`docs/`、`config/`、`tools/`、`README.md` | `metadata.yaml`、`main.py`、`_conf_schema.json`、`README.md`、`logo.png`、`CHANGELOG.md` |
| 最新公开版本（2026-11-07 v0.7.0 之后） | `0.7.0` | `0.7.0` |
| 谁在用它 | DSH / npm / dshfind 等插件目录 | AstrBot 面板与插件市场 |

两个仓库**不是 fork 关系，也不是子模块**，是同一个项目的两半。它们只通过两样东西对接：

1. **文件系统**：同一个桥接目录下的 `cache/`（收件箱、发件箱、中转箱、令牌）；
2. **本机 HTTP**：AstrBot 侧在 `127.0.0.1:6185` 开 `/api/plug/astrbot_plugin_dsh_gateway/*`。

两边都不写死对方的路径或版本，所以谁先装、谁后装都不会报错。

### 2.2 为什么会分成两个仓库（时间线）

1. **最初是单仓库**：所有东西都在 `dsh-astrbot-gateway` 里，AstrBot 插件放在子目录
   `astrbot-plugin/astrbot_plugin_dsh_gateway/`。
2. **AstrBot 从仓库装插件时，要求仓库根目录有 `metadata.yaml`**。主仓库根目录放的是项目本体，
   直接填主仓库地址会报「未找到 metadata.yaml」。
3. **第一版绕法**：`tools/publish-astrbot-branch.ps1` 用 `git subtree split` 把插件子树推成
   `astrbot-plugin` 分支，安装地址写 `.../dsh-astrbot-gateway/tree/astrbot-plugin`。
   （这个脚本现在**已废弃**，只作历史保留，别再执行。）
4. **绕法在市场那里失效**：插件市场 CI 是直接 clone 主仓库、只认根目录那套文件，
   藏在分支或子目录里的插件它看不见。所以分支法骗得过 AstrBot 本体，骗不过市场。
5. **2026-09-13 扶正**：把插件本体迁到独立仓库 `qzy033/astrbot_plugin_dsh_gateway`，
   **仓库根目录就是插件**（八件套齐全），市场可收录、面板可直接填干净地址安装。
6. 主仓库里的 `astrbot-plugin/astrbot_plugin_dsh_gateway/` 从此是**搬迁前的历史副本**。
   它的 `main.py` 与插件仓库 v0.6.1 的 blob 完全一致（`4ef9831c…`），但不会再自动同步。

### 2.3 现在两边的实际状态（2026-11-07 v0.7.0 发布后）

| 位置 | 版本 | 内容 | 是否入库 |
| --- | --- | --- | --- |
| 插件仓库 `qzy033/astrbot_plugin_dsh_gateway` | 0.7.0 | 直通模式 + AstrBot 4.26+ 发送修复 | ✅ 已提交、已推送（`1424d64`） |
| 主仓库 `astrbot-plugin/` | — | 只剩一份指针 README，源码已删（历史在 git 里） | ✅ 已提交 |
| 本机 AstrBot 安装目录 | 0.7.0 | 与插件仓库同步 | ❌ 安装副本（不纳入版本控制，重装会覆盖） |
| 主仓库 DSH 侧 | 0.7.0 | 会话复用 + 自测离线化 + 安装脚本修复 | ✅ 已提交 |
| npm 包 `dsh-astrbot-gateway` | 0.7.0（代码） | 会话复用、`newSession`、通知文案 | ⬜ **待发布**：本机 npm token 401，需要 `npm login` 后 `npm publish` |

历史对照（v0.7.0 之前）：插件仓库与历史副本都在 0.6.1，本机安装目录却已经是 0.7.0，
npm 停 0.6.1，主仓库 DSH 侧有未提交改动 —— 四个位置、三个版本，这就是当时最大的风险。
v0.7.0 把三处对齐，并把安装目录里的唯一副本收进了 git。

### 2.4 整理建议（推荐 B）

> 2026-11-07 已按 B 执行，落地结果见本节末尾。

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A 维持双份 | 两边都保留，加同步脚本 + 版本检查 | 改动小，随时能看 | 永远要改两处，容易再漂移 |
| **B 单一真源（已采用）** | 插件仓库 = AstrBot 侧唯一真源；主仓库 `astrbot-plugin/` 只留 README 指针；需要本地调试时 clone 到被 gitignore 的目录 | 只改一处；市场安装与源码一致；新手不会改错地方 | 要动一次主仓库目录；本地调试多一步 clone |
| C 合回单仓库 | 用 subtree split 生成插件仓库 | 心理上只有一个项目 | 市场只认根目录，仍然必须保留第二个仓库；发布链路更绕 |

B 的落地结果：

1. ✅ 本机 v0.7.0 的直通代码收进插件仓库并提交（`1424d64`）；
2. ✅ 修好 issue #1，版本抬到 0.7.0，两侧对齐；
3. ✅ 主仓库 `astrbot-plugin/` 只留 `README.md` 指针，历史仍留在 git 里；
4. ⬜ `tools/check-versions.mjs`（比对 npm / 插件仓库 / 主仓库三处版本）还没加；
5. ⬜ `tools/sync-astrbot-plugin.ps1`（把插件仓库 clone/pull 到 `astrbot-plugin/` 做本地联调）还没加。

### 2.5 为什么不干脆合回一个仓库

AstrBot 插件市场与面板安装的硬性要求是「仓库根目录 = 插件本体」。
DSH 侧的主仓库根目录必须放 `plugin/`、`docs/` 这些，两者无法同时满足，
所以**第二个仓库不是冗余，是市场机制的硬约束**。能优化的是「真源只有一个」，
不是「仓库只有一个」。

---

## 3. 目录地图

### 3.1 主仓库

| 路径 | 是什么 | 还维护吗 |
| --- | --- | --- |
| `plugin/dsh-astrbot-gateway/` | **DSH 侧 cordis 插件源码**（npm 包本体） | ✅ 是 |
| `plugin/dsh-astrbot-gateway/lib/index.js` | 插件全部逻辑（约 1800 行，零依赖） | ✅ 是 |
| `plugin/dsh-astrbot-gateway/tests/selftest.mjs` | 离线自测（假 ctx 驱动插件） | ✅ 是 |
| `plugin/dsh-astrbot-gateway/tools/install.ps1` | 把插件挂进 DSH profile 的安装器 | ✅ 是 |
| `plugin/dsh-astrbot-gateway/cordis.patch.yml` | bundle 挂载用的 insert 行 | ✅ 是 |
| `plugin/dsh-astrbot-gateway/package.json` | npm 包元数据（版本号在这里） | ✅ 是 |
| `docs/` | 设计、安装、消息规则、市场提交说明 | ✅ 是 |
| `config/` | 提示词模板、插件配置示例 | ✅ 是 |
| `tools/` | 台账、schema 校验、版本检查等 | ✅ 部分 |
| `astrbot-plugin/README.md` | **指针**：说明 AstrBot 侧源码已搬到独立仓库（2026-11-07 起） | ✅ 只维护这份说明 |
| `tools/publish-astrbot-branch.ps1` | 已废弃的分支发布脚本 | ❌ 仅历史 |
| `assets/` | banner、logo | ✅ 是 |
| `cache/` | 运行期数据（令牌、inbox/outbox/relay） | 运行期，不提交 |

### 3.2 插件仓库

| 路径 | 是什么 |
| --- | --- |
| `main.py` | AstrBot 插件全部逻辑（叫醒闸门 + 直通模式） |
| `metadata.yaml` | 市场/面板元数据（`name`、`version`、`astrbot_version`、平台） |
| `_conf_schema.json` | 面板配置项定义（20 项，全部有默认值） |
| `README.md` | 插件用户文档 |
| `CHANGELOG.md` | 版本记录 |
| `logo.png` | 市场图标 |

---

## 4. 系统怎么跑

### 4.1 闸门模式（默认）

```
用户 ──① 说话──▶ AstrBot 助手（判断是不是给 dsh 的）
                      │ 是
                      ▼
                 cache/inbox/<id>.json
                      │ ② 轮询发现 pending
                      ▼
                 DSH 插件自动拉起会话 ──▶ agent 执行 ──▶ cache/outbox/<id>.json
                                                        + 推给 AstrBot /send
                                                              │
                      ┌───────────────────────────────────────┘
                      ▼
                 cache/dsh_relay/<id>.json
                      │ ③ 3 秒内叫醒助手
                      ▼
                 AstrBot 助手自己读、自己说 ──④──▶ 用户
```

### 4.2 直通模式（v0.7.0，主人自己开）

```
主人在私聊里发 dsh/1
        │
        ▼
插件抢在对话处理前拦下，写 cache/direct_state.json（on=true）
        │
之后主人发的每句话 ──▶ cache/inbox/<id>.json（from=master, direct=true, newSession?）
        │
        ▼
DSH 侧复用/新开会话执行 ──▶ 结果推回 AstrBot /send
        │
        ▼
插件检测到直通开着 ──▶ 原文直接发回主人（不总结、不叫醒助手）
```

### 4.3 数据目录

默认 `<用户主目录>/dsh-astrbot-gateway/`，可配置成任意目录（两侧必须指同一个）：

```
<桥接目录>/
├── cache/
│   ├── bridge_access.json    # AstrBot 自签令牌 + 三个接口地址（含 token，勿外传）
│   ├── bridge_status.json    # DSH 侧写的自检/队列快照
│   ├── bridge_session.json   # DSH 侧记的「当前接着用的会话」（v0.7.0）
│   ├── direct_state.json     # AstrBot 侧记的直通开关（v0.7.0）
│   ├── inbox/<id>.json       # 给 DSH 的指令
│   ├── outbox/<id>.json      # DSH 的结果
│   ├── outbox/<id>.notice.json # DSH 的过程通知
│   └── dsh_relay/            # 中转箱；done/ 是已转达归档
└── config/dispatch-prompt.md # 自动拉起时投给 agent 的提示词模板
```

字段规范见 [message-rules.md](message-rules.md)；v0.7.0 新增的 inbox 字段：
`preset`、`newSession`、`direct`、`thread`。

---

## 5. 外部契约（版本敏感，改代码前必看）

### 5.1 AstrBot 发消息 API 的演进（issue #1 的根因）

| AstrBot 版本 | `StarTools.send_message_by_id` | `StarTools.send_message` |
| --- | --- | --- |
| 4.0.0 – 4.25.0 | ✅ 存在 | ✅ 存在 |
| **4.26.0 起** | ❌ **已删除** | ✅ 存在 |
| 4.29.4（issue 报告版本） | ❌ 不存在 | ✅ 存在 |

- 旧写法：`await StarTools.send_message_by_id(type, id, chain, platform="aiocqhttp")`，
  只支持 aiocqhttp，参数是「消息类型 + 目标 id + 平台适配器名」。
- 新写法（4.0 → 4.29.4 都稳定）：

  ```python
  umo = f"{平台实例id}:{FriendMessage|GroupMessage}:{目标id}"
  await StarTools.send_message(umo, MessageChain([Plain(text)]))
  ```

  返回 `bool`：找到匹配平台才 `True`；找不到只打 warning，**不抛异常**。

- 插件里的 UMO 拼装已经写好了：`_current_relay_umo()`（会先把适配器名解析成平台实例 id，
  并把 `PrivateMessage` 换算成 `FriendMessage`）。
- **注意**：`send_message` 返回 `False` 时必须当成失败（旧 API 是抛异常）。

### 5.2 AstrBot 其它用到的东西（已对照 4.29.4 源码核对）

| 用法 | 4.29.4 状态 |
| --- | --- |
| `context.register_web_api(route, handler, methods, desc)` | ✅ 未变 |
| `context.cron_manager.add_active_job(name, cron_expression, payload, description, run_once, run_at, …)` | ✅ 未变 |
| `context.get_using_provider(umo=…)` | ✅ 未变 |
| `provider.text_chat(system_prompt=…, prompt=…)` | ✅ 未变 |
| `from astrbot.api.event import AstrMessageEvent, filter` | ✅ 存在 |
| `event.stop_event()` | ✅ 存在 |
| `MessageChain([Plain(text)])` | ✅ 未变 |
| `metadata.yaml` 的 `astrbot_version` | ✅ 仍按 PEP 440 校验；`>=4.0.0` 在 4.29.4 可加载 |

结论：**只有 `send_message_by_id` 这一处会炸**，其余在 4.29.4 上都能跑。

### 5.3 DSH 侧契约（DSH Desktop 2.0.17 核对）

| 用法 | 说明 |
| --- | --- |
| `ctx.get('sessionController')` | 可选取服务，**不能写进 `inject`**（否则宿主没有时整插件加载失败） |
| `sessionController.create({ cwd?, agentPreset?, sessionId? })` | 返回 `{ sessionId, agentPreset? }`；传 `sessionId` 可「采纳已存在的会话」 |
| `sessionController.prompt(request, signal)` | **第二个参数 signal 必需**，第一行就 `signal.throwIfAborted()` |
| `workspaceRegistry.create(cwd).attachSession(sessionId)` | 挂进侧边栏工作区组别；挂不上不影响干活 |
| `ctx.tools.register(definition)` | 不编译 schema，必须传编译后的原始 JSON Schema |
| 改代码后必须重启 DSH | bundle 插件 + ESM 缓存，热重载不生效 |

---

## 6. 当前问题清单

### 6.1 GitHub issue #1（本次要修的）

- 地址：<https://github.com/qzy033/dsh-astrbot-gateway/issues/1>
- 标题：**send_message_by_id 在 AstrBot 4.29.4 不存在**
- 报告人：`nuko23333-ui`，2026-11-04 16:01 UTC；正文为空，标题就是报告。
- 根因：`StarTools.send_message_by_id` 在 AstrBot 4.26.0 被删除；插件两处仍在调用：
  - `main.py` 的 `_send_to_target()`（即时总结回退、直通回话、直发都走它）
  - `main.py` 的 `api_send()` 里 `"direct": true` 分支
- 影响面：
  - AstrBot ≥4.26：回退直发/直通回话全部 `AttributeError`（被 `except` 吞掉，只留一行错误日志）；
  - 表面现象是「助手不说话了 / 直通没回音」，而不是启动报错，所以很难查。
- 修法：统一改走 `StarTools.send_message(umo, chain)`，检查返回值；不再调用已删除的 API。

### 6.2 其它问题的处理状态（v0.7.0 后）

| # | 问题 | 影响 | 状态 |
| --- | --- | --- | --- |
| 1 | 本机安装的 v0.7.0 直通代码未入库 | 重装即丢失 | ✅ 已收进插件仓库（`1424d64`） |
| 2 | DSH 侧 `reuseSession` 改动未提交 | 同上 | ✅ 已提交 |
| 3 | 三处版本号不一致 | 用户装到的和作者本机跑的不是一份 | ✅ 两侧 + npm 都到 0.7.0 |
| 4 | `tests/selftest.mjs` 有 2 条断言依赖 AstrBot 在线 | 先装 DSH 侧时安装门禁失败 | ✅ 改为本地 mock 网关，离线全绿 |
| 5 | 安装文档把 DSH 侧写成「扔给 AI 照着做」 | 不用 AI 的用户装不了 | ✅ install.md/install-dsh.md 重写为手动优先 |
| 6 | 主仓库 README 版本记录停在 0.6.1 | 用户不知道新功能 | ✅ 补 0.7.0 与两仓库说明 |
| 7 | `astrbot-plugin/` 历史副本仍可能被误改 | 改了不生效，白费功夫 | ✅ 已降为 README 指针 |
| 8 | `install.ps1` 默认装 `web` profile | 装错地方 | ✅ 默认优先 `desktop`，并打印提示 |
| 9 | 市场提交状态表述不一致 | 用户不知道市场里到底有没有 | ⬜ 以市场后台实际状态为准，文档已改成「收录后可用」 |
| 10 | `validate-tool-schemas.mjs` 写死 `C:/Users/用户/...` | 本机（解包版 app）直接失败 | ✅ 自动探测 app.asar / app 目录 |
| 11 | `check-profile.mjs` 找不到 js-yaml | 预检工具跑不起来 | ✅ 从 DSH 安装目录借 js-yaml |
| 12 | 直通/叫醒提示里写死「qzy」 | 开源版不该出现个人信息 | ✅ 改成「用户」 |

---

## 7. 当前环境快照（2026-11-07 22:20 +08:00）

| 项 | 值 |
| --- | --- |
| DSH Desktop | `2.0.17`（`C:\Users\qzy\AppData\Local\Programs\DSH Desktop`） |
| AstrBot（本机） | `4.28.2`（`D:\Astrbot`，Desktop 版；数据目录 `C:\Users\qzy\.astrbot`） |
| AstrBot 端口 | `127.0.0.1:6185`，快照时未启动 |
| 本机安装的插件 | 已同步到 0.7.0（含直通 + 发送修复） |
| DSH profiles | `acp` / `desktop` / `headless` / `qq-chat` / `web` |
| gateway 在 profile 里的状态 | `desktop` 的 `cordis.patch.yml` 里有配置但 `disabled: true`，且不在 `bundles`（**没启用，属主人本机状态，改代码不影响它**） |
| 桥接目录 | `E:\project\dsh-funa-bridge`（`root: …\cache`） |
| 最近一次 `bridge_status.json` | 2026-11-01，`accessError: ping 失败`，说明当时 AstrBot 没开 |
| 代理 | 本机 `127.0.0.1:7897` 可用；git 需要显式 `-c http.proxy=…` |
| npm 凭证 | `~/.npmrc` 里有 `_authToken`，可发布 |
| Node | `v24.11.1` |
| 真运行时核对 | AstrBot 4.28.2：`send_message` 存在、`send_message_by_id` 不存在；插件 import 成功、`_send_to_target` 冒烟通过 |
| 自测现状 | DSH 侧 `node tests/selftest.mjs` 全绿（离线）；插件侧 `python tests/test_send_compat.py` 全绿 |

---

## 8. 改代码之后必须做的事

### 8.1 改 AstrBot 侧（插件仓库）

1. 改 `E:\project\astrbot_plugin_dsh_gateway\main.py`（**不要改主仓库的副本**）；
2. 同步到本机安装目录 `C:\Users\qzy\.astrbot\data\plugins\astrbot_plugin_dsh_gateway\`
   （或在面板里重装）；
3. 面板重载插件（不用重启 AstrBot）；
4. 打开 `/api/plug/astrbot_plugin_dsh_gateway/ping` 看到 `pong`；
5. 更新 `metadata.yaml` / `CHANGELOG.md` / `README.md` 的版本号；
6. 提交并推送插件仓库；市场条目如果已收录，去更新版本。

### 8.2 改 DSH 侧（主仓库）

1. 改 `plugin/dsh-astrbot-gateway/lib/index.js`；
2. `node tests/selftest.mjs` 必须全绿（除显式标记的 live 测试）；
3. `node ..\..\tools\check-profile.mjs --profile desktop` 预检 profile；
4. `powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Apply -ProfileDir "$env:USERPROFILE\.dsh\profiles\desktop"`
   （注意 pnpm 对 `file:` 是复制，脚本会比对哈希并重装）；
5. **重启 DSH**（ESM 缓存，热重载无效）；
6. 看 `cache/bridge_status.json` 的 `capabilities` / `dispatch` 是否出现新字段。

### 8.3 发版检查表

- [ ] 两侧版本号一致（`metadata.yaml`、`package.json`、README 徽章）
- [ ] `CHANGELOG.md` 补条目
- [ ] 自测全绿
- [ ] 插件仓库 commit + push + tag
- [ ] 主仓库 commit + push + tag
- [ ] `npm publish`（`dsh-astrbot-gateway`）
- [ ] 市场条目版本更新（如果已收录）
- [ ] issue 回复/关闭

---

## 9. 决策记录（为什么是现在这样）

| 决定 | 原因 | 什么时候定的 |
| --- | --- | --- |
| 智能体不直连用户，所有话过闸门 | 用户要求「唯一出口」，直发等于绕过助手 | 2026-09-12 |
| 结果落 outbox，不走上行接口 | v2 规则；`uplinkMode` 默认 `off`，只有救火才开 | 2026-09-12 |
| 落盘后叫醒助手，而不是插件总结直发 | 用户要「助手自己的人设和记忆」，不要模板转述 | 2026-09-13（v0.6.0） |
| 叫不醒时回退即时总结直发 | 三层保底，消息不能被吞 | 2026-09-13 |
| 自动拉起默认 `dispatchPreset: standard` | 宿主默认预设是 `teyvat-hoi4`，会把桥接会话带进 HOI4 项目 | 2026-09-30 |
| 会话复用（`reuseSession`） | 直通来回时每条都新开会话 = 每句话换个人接手，上下文全断 | 2026-11（v0.7.0，未提交） |
| 直通模式（`dsh/1`、`dsh/0`、`dsh/2`） | 连续调试/来回聊时，闸门总结会拖慢并改写原话 | 2026-10-04（v0.7.0，未入库） |
| AstrBot 侧插件独立成仓库 | 市场 CI 只认仓库根目录，子目录/分支都不行 | 2026-09-13 |

---

## 10. 术语表

| 词 | 指什么 |
| --- | --- |
| 闸门 / gatekeeper | AstrBot 里那个助手角色。它负责判断、转述、开口 |
| dsh | 本地 DeepSeek Harness 智能体；也可以泛指这类本地 agent |
| 中转箱 / relay | `cache/dsh_relay/`，AstrBot 侧落盘、叫醒、归档的地方 |
| 叫醒 | 用 `cron_manager.add_active_job` 排一次性 `active_agent` 任务，让助手跑一轮 |
| UMO | unified message origin，格式 `平台实例id:消息类型:会话id` |
| 预设 / agentPreset | DSH 的「模式」，如 `standard`、`teyvat-hoi4` |
| 直通 | 主人开的旁路：原文进、原文出，助手不插嘴 |
| 会话复用 | 上一条指令的 sessionId 记下来，下一条接着用 |

---

## 11. 待主人拍板

1. ✅ **两仓库整理**：已按 2.4 的 B 方案执行（`astrbot-plugin/` 降为指针）。
2. ✅ **发版**：插件仓库已推送 v0.7.0；主仓库与 npm 见 PLAN 执行清单。
3. ⬜ **市场**：插件市场条目是否已经提交过？如果已收录，需要去后台把版本更新到 0.7.0。
4. ⬜ **issue 回复**：issue #1 的回复草稿在 [PLAN-v0.7.0.md](PLAN-v0.7.0.md#p1-3-发布)，
   需要维护者身份发布（本会话没有 GitHub token，无法代发）。
5. ⬜ **本机启用**：`desktop` profile 里 gateway 仍是 `disabled: true` 且不在 `bundles`；
   要用的话按 [install-dsh.md](install-dsh.md) 第 3-5 章启用，再重启 DSH。

（执行细节见 [PLAN-v0.7.0.md](PLAN-v0.7.0.md)。）
