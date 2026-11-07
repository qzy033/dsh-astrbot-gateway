# v0.7.0 执行计划 · 修 AstrBot 4.29.4 适配 + 收编直通模式 + 文档改造

> 制定：2026-11-07
> 状态：**已执行（2026-11-07）** —— 结果与偏差见文末「执行记录」
> 配套记忆：[PROJECT-MEMORY.md](PROJECT-MEMORY.md)（项目地图、两仓库关系、环境快照）
> 目标仓库：主仓库 `qzy033/dsh-astrbot-gateway` + 插件仓库 `qzy033/astrbot_plugin_dsh_gateway`

---

## 0. 结论摘要

这次要做四件事，按优先级排：

| 优先级 | 事 | 一句话 |
| --- | --- | --- |
| **P0** | 修 issue #1 | `StarTools.send_message_by_id` 在 AstrBot 4.26+ 被删除，改成 `StarTools.send_message(umo, chain)` |
| **P0** | 收编 v0.7.0 | 本机安装目录里那版「直通模式」只在硬盘上，先备份、再收进插件仓库 |
| **P0** | DSH 侧收尾 | 把未提交的「会话复用」补齐版本号/文档/自测，和直通配套发 0.7.0 |
| **P1** | 文档改造 | README + 安装文档重写，做到「不用 AI 也能照着装」 |
| **P1** | 发布 | 两侧提交推送、npm 发布 0.7.0、回复 issue |
| **P2** | 整理 | 两仓库单一真源、版本对齐检查、CI 门禁 |

默认采用的整理方案是 **B（插件仓库为 AstrBot 侧唯一真源）**，理由和备选见
[PROJECT-MEMORY.md 第 2.4 节](PROJECT-MEMORY.md#24-整理建议推荐-b)。

---

## 1. 事实依据（已经核过，不是猜的）

### 1.1 issue

- <https://github.com/qzy033/dsh-astrbot-gateway/issues/1>
- 标题：`send_message_by_id 在 AstrBot 4.29.4 不存在`
- 报告人 `nuko23333-ui`，2026-11-04，正文为空。
- 状态：open，0 条评论。

### 1.2 AstrBot 版本证据（逐版本下载 `star_tools.py` 核对）

| 版本 | `send_message` | `send_message_by_id` |
| --- | --- | --- |
| v4.0.0 | ✅ | ✅ |
| v4.5.0 | ✅ | ✅ |
| v4.10.0 | ✅ | ✅ |
| v4.13.0 | ✅ | ✅ |
| v4.20.0 | ✅ | ✅ |
| v4.21.0 / v4.22.0 / v4.23.0 / v4.25.0 | ✅ | ✅ |
| **v4.26.0** | ✅ | ❌ **已删除** |
| v4.27.0 / v4.28.0 / v4.28.2 / v4.29.4 | ✅ | ❌ |

- 4.26.0 是分水岭；本机装的 AstrBot 是 4.28.2，**本来就已经会炸**，只是默认路径走叫醒闸门，
  没走到 `_send_to_target`，所以一直没暴露。
- 4.29.4 源码里搜不到任何 `send_message_by_id`。

### 1.3 4.29.4 其它相关接口（已核对，全部还在）

`Context.send_message` / `register_web_api` / `get_using_provider` /
`cron_manager.add_active_job`（签名一致）/ `provider.text_chat` /
`AstrMessageEvent` / `filter.event_message_type` / `event.stop_event()` / `MessageChain` / `Plain`。

→ 本次适配**只需要动发送这一处**。

### 1.4 代码里两处调用

插件仓库 `main.py`（v0.6.1）：

| 行 | 函数 | 用途 |
| --- | --- | --- |
| 268 | `_send_to_target()` | 即时总结回退、直通回话、直发 |
| 477 | `api_send()` 的 `direct: true` 分支 | 救火直发 |

本机安装目录 v0.7.0 里同样两处（行号 290 / 648），因为直通模式每条回话都走
`_send_to_target`，**所以在 4.26+ 上直通是全面失效的**，只是异常被 `except` 吞了。

### 1.5 未入库的东西

| 位置 | 内容 | 证据 |
| --- | --- | --- |
| `C:\Users\qzy\.astrbot\data\plugins\astrbot_plugin_dsh_gateway\` | v0.7.0 直通模式（main.py +202 行、schema +4 项、README +21 行） | 与插件仓库 `git diff` 差 202/24/21 行；`CHANGELOG` 未改 |
| 主仓库工作区 | 会话复用（`reuseSession` / `newSession`） | `git status` 3 个文件 M |

两者是**配套的一对**：AstrBot 侧直通写 `newSession: true`，DSH 侧 `reuseSession` 认这个字段。

---

## 2. 目标（Definition of Done）

1. AstrBot 4.0 → 4.29.4 全版本，`_send_to_target` 都能发出去，不再调用已删除 API；
2. 本机 v0.7.0 直通代码进入插件仓库并推送到 GitHub，`metadata.yaml` 版本 = `0.7.0`；
3. DSH 侧会话复用进入主仓库并推送，npm 发布 `0.7.0`；
4. 两侧版本号一致：`metadata.yaml` = `package.json` = npm = README 徽章 = `0.7.0`；
5. `node tests/selftest.mjs` 在**AstrBot 没启动**时也全绿（离线可装）；
6. 一个没用过 AI 的人，照 `README.md` → `docs/install.md` 能从零装好并自检通过；
7. issue #1 回复并说明修复版本；
8. 主仓库 `astrbot-plugin/` 不再被误认为可改的源码（降为指针或加显著说明）。

---

## 3. 任务分解

### P0-1 修 AstrBot 发送 API（issue #1）

**改哪里**：插件仓库 `main.py`（真源），改完同步本机安装目录。
不要改主仓库 `astrbot-plugin/` 副本（它按 B 方案会降为指针）。

**改法**：

1. 把 `_current_relay_umo()` 扩成可传目标/类型（直发分支要传自定义 target）：

   ```python
   def _current_relay_umo(self, target_id: str = "", msg_type: str = "") -> str:
       target = target_id or self.target_id
       if not target:
           return ""
       kind = UMO_MESSAGE_TYPE.get(msg_type or self.target_type, self.umo_type)
       return f"{self._resolve_umo_platform()}:{kind}:{target}"
   ```

2. `_send_to_target()` 改走 UMO：

   ```python
   async def _send_to_target(self, text: str, target: str = "", msg_type: str = "") -> bool:
       """主动发一条给用户。

       AstrBot 4.26 起删除了 StarTools.send_message_by_id（issue #1），
       统一用自 4.0.0 起就稳定的 StarTools.send_message(umo, chain)。
       返回 False 表示宿主没找到匹配平台（该接口不抛异常），同样按失败处理。
       """
       try:
           umo = self._current_relay_umo(target, msg_type)
           if not umo:
               logger.error("[dsh-gateway] 没有转达目标账号，发不出去")
               return False
           chain = MessageChain([Plain(text)])
           ok = await StarTools.send_message(umo, chain)
           if ok is False:
               logger.error(
                   f"[dsh-gateway] 转达用户失败：宿主没找到匹配的平台（umo={umo}）；"
                   "检查「平台」与「umo_platform」配置"
               )
               return False
           return True
       except Exception as exc:
           logger.error(f"[dsh-gateway] 转达用户失败: {exc}", exc_info=True)
           return False
   ```

3. `api_send()` 的 `direct: true` 分支删掉重复的 `send_message_by_id`，改调
   `self._send_to_target(text, target=target, msg_type=msg_type)`；失败返回 500。

4. 全仓搜索 `send_message_by_id`，确认 0 处残留（主仓库历史副本也一并同步/降级）。

5. 启动日志加一行能力自检（可选但推荐）：

   ```python
   logger.info(
       "[dsh-gateway] 发送通道：StarTools.send_message(umo) —— 兼容 AstrBot 4.0+，"
       "不依赖 4.26 已删除的 send_message_by_id"
   )
   ```

   不要尝试 `import` AstrBot 版本号做分支：`send_message` 从 4.0 就有，直接用即可，
   少一个版本判断就少一类线上分支。

**验收**：

- [ ] `grep -n "send_message_by_id" main.py` 无输出；
- [ ] `python -m py_compile main.py` 通过；
- [ ] 在 AstrBot 4.28.2（本机）上重载插件、ping 返回 pong；
- [ ] 用 `direct: true` 打一条 `/send`，能真的收到（或日志明确写出平台未匹配，而不是 AttributeError）；
- [ ] 用 4.29.4 的用户（issue 报告人）视角：升级后不再出现 `has no attribute 'send_message_by_id'`。

---

### P0-2 收编 v0.7.0 直通模式

**第一步：先备份，别先动**

```powershell
$src = "$env:USERPROFILE\.astrbot\data\plugins\astrbot_plugin_dsh_gateway"
$dst = "E:\project\dsh-funa-bridge\_private\backup-astrbot-plugin-0.7.0-20261107"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$src\*" $dst -Recurse -Force
```

`_private/` 已在 `.gitignore` 里，备份不会误提交。

**第二步：把 diff 收进插件仓库**

以安装目录为准，覆盖插件仓库这三个文件：

- `main.py`（+202 行：直通模式）
- `_conf_schema.json`（+4 项：`direct_enter_cmd` / `direct_exit_cmd` / `direct_new_cmd` / `direct_echo`）
- `README.md`（+21 行：直通章节）

然后**在插件仓库的这份新 main.py 上**做 P0-1 的发送修复（不要在安装目录改，
否则下次重装又丢）。

**第三步：补版本与变更记录**

- `@register(..., "0.7.0", ...)`：`0.6.1` → `0.7.0`
- `metadata.yaml`：`version: 0.7.0`；`desc` 补一句直通；`short_desc` 可保留
- `CHANGELOG.md` 新增 v0.7.0 条目：

  ```markdown
  ## v0.7.0 · 2026-11-07

  - 新增直通模式：私聊发 dsh/1 后，主人的话原文直送 dsh，dsh 的回话原文转回，
    不叫醒闸门、不做总结；dsh/0 退出，dsh/2 换一条新会话。开关落 cache/direct_state.json。
  - 修复 AstrBot 4.26+ 兼容（issue #1）：send_message_by_id 已被上游删除，
    改走自 4.0 起稳定的 StarTools.send_message(umo, chain)；4.29.4 实测可用。
  - 直通回话、即时总结回退、direct 直发三条路径统一走同一个发送函数。
  ```

**第四步：同步回本机安装目录**

- 覆盖 `main.py` / `_conf_schema.json` / `README.md` / `metadata.yaml` / `CHANGELOG.md`；
- 删掉 `__pycache__/`，避免旧字节码混淆；
- 面板重载插件。

**验收**：

- [ ] 插件仓库 `main.py` 与安装目录 `main.py` 哈希一致；
- [ ] 面板配置页能看到 4 个直通配置项；
- [ ] 私聊发 `dsh/1` 收到「直通已开」；发一句话，DSH 侧 inbox 出现 `from: master` 的条目；
- [ ] 发 `dsh/0` 回到闸门模式。

---

### P0-3 DSH 侧收尾（会话复用）

**现状**：工作区 3 个文件已改，自测除「需 AstrBot 在线」两项外全绿。
核心逻辑已经写完，见 `lib/index.js` 的：

- `pathsFor()` 增加 `session: cache/bridge_session.json`
- `readBridgeSession()` / `writeBridgeSession()` / `createBridgeSession()` / `promptBridge()`
- `dispatchTask()`：`reuseSession && task.raw?.newSession !== true` 时复用
- 复用失败（会话被关/删）→ 新建一条重投一次
- `writeStatus()` 暴露 `reuseSession` 与当前 `session`
- 通知文案：接旧会话写「接着 `<id>` 处理」，新会话才写「已自动拉起会话」

**要补的**：

1. `package.json`：`0.6.1` → `0.7.0`；
2. `config/plugin.example.yml` 加 `reuseSession: true` 与说明；
3. `docs/message-rules.md` 补 `newSession` / `direct` / `thread` 三个 inbox 可选字段；
4. `plugin/dsh-astrbot-gateway/README.md` 的版本/功能说明补会话复用（已有一部分，核对措辞）；
5. 复核一个细节：复用会话时 `dispatchPreset` 若变了，旧会话不会换模式。
   建议在通知/日志里加一句「复用会话沿用原模式」，避免误解（可选）；
6. 复核 `newSession` 的语义：AstrBot 侧在 `dsh/1` 和 `dsh/2` 后的**第一条**才带
   `newSession: true`，之后不带 —— 与 DSH 侧「不带就复用」正好配对。

**验收**：

- [ ] `node tests/selftest.mjs` 全绿（含新增 11c 会话复用 4 条断言）；
- [ ] `package.json` 版本 0.7.0；
- [ ] 重启 DSH 后 `cache/bridge_status.json` 出现 `dispatch.reuseSession: true` 与 `dispatch.session`。

---

### P0-4 自测离线化（让「谁先装都行」成立）

**问题**：`tests/selftest.mjs` 第 433-441 行优先读取真实的
`cache/bridge_access.json`，第 555 行断言 `上行自检: OK`；AstrBot 没启动时必然失败。
`tools/install.ps1` 又把自测当安装门禁 → **先装 DSH 侧会被自己拦住**。

**改法（推荐：本地 mock 网关，真发 HTTP）**：

1. 在 `main()` 开头用 `node:http` 起一个临时服务：

   ```js
   import { createServer } from 'node:http'

   const seen = []
   const server = createServer((req, res) => {
     let body = ''
     req.on('data', (c) => { body += c })
     req.on('end', () => {
       seen.push({ url: req.url, auth: req.headers.authorization, body })
       const payload = req.url.endsWith('/ping')
         ? { ok: true, message: 'pong' }
         : { ok: true, relay: true, instant: true, id: 'mock' }
       res.writeHead(200, { 'content-type': 'application/json' })
       res.end(JSON.stringify(payload))
     })
   })
   await new Promise((r) => server.listen(0, '127.0.0.1', r))
   const base = `http://127.0.0.1:${server.address().port}`
   ```

2. 访问文件固定写成：

   ```js
   const access = {
     base_url: base,
     token: 'selftest-token',
     ping_url: `${base}/api/plug/astrbot_plugin_dsh_gateway/ping`,
     send_url: `${base}/api/plug/astrbot_plugin_dsh_gateway/send`,
     relay_url: `${base}/api/plug/astrbot_plugin_dsh_gateway/relay`,
     default_target: '',
   }
   ```

3. 删掉「读真实访问文件」的分支（真实环境联调是 `--live` 的事）。
4. 保留 `/send` 拦截断言（uplinkAttempts），但 ping 真打 mock。
5. `try/finally` 里 `server.close()`。
6. 顺带把 `install.ps1` 的门禁语义改成：自测失败就拒绝安装；AstrBot 没开不再是失败。
7. `docs/install.md` 里「先装哪边都行」的承诺就有了测试保障。

**验收**：

- [ ] 关掉 AstrBot，`node tests/selftest.mjs` 仍全绿；
- [ ] 打开 AstrBot，再跑一次仍全绿；
- [ ] `--live` 行为不变（真发）。

---

### P1-1 文档改造（不用 AI 也能装）

**原则**：

- **主 README 只做三件事**：是什么、两仓库怎么分、怎么装（最长 3 屏）；
- **install.md 是唯一完整手册**：从下载到验收到卸载，人话 + 可复制命令；
- 每一处「把文档丢给 AI」都改成「你也可以自己做，步骤如下」，AI 只是加速项；
- 所有路径给 Windows 示例，同时给 macOS/Linux 的对照；
- 不写真实 QQ 号、不写 token。

**文件清单与分工**：

| 文件 | 改成什么 |
| --- | --- |
| `README.md`（主仓库） | 顶部加「两个仓库」一张表；版本记录补 0.7.0；安装部分改成 3 步可复制命令；加「直通模式」简介；加文档导航 |
| `docs/install.md` | 重写成完整手册：准备 → AstrBot 侧 → DSH 侧 → 自检 → 验收 → 排错 → 数据/卸载；每步都有「你应该看到什么」 |
| `docs/install-astrbot.md` | 补 4.26+ 兼容说明、直通三条指令、17 项配置表；市场/仓库/zip/手动四种方式；排错表加 `send_message_by_id` 条目（历史） |
| `docs/install-dsh.md` | 改成「人类手动版」为主（profile 路径、package.json 两处、cordis.patch.yml 完整示例、pnpm install、重启、验证）；把「给 AI 的说明书」降为附录 |
| `plugin/dsh-astrbot-gateway/README.md` | 顶部加「本包属于哪个仓库、怎么装、在哪看安装文档」；版本 0.7.0；补 reuseSession |
| 插件仓库 `README.md` | 加「配套的 DSH 侧在另一个仓库」；安装方式；直通章节（已在 v0.7.0 草稿里）；排错加 4.26 兼容说明 |
| `docs/message-rules.md` | 补直通与 `newSession` 字段；补 v0.7.0 的直通数据流 |
| `docs/troubleshooting.md`（新建） | 把散落在各文档的排错表合并成一张，按现象查 |
| `docs/faq.md`（可选） | 「要不要公网」「会不会泄露聊天」「能不能微信群/Telegram」「和 dsh-bridge-next 有什么区别」 |

**install.md 的目标结构**：

1. 这套东西是什么（30 秒）
2. 装之前准备（AstrBot 版本、QQ 通道、一个接收号、面板权限、Node/pnpm）
3. 两条安装路线（全手动 / 让 AI 代劳，后者只是附录）
4. 第 1 步：AstrBot 侧（市场 / 仓库 / zip / 手动，四选一）
5. 第 2 步：填配置（表格：哪项、填什么、不确定怎么办）
6. 第 3 步：DSH 侧（profile 怎么找、package.json 两处、patch 完整示例、pnpm install）
7. 第 4 步：重启与自检（4 个检查点）
8. 第 5 步：真实验收（派一条活，看 5 个地方）
9. 直通模式怎么用（dsh/1、dsh/0、dsh/2）
10. 排错表（现象 → 原因 → 做法）
11. 数据在哪、怎么搬家
12. 卸载与回滚
13. 安全边界

**验收**：

- [ ] 找一个没装过的人（或自己按文档在干净目录走一遍），不提问能装完；
- [ ] 文档里所有命令可直接复制，Windows 路径正确；
- [ ] 没有「照着问 AI」这类前置依赖；
- [ ] 每个链接都能打开（相对路径正确）。

---

### P1-2 版本与发布物对齐

| 位置 | 改成 |
| --- | --- |
| 插件仓库 `metadata.yaml` | `version: 0.7.0` |
| 插件仓库 `main.py` `@register` | `0.7.0` |
| 插件仓库 `CHANGELOG.md` | 新增 v0.7.0 |
| 主仓库 `plugin/dsh-astrbot-gateway/package.json` | `0.7.0` |
| 主仓库 `README.md` 版本表 + 徽章 | 0.7.0 |
| `docs/market-submit.md` | 版本 0.7.0、`astrbot_version` 仍 `>=4.0.0` |
| 插件仓库 `README.md` | 0.7.0 |

建议加一个 `tools/check-versions.mjs`（P2）自动比对，避免下次再漂。

---

### P1-3 发布

**前置**：本机代理 `127.0.0.1:7897`；git 直连会 reset，必须带代理参数。

```powershell
$env:GIT_PROXY = "http://127.0.0.1:7897"
```

1. **插件仓库**（`E:\project\astrbot_plugin_dsh_gateway`）：

   ```powershell
   git add -A
   git commit -m "feat: v0.7.0 直通模式 + 修复 AstrBot 4.26+ 发送接口（issue #1）"
   git tag v0.7.0
   git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push origin main --tags
   ```

2. **主仓库**（`E:\project\dsh-funa-bridge`）：

   ```powershell
   git add -A
   git commit -m "feat: v0.7.0 会话复用 + 文档重写（不靠 AI 也能装）"
   git tag v0.7.0
   git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push origin main --tags
   ```

3. **npm**：

   ```powershell
   cd plugin\dsh-astrbot-gateway
   npm publish --access public
   npm view dsh-astrbot-gateway version   # 应显示 0.7.0
   ```

   `~/.npmrc` 已有 `_authToken`；如果要求 OTP，需要主人给验证码。

4. **插件市场**：如果条目已收录，去后台把版本改成 0.7.0；如果还没提交，
   按 `docs/market-submit.md` 提交（分类选「三方集成」）。

5. **issue 回复**（草稿，主人用维护者身份发）：

   > 已确认：`StarTools.send_message_by_id` 在 AstrBot 4.26.0 被上游删除，
   > 4.29.4 里已经不存在。v0.7.0 起统一改走 `StarTools.send_message(umo, chain)`，
   > 4.0 到 4.29.4 都可用，不再依赖旧接口。
   > 升级方式：面板插件管理里更新到 0.7.0，或重新填仓库地址安装。
   > 如果还报错，麻烦贴一下 AstrBot 版本和日志里 `[dsh-gateway]` 那几行。

**验收**：

- [ ] GitHub 两个仓库的 `main` 都出现 v0.7.0 提交与 tag；
- [ ] npm 上是 0.7.0；
- [ ] issue 已回复（关闭与否看主人）；
- [ ] 从 GitHub 干净 clone 插件仓库，能在 4.28.2 上装上并 ping 通。

---

### P2 工程化与整理

1. `tools/check-versions.mjs`：比对三处版本（插件仓库 `metadata.yaml`、
   主仓库 `package.json`、npm `latest`），不一致退出码 1。
2. 主仓库 `astrbot-plugin/`：按 B 方案降为 `README.md` 指针：

   ```markdown
   # 这里不再放插件源码

   AstrBot 侧插件已迁到独立仓库：
   https://github.com/qzy033/astrbot_plugin_dsh_gateway

   安装、修改、提 issue 都去那边。本目录只保留历史说明，避免改错地方。
   ```

   然后把子目录里的源码删除（历史仍在 git 里）。
3. 加 CI（可选）：
   - 主仓库 `.github/workflows/ci.yml`：`node tests/selftest.mjs` + `node tools/validate-tool-schemas.mjs`；
   - 插件仓库：`python -m py_compile main.py` + 检查版本号与 CHANGELOG 一致。
4. 清理 `__pycache__`、`*.pyc`（已在 .gitignore）。

---

## 4. 执行顺序（一次走完，不来回切）

```
0. 备份本机 v0.7.0 安装目录
1. 插件仓库：覆盖 v0.7.0 三文件 → 修 send API → 版本/CHANGELOG
2. 同步到本机安装目录 → 面板重载 → ping/直通自测
3. 主仓库：DSH 侧自测离线化 → 跑全绿 → 版本 0.7.0
4. 文档：README / install / plugin README / message-rules / troubleshooting
5. 本地验证：selftest、py_compile、check-profile
6. 提交 + 推送两个仓库 + tag
7. npm publish 0.7.0
8. 回复 issue，更新市场（如已收录）
9. 把本文件的「执行清单」勾完，PROJECT-MEMORY 的状态快照更新
```

第 6-8 步涉及外部不可逆操作（push / publish / 公开回复），执行前再确认一次。

---

## 5. 验收清单（总）

### 代码

- [ ] `grep -r "send_message_by_id"` 在两侧仓库均为 0 处（历史说明文字除外）
- [ ] `python -m py_compile main.py` 通过
- [ ] AstrBot 4.28.2 本机：ping / direct / 直通回话三条路径都通
- [ ] `node tests/selftest.mjs` 全绿（AstrBot 关闭时）
- [ ] `node tools/validate-tool-schemas.mjs` 通过
- [ ] `node tools/check-profile.mjs --profile desktop` 退出码 0

### 版本

- [ ] 插件仓库 `metadata.yaml` = `0.7.0`
- [ ] `main.py` `@register` = `0.7.0`
- [ ] `package.json` = `0.7.0`
- [ ] npm `latest` = `0.7.0`
- [ ] 两个 README 的版本表/徽章 = `0.7.0`

### 文档

- [ ] 主 README 有「两个仓库」表
- [ ] install.md 从零到验收可独立完成
- [ ] 没有任何「必须让 AI 装」的前置
- [ ] 排错表覆盖 issue #1 的现象
- [ ] 相对链接全部有效

### 发布

- [ ] 两个仓库 push 成功、tag 存在
- [ ] npm 发布成功
- [ ] issue 已回复
- [ ] 市场版本已更新（如已收录）

---

## 6. 风险与回滚

| 风险 | 概率 | 影响 | 应对 |
| --- | --- | --- | --- |
| AstrBot 直通的 `event.stop_event()` 抢事件导致正常聊天被吞 | 中 | 用户私聊无回应 | 只在 `target_id` 匹配时拦截；直通关着时正常放行；回滚只需删插件重装 |
| 覆盖安装目录把 v0.7.0 弄丢 | 中 | 功能丢失 | 第 0 步先备份到 `_private/` |
| npm 发布后发现问题 | 中 | 用户装到坏版本 | 立即发 0.7.1 修复（npm 不允许覆盖同版本） |
| git 推送失败 | 中 | 版本没上去 | 带代理参数重试；确认凭据；先 push 插件仓库再主仓库 |
| 复用会话在 DSH 升级后失效 | 低 | 每条指令新开会话 | `reuseSession` 可关；prompt 失败会自动新建重投 |
| 文档改动过大引入错误 | 中 | 新手装不上 | 按文档在干净目录走一遍再提交 |

**回滚方式**：

- 插件：`git revert` + 面板重装上一版（`git checkout v0.6.1` 的文件）；
- DSH 侧：`reuseSession: false`（不用回滚代码）；或 `git checkout -- plugin/…`；
- npm：发补丁版本，不删包。

---

## 7. 执行清单（2026-11-07 实际结果）

- [x] 0 备份本机安装目录 → `_private/backup-astrbot-plugin-0.7.0-20261107/`
- [x] 1 插件仓库收编 v0.7.0 三文件（main.py / _conf_schema.json / README.md）
- [x] 2 修 `_send_to_target` / `api_send(direct)`：改走 `StarTools.send_message(umo)`
- [x] 3 插件仓库版本 0.7.0 + CHANGELOG + metadata
- [x] 4 同步本机安装目录（5 个文件哈希一致，删了 `__pycache__`）
- [x] 5 DSH 侧 selftest 离线化（本地 mock 网关，AstrBot 关着也全绿）
- [x] 6 DSH 侧版本 0.7.0 + 示例配置 + message-rules
- [x] 7 主 README / install / install-astrbot / install-dsh / plugin README 重写
- [x] 8 新建 troubleshooting.md
- [x] 9 本地全量验证：py_compile / send compat / selftest / schema / 真运行时冒烟
- [x] 10 两个仓库 commit + tag + push（插件仓库 `1424d64`、主仓库 `d75cba2`，两边都打了 `v0.7.0`）
- [ ] 11 npm publish 0.7.0 —— **被 npm 登录挡住**：`npm whoami` 返回 401，
       本机 `~/.npmrc` 里的 token 已失效。需要主人 `npm login` 后重跑
       `cd plugin\dsh-astrbot-gateway; npm publish --access public`
- [ ] 12 回复 issue #1（需要维护者 GitHub 凭据，本会话无 token；草稿见 P1-3）
- [x] 13 更新 PROJECT-MEMORY 状态快照
- [x] 14 主仓库 `astrbot-plugin/` 降为指针
- [ ] 15 check-versions.mjs + CI（P2，未做）

### 执行记录：计划外的发现与修复

| 发现 | 处理 |
| --- | --- |
| 安装目录 v0.7.0 的直通代码只在硬盘上 | 先备份再收进插件仓库，随 0.7.0 一起发布 |
| AstrBot 4.26 删除 `send_message_by_id`（4.25 还在） | 改走 `send_message(umo)`；逐版本核对过 4.0→4.29.4 |
| `install.ps1` 的重复 insert 检查把「按 id 覆盖配置」误判成重复 | 改成只在 `insert:` 块内匹配，并提示 `disabled: true` |
| `install.ps1` 默认装 `web` | 改成优先 `desktop`，打印选择结果 |
| `validate-tool-schemas.mjs` 写死 `C:/Users/用户/...` | 自动探测 `app.asar` / `resources/app`，支持 `--asar` |
| `check-profile.mjs` 找不到 js-yaml | 从 DSH 安装目录借；可用 `DSH_APP_DIR` 指定 |
| 叫醒提示里写死「qzy」 | 改成「用户」 |
| 自测依赖真实 AstrBot 在线 | 改为 `node:http` mock 网关，离线全绿 |
| 插件仓库没有任何测试 | 新增 `tests/test_send_compat.py`（假模块导入 + 6 类断言） |
| 计划文档里 `- insert:` 的配置示例是错的 | 全部改成 `- id:` + `config:`，并在三处文档写清为什么 |
| npm token 过期：`npm publish` 返回 404、`npm whoami` 返回 401 | 未能代发；文档已标注「以 `npm view` 为准，没到 0.7.0 就用源码方式装」 |

### 真运行时冒烟（本机 AstrBot 4.28.2）

```
StarTools.send_message: True
StarTools.send_message_by_id: False
插件 import OK
umo  private: 闸门:FriendMessage:12345
umo  group  : 闸门:GroupMessage:12345
_send_to_target -> True，实际调用 ('闸门:FriendMessage:12345', ['真实运行时冒烟'])
```

这是 issue #1 的直接反证：4.28.2 上旧接口确实不存在，新接口确实可用。

---

## 8. 给执行者（AI）的注意事项

1. **先备份再覆盖**，安装目录里的 v0.7.0 是唯一副本。
2. 插件仓库是 AstrBot 侧真源；主仓库 `astrbot-plugin/` 从 2026-11-07 起只剩 README 指针。
3. 改完 DSH 侧必须重启 DSH；改完 AstrBot 侧只需重载插件。
4. 不要提交 `cache/`、`_private/`、`*.jsonl`、任何 token。
5. 不要把真实 QQ 号、路径写进公开文档。
6. 推送/发布前确认代理：`-c http.proxy=http://127.0.0.1:7897`。
7. 任何一步失败，先更新本文件的执行清单与原因，再继续——不要留下「以为做了」的状态。
