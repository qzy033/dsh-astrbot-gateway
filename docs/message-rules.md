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
4. 闸门读取并处理后，用自己的话向用户汇报，并注明"来自dsh"。

## 三、闸门取件时机

- 用户说"看看它回了没"之类的话时，闸门立刻去读 outbox。
- 除此之外闸门不做任何自动巡检，不主动打扰用户。
- 若用户想恢复自动巡查，随时可以再开。

## 四、dsh 侧怎么落实（实现记录，2026-09-12）

改的是 dsh 侧 cordis 插件 `plugin/dsh-astrbot-gateway`（宿主平面，改完需重启 dsh 生效）：

| 规则 | 落实方式 |
| --- | --- |
| ① 只收闸门筛选后的指令 | inbox 条目的 `from` 一律是 `gateway`；`bridge_inbox` / `bridge_claim` 的说明已改成「闸门转达」，自动拉起投给新会话的提示词也写明不直收用户原文 |
| ② 结果写 outbox、字段齐全 | `writeResultJson()` 统一产出 `id/from/to/source/time/type/ref/status/summary/content`；`to=gateway`、`source` 默认 `dsh`；`content` 必须是完整结果（超长会留一行显式说明，不静默截断） |
| ③ 不通过上行接口直发用户 | 新增 `uplinkMode`，**默认 `off`**：`deliver()` 只落盘。连「收到指令 / 已拉起 / 拉起失败」这类即时告知也改成落 `outbox/<id>.notice.json`，由闸门取件时一并转述 |
| ④ 只有闸门这条路 | 上行 `/send` 保留但默认不开闸：它到达的是闸门的 QQ 账号（= 用户的私聊），用一次就等于绕过一次闸门。救火时才显式 `uplinkMode: 'on'` |

守门方式：离线自测 `node tests/selftest.mjs` 里有一条 **「全程零上行（v2：dsh 不直发用户）」**，
默认模式拦截 `/send` 并断言次数为 0；谁把默认值改回去、或在某条路径上又加了直发，自测立刻红。

## 五、字段清单（给闸门侧的读法）

`outbox/<id>.json`：`id`、`from`（恒 `dsh`）、`to`（恒 `gateway`）、`source`（信息来源，默认 `dsh`）、
`time`、`type`（`result`）、`ref`（= 任务 id）、`status`（`done` / `failed`）、`summary`（一句话）、
`content`（完整结果）。

`outbox/<id>.notice.json`：同上字段，`type` 为 `notice`、`status` 为 `notice`、多重一个 `notice: true`，
用来告诉闸门「指令已收到 / 会话已拉起 / 拉起失败」——这些是过程消息，不是最终结果。
