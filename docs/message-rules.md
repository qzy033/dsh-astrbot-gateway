# 中转规则 v2（Funa 唯一闸门版）

qzy 于 2026-09-12 18:27 下达新规则：**所有消息必须经过 Funa 这一个 AI 中转，不许直连。**

## 通道定义

```
qzy  ──说──▶  Funa（筛选/确认）  ──投放──▶  dsh（小鲸鱼）
qzy  ◀──整理──  Funa  ◀──写回报文件──  dsh（小鲸鱼）
```

## 一、上行：qzy → Funa → dsh

1. qzy 说的话先到 Funa 手里，Funa 判断是不是"明确给小鲸鱼的指令"。
2. 只有确认是指令的，才写成 JSON 投进 `E:\project\dsh-funa-bridge\cache\inbox\`。
3. 不是指令的（聊天、吐槽、闲聊、其他事）一律留在 Funa 这边，绝不外传。
4. 在犹豫时默认不转，等 qzy 明确点名。

### inbox 条目的可选字段：`preset`（这条用哪种模式跑）

`cache/inbox/<id>.json` 除了 `id/from/to/time/type/content/status`，可以再加一个可选字段
**`preset`**（也认 `agentPreset`），指定「这条指令拉起的会话用哪个 agent 预设」：

```json
{"id":"...","from":"funa","to":"dsh","time":"ISO8601","type":"task",
 "content":"文本","status":"pending","preset":"teyvat-hoi4"}
```

- **不写** → 用插件配置的 `dispatchPreset`（本机已设成 `standard`，即**标准模式**）。
- `"teyvat-hoi4"` → 提瓦特黎明 HOI4 模式（带项目 persona，强制每回合先读
  `E:\teyvatdaybreak\PROJECT_RULES.md` 与 SKILL 索引）。
- `"hoi4-mod"` → HOI4 通用开发模式（不绑定具体 MOD）。
- 写错（该预设不存在）→ **不会让指令失败**：插件记一行日志后回退到 `standard`。

**Funa 的建议用法**：指令明显是 HOI4 MOD 开发（`.txt`/`.gfx`/`.yml`/`.mesh`、国策、图标、
兵模转换…）或明确点名提瓦特黎明项目时，加 `"preset":"teyvat-hoi4"`；其余一律不写（走标准模式）。
拿不准就不写 —— 标准模式一样能干活，只是没有项目专属 persona 与模板优先级约束。

## 二、下行：dsh → Funa → qzy

1. 小鲸鱼完成任务后，**不再通过上行接口直接给 qzy 发消息**。
2. 它只把结果写成 `E:\project\dsh-funa-bridge\cache\outbox\<id>.json`，字段必须齐全：
   ```json
   {
     "id": "任务ID",
     "from": "dsh",
     "to": "funa",
     "source": "xiaojingyu",
     "time": "ISO8601",
     "type": "result",
     "ref": "对应的任务ID",
     "status": "done",
     "summary": "一句话摘要",
     "content": "完整内容"
   }
   ```
3. `source` 字段用来标明信息来源，`status` 标当前状态，缺一不可。
4. Funa 读取并处理后，用自己的话向 qzy 汇报，并注明"来自小鲸鱼"。

## 三、Funa 取件时机

- qzy 说"看看它回了没"之类的话时，Funa 立刻去读 outbox。
- 除此之外 Funa 不做任何自动巡检，不主动打扰 qzy。
- 若 qzy 想恢复自动巡查，随时可以再开。

## 四、dsh 侧怎么落实（实现记录，2026-09-12）

改的是 dsh 侧 cordis 插件 `plugin/dsh-funa-bridge`（宿主平面，改完需重启 dsh 生效）：

| 规则 | 落实方式 |
| --- | --- |
| ① 只收 Funa 筛选后的指令 | inbox 条目的 `from` 一律是 `funa`；`bridge_inbox` / `bridge_claim` 的说明已改成「Funa 转达」，自动拉起投给新会话的提示词也写明不直收 qzy 原文 |
| ② 结果写 outbox、字段齐全 | `writeResultJson()` 统一产出 `id/from/to/source/time/type/ref/status/summary/content`；`to=funa`、`source` 默认 `xiaojingyu`；`content` 必须是完整结果（超长会留一行显式说明，不静默截断） |
| ③ 不通过上行接口直发 qzy | 新增 `uplinkMode`，**默认 `off`**：`deliver()` 只落盘。连「收到指令 / 已拉起 / 拉起失败」这类即时告知也改成落 `outbox/<id>.notice.json`，由 Funa 取件时一并转述 |
| ④ 只有 Funa 这条路 | 上行 `/send` 保留但默认不开闸：它到达的是 Funa 的 QQ 账号（= qzy 的私聊），用一次就等于绕过一次闸门。救火时才显式 `uplinkMode: 'on'` |

守门方式：离线自测 `node tests/selftest.mjs` 里有一条 **「全程零上行（v2：dsh 不直发 qzy）」**，
默认模式拦截 `/send` 并断言次数为 0；谁把默认值改回去、或在某条路径上又加了直发，自测立刻红。

## 五、字段清单（给 Funa 侧的读法）

`outbox/<id>.json`：`id`、`from`（恒 `dsh`）、`to`（恒 `funa`）、`source`（信息来源，默认 `xiaojingyu`）、
`time`、`type`（`result`）、`ref`（= 任务 id）、`status`（`done` / `failed`）、`summary`（一句话）、
`content`（完整结果）。

`outbox/<id>.notice.json`：同上字段，`type` 为 `notice`、`status` 为 `notice`、多重一个 `notice: true`，
用来告诉 Funa「指令已收到 / 会话已拉起 / 拉起失败」——这些是过程消息，不是最终结果。
