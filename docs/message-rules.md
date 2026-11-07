# 中转规则 v2（唯一闸门版）

用户于 2026-09-12 18:27 下达新规则：**所有消息必须经过闸门这一个 AI 中转，不许直连。**

## 通道定义

```
用户  ──说──▶  闸门（筛选/确认）  ──投放──▶  dsh（dsh）
用户  ◀──整理──  闸门  ◀──写回报文件──  dsh（dsh）
```

## 一、上行：用户 → 闸门 → dsh

1. 用户说的话先到闸门手里，闸门判断是不是"明确给dsh的指令"。
2. 只有确认是指令的，才写成 JSON 投进 `<项目目录>\cache\inbox\`。
3. 不是指令的（聊天、吐槽、闲聊、其他事）一律留在闸门这边，绝不外传。
4. 在犹豫时默认不转，等用户明确点名。

### inbox 条目的可选字段：`preset`（这条用哪种模式跑）

`cache/inbox/<id>.json` 除了 `id/from/to/time/type/content/status`，可以再加一个可选字段
**`preset`**（也认 `agentPreset`），指定「这条指令拉起的会话用哪个 agent 预设」：

```json
{"id":"...","from":"gateway","to":"dsh","time":"ISO8601","type":"task",
 "content":"文本","status":"pending","preset":"teyvat-hoi4"}
```

- **不写** → 用插件配置的 `dispatchPreset`（本机已设成 `standard`，即**标准模式**）。
- `"teyvat-hoi4"` → 提瓦特黎明 HOI4 模式（带项目 persona，强制每回合先读
  `E:\teyvatdaybreak\PROJECT_RULES.md` 与 SKILL 索引）。
- `"hoi4-mod"` → HOI4 通用开发模式（不绑定具体 MOD）。
- 写错（该预设不存在）→ **不会让指令失败**：插件记一行日志后回退到 `standard`。

**闸门的建议用法**：指令明显是 HOI4 MOD 开发（`.txt`/`.gfx`/`.yml`/`.mesh`、国策、图标、
兵模转换…）或明确点名提瓦特黎明项目时，加 `"preset":"teyvat-hoi4"`；其余一律不写（走标准模式）。
拿不准就不写 —— 标准模式一样能干活，只是没有项目专属 persona 与模板优先级约束。

### v0.7.0 新增的可选字段

| 字段 | 谁写 | 含义 |
| --- | --- | --- |
| `newSession` | AstrBot 侧直通模式 | `true` = 这一条另开一条新 DSH 会话；不写 = 接着上一条（`reuseSession`，默认开） |
| `direct` | AstrBot 侧直通模式 | `true` = 这条来自「直通」，是主人原文，不是闸门筛选后的转达；DSH 侧只做记录 |
| `thread` | AstrBot 侧直通模式 | 直通会话号，形如 `direct-20261107-221500-01`，用于把一问一答串起来 |

`newSession` 只在两种时机出现：主人发 `dsh/1` 后的第一条、以及发 `dsh/2` 后的第一条。
其余指令都不带它，DSH 侧就复用上一条会话（sessionId 记在 `cache/bridge_session.json`）。
复用来的会话若已被关掉，DSH 侧会新建一条重投一次，日志里留一行说明。

## 二、下行：dsh → 闸门 → 用户

1. dsh完成任务后，**不再通过上行接口直接给用户发消息**。
2. 它只把结果写成 `<项目目录>\cache\outbox\<id>.json`，字段必须齐全：
   ```json
   {
     "id": "任务ID",
     "from": "dsh",
     "to": "gateway",
     "source": "dsh",
     "time": "ISO8601",
     "type": "result",
     "ref": "对应的任务ID",
     "status": "done",
     "summary": "一句话摘要",
     "content": "完整内容"
   }
   ```
3. `source` 字段用来标明信息来源，`status` 标当前状态，缺一不可。
4. 闸门读取并处理后，用自己的话向用户汇报，并注明"来自dsh"。这份交付落盘后三秒内就会把闸门叫醒，属自动流程，不需要用户催。

## 三、闸门怎么把结果讲给用户（2026-09-13 起：叫醒闸门）

- dsh 把结果写进 `cache/outbox/` 后，AstrBot 侧插件立刻把这份交付推进中转箱 `cache/dsh_relay/`，
  并排一个一次性任务把闸门叫醒，默认延迟 3 秒。
- 醒来的是闸门本人：它自己读中转件，用自己的话讲给用户并注明"来自dsh"，讲完把文件挪进 `done/` 归档。
  插件全程不代替闸门发言，也不直发用户。
- 所以 dsh 的回报是秒级送达，不需要用户问一句、也不需要任何轮询；用户没说话时，
  只有真有新交付才会开口，不会凭空打扰。
- 叫不醒闸门时插件会回退到即时总结直发，再不行还有兜底取件，三层保底，消息不会被吞。
- 用户说"看看它回了没"之类的话时，闸门仍然可以随时去翻 outbox 和 done 目录。

## 四、dsh 侧怎么落实（实现记录，2026-09-12，2026-11-07 更新）

改的是 dsh 侧 cordis 插件 `plugin/dsh-astrbot-gateway`（宿主平面，改完需重启 dsh 生效）：

| 规则 | 落实方式 |
| --- | --- |
| ① 只收闸门筛选后的指令 | 正常情况下 inbox 条目的 `from` 是 `gateway`；直通模式下是 `master`（主人原文，见第五节） |
| ② 结果写 outbox、字段齐全 | `writeResultJson()` 统一产出 `id/from/to/source/time/type/ref/status/summary/content`；`to=gateway`、`source` 默认 `dsh`；`content` 必须是完整结果（超长会留一行显式说明，不静默截断） |
| ③ 交付落盘 + 推一份给闸门 | `deliver()` 先写 `outbox/<id>.json`（权威交付），再把摘要推到 AstrBot 的 `/send`；v0.6.0 起 `/send` 不再直发，而是落 `dsh_relay` 并叫醒助手转述 |
| ④ 真正的直发是另一个开关 | `uplinkMode: 'on'` 才会绕过闸门直接发到用户私聊，仅救火用；默认 `off` |

守门方式：离线自测 `node tests/selftest.mjs` 里有
**「全程没有点名收件人的上行（v2：dsh 不直发用户）」**：
默认模式拦截 `/send` 并检查请求体里没有 `target` / `type`，
谁把默认值改回去、或在某条路径上又加了直发，自测立刻红。

## 五、直通模式（v0.7.0，主人自己开的旁路）

平时消息是「用户 → 闸门筛选 → dsh → 闸门转述 → 用户」。直通把闸门这道撤掉，
变成「主人原文 → dsh → 原文回主人」：

```
主人在私聊发 dsh/1
  → AstrBot 插件写 cache/direct_state.json（on=true），抢在对话处理前拦下这条指令
之后主人每发一句话
  → AstrBot 插件直接写 cache/inbox/<id>.json（from=master, direct=true, thread=...）
  → DSH 侧复用/新开会话执行
  → 结果推回 AstrBot /send
  → 插件发现直通开着，原文发回主人（不总结、不叫醒助手）
发 dsh/0 退出；发 dsh/2 换一条新会话（下一条带 newSession: true）
```

边界：

- 只在私聊里认、只认配置里的 `target_id`；
- 直通期间助手不插嘴、不总结，消息也不进对话上下文；
- 开关落 `cache/direct_state.json`，AstrBot 重启也认得；
- DSH 侧要 0.7.0+ 才认 `newSession`；旧版只会接着上一条会话，直通仍可用，只是 `dsh/2` 换不了新会话。

## 六、字段清单（给闸门侧的读法）

`outbox/<id>.json`：`id`、`from`（恒 `dsh`）、`to`（恒 `gateway`）、`source`（信息来源，默认 `dsh`）、
`time`、`type`（`result`）、`ref`（= 任务 id）、`status`（`done` / `failed`）、`summary`（一句话）、
`content`（完整结果）。

`outbox/<id>.notice.json`：同上字段，`type` 为 `notice`、`status` 为 `notice`、多重一个 `notice: true`，
用来告诉闸门「指令已收到 / 会话已拉起 / 拉起失败」——这些是过程消息，不是最终结果。

inbox 的可选字段（`preset` / `newSession` / `direct` / `thread`）见第一节末尾。
