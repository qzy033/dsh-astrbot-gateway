# 排错手册

按现象查。每条都写了「先看哪里」——大部分问题在那一步就能定位。

## 0. 三条命令先跑一遍

```powershell
# 1. AstrBot 通道通不通
curl.exe -s http://127.0.0.1:6185/api/plug/astrbot_plugin_dsh_gateway/ping

# 2. DSH 侧状态快照
type "$env:USERPROFILE\dsh-astrbot-gateway\cache\bridge_status.json"

# 3. 两端版本
#    AstrBot 面板看插件版本；DSH 侧看 profile/node_modules/dsh-astrbot-gateway/package.json
```

`bridge_status.json` 里的 `hint` 是给人看的一句话诊断：桥断的时候它会直接说
「AstrBot 侧还没装好，去面板装哪个插件、填哪一项」。

---

## 1. AstrBot 侧

### 1.1 打开 ping 显示「未找到该路由」

- 插件没启用 → 面板确认「大肥鱼桥」是启用状态，点重载；
- 插件目录被改名 → 目录名必须是 `astrbot_plugin_dsh_gateway`；
- 插件加载失败 → 看面板日志里 `[dsh-gateway]` 与 traceback。

### 1.2 ping 通，但聊天里收不到任何东西

- 「转达目标账号」没填 → 填 QQ 号，重载插件；
- 消息类型填错（群聊填了 `PrivateMessage`）→ 改成 `GroupMessage`；
- 助手的叫醒任务没排上 → 看日志有没有「已排好叫醒任务」；没有就检查 `cron_manager`。

### 1.3 日志写 `has no attribute 'send_message_by_id'`

AstrBot 4.26.0 起删除了 `StarTools.send_message_by_id`（issue #1）。

- 处理：把插件升到 **0.7.0**，它改走 `StarTools.send_message(umo, chain)`；
- 验证：重载后日志里应出现
  `[dsh-gateway] 发送通道：StarTools.send_message(umo, chain)`；
- 不需要降级 AstrBot。

### 1.4 日志写「宿主没找到匹配的平台」

说明 `umo` 里的平台段没对上任何平台实例。

- `platform` 填**适配器名**（如 `aiocqhttp`），不是实例名；
- 实例 id 和适配器名不一样时，把实例 id 写进 `umo_platform`；
- 怎么看实例 id：面板「平台」页，或日志里的 `cannot find platform for session`。

### 1.5 日志写 `Invalid session`

会话串的消息类型不对。0.7.0 会把 `PrivateMessage` 自动换算成 `FriendMessage`；
还出现就重载插件，确认跑的是新代码。

### 1.6 收到了，但语气像插件不像助手

说明闸门没被叫醒，回落到即时总结直发。

- 检查 `wake_gatekeeper` 是否开着；
- 看日志有没有「已排好叫醒任务 <job_id>」；
- 看 AstrBot 的定时任务页有没有 `dsh 取件 …` 的任务；
- 偶尔失败正常：三层保底会兜住，消息不会丢。

### 1.7 401 / 403

- Dashboard 密钥改过 → 重载插件，重签 `bridge_access.json`；
- 访问文件里的 token 与当前 `dashboard.jwt_secret` 不一致 → 同上；
- 确认 DSH 侧读的是同一个桥接目录。

### 1.8 直通发了没反应

- 私聊里发的是不是配置里的 `direct_enter_cmd`（默认 `dsh/1`）；
- 发送人是不是 `target_id` 那个账号；
- 看 `cache/direct_state.json` 的 `on` 是不是 `true`；
- 看 `cache/inbox/` 有没有新的 `direct-*.json`；
- DSH 侧没跑的话，文件会堆在 inbox 里等轮询。

---

## 2. DSH 侧

### 2.1 `bridge_status.json` 里 `hint` 说 AstrBot 连不上

- AstrBot 没启动 → 启动它；
- 端口不是 6185 → 改 AstrBot 面板端口后，重载插件会重签访问文件；
- 插件没装/没启用 → 回 AstrBot 侧装「大肥鱼桥」；
- 访问文件缺失 → 重载 AstrBot 插件。

### 2.2 `poller` 是 `none`

- `pollMs` 是 0 → 改成正数（默认 4000）；
- 宿主没有 `timer` 服务 → 看 DSH 版本，或日志里的 `[dsh-gateway]` 启动行。

### 2.3 指令一直 pending，没有被拉起

- `autoDispatch` 是不是 `false`；
- `dispatch` 是不是 `failed`：看 `bridge_status.json` 的 `error` / `hint`；
- 宿主没有 `sessionController` → `capabilities.dispatch` 会是 `lazy` 或 `failed`，
  看 DSH 是否把 `session-controller` 服务加载起来；
- 模型路由不可用 → 日志里会有 `session/model-unavailable`。

### 2.4 DSH 启动报 `duplicate loader entry id`

profile 的 `cordis.patch.yml` 里写了 `- insert: - id: dsh-astrbot-gateway`，
而这个包已经在 `dsh.profile.bundles` 里。

- 删掉 `insert` 那段，改成只按 id 覆盖 config：

  ```yaml
  - id: dsh-astrbot-gateway
    config:
      ...
  ```

### 2.5 DSH 进了恢复模式

插件挂不上时 DSH 自动回滚 profile，而回滚要跑 pnpm；离线时连恢复都会失败。

- 手动打开 `<PROFILE_DIR>/package.json`，从 `bundles` 里删掉 `dsh-astrbot-gateway`；
- 删掉 `cordis.patch.yml` 里 `- id: dsh-astrbot-gateway` 那段；
- 确认 `pnpm -v` 可用后重启。

### 2.6 改完代码没反应

- pnpm 对 `file:` 依赖是**复制**，不是软链：
  ```powershell
  cd plugin\dsh-astrbot-gateway
  powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Apply `
    -ProfileDir "$env:USERPROFILE\.dsh\profiles\desktop"
  ```
- 或者删掉 `node_modules\dsh-astrbot-gateway` 再 `pnpm install`；
- 最后**必须重启 DSH**（bundle 插件 + ESM 缓存）。

### 2.7 改完配置没反应

- profile patch 不会热重载（`hmr` 默认 disabled），重启 DSH；
- 确认 `- id:` 的 id 没写错；
- 看 `bridge_status.json` 里的 `dispatch` 块有没有新字段。

### 2.8 桥接会话被 HOI4 预设接管

- 没设 `dispatchPreset` → 设成 `standard`；
- 单条指令可以写 `preset` 覆盖；
- 重启后看 `dispatch.preset` 是不是 `standard`。

### 2.9 一直显示 running

- 会话被中断（DSH 重启、会话被停、agent 被杀）；
- 超过 `runningTimeoutMs`（默认 30 分钟）会被回收成 `failed`，并落一条失败结果；
- 也可以手工把 inbox 条目改成 `failed`。

### 2.10 直通里 `dsh/2` 没换会话

- DSH 侧插件低于 0.7.0，不认 `newSession`；
- 升级：`pnpm add dsh-astrbot-gateway@0.7.0`，重启 DSH。

---

## 3. 日志在哪

| 端 | 位置 |
| --- | --- |
| AstrBot | 面板「日志」页；或 `AstrBot 数据目录/logs/` |
| AstrBot 插件事件流水 | `AstrBot 数据目录/plugin_data/astrbot_plugin_dsh_gateway/relay_events.jsonl` |
| DSH | DSH 界面日志面板；或启动它的终端 |

两边日志都认 `[dsh-gateway]` 前缀，先 grep 这个再看别的。

---

## 4. 数据/状态文件对照

| 文件 | 谁写 | 看它判断什么 |
| --- | --- | --- |
| `cache/bridge_access.json` | AstrBot | 接口地址与令牌是否签好 |
| `cache/bridge_status.json` | DSH | 轮询、自动拉起、会话复用、能力自检 |
| `cache/bridge_session.json` | DSH | 当前接着用的会话 id |
| `cache/direct_state.json` | AstrBot | 直通开没开、当前会话号 |
| `cache/inbox/*.json` | AstrBot / 直通 | 有没有待处理指令 |
| `cache/outbox/*.json` | DSH | 结果有没有写出来 |
| `cache/outbox/*.notice.json` | DSH | 收到/拉起/拉起失败的中间状态 |
| `cache/dsh_relay/*.json` | AstrBot | 中转箱里还有没有没转达的 |

---

## 5. 还不行怎么办

提 issue 时请带上：

1. AstrBot 版本、DSH 版本、两侧插件版本；
2. `bridge_status.json` 全文（**先把 token 删掉**）；
3. 两侧日志里 `[dsh-gateway]` 相关的行；
4. 复现步骤：发了什么指令、预期什么、实际什么。

- AstrBot 侧问题：<https://github.com/qzy033/astrbot_plugin_dsh_gateway/issues>
- DSH 侧问题：<https://github.com/qzy033/dsh-astrbot-gateway/issues>
