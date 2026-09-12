# dsh-astrbot-gateway

> 安装方式见仓库的 `docs/install-dsh.md`，那份是写给 AI 的，照着做就能挂进 profile。

dsh 侧的桥接插件：把闸门筛选后转达的指令从 `cache/inbox` 取来执行，结果写进
`cache/outbox` 交付给闸门 —— **由闸门转述给用户，dsh 不直连用户**。

对应任务卡：`../../docs/task-for-dsh.md`；消息规范：`../../docs/message-rules.md`（中转规则 v2）。

## 它做什么

| 方向 | 行为 |
| --- | --- |
| 下行 | 每 `pollMs`（默认 4s）扫一次 `cache/inbox/*.json`；发现 `pending` 指令就**自动拉起一个 DSH 会话去处理**（`autoDispatch`，默认开），并把「收到 / 已拉起 / 拉起失败」写成 `cache/outbox/<id>.notice.json` 通知文件，同时刷新队列快照 `cache/bridge_status.json`。 |
| 交付 | **只落盘，不直发用户**（`uplinkMode` 默认 `off`）：结果写 `cache/outbox/<id>.json`，字段按 v2 规范齐全；闸门取件后用自己的话转述给用户。 |
| 接单 | 提供工具 `bridge_inbox` / `bridge_claim` / `bridge_complete`，由 agent 认领并执行指令，完成后写 outbox 交付。 |
| 收尾 | `runningTimeoutMs`（默认 30 分钟）超时回收：认领后一直不回报的（DSH 重启、会话被停止、agent 被杀）会被标成 `failed` 并落一条失败结果给闸门，避免永久挂在队列里冒充「在跑」。写 `0` 可关闭。 |
| 上行 | 保留但**默认关闭**：`/send` 到达的是闸门的 QQ 账号（= 用户的私聊），用它发就等于绕过闸门。只有显式写 `uplinkMode: 'on'`（救火）才会走；启动时仍会 `GET /ping` 做自检，结果记在 `bridge_status.json.uplink`。 |

### v2 与 v1 的差别（一句话）

v1：完成任务后**用上行接口直接给用户发消息**，用户在 QQ 里看到的是 dsh 的话。
v2：完成任务后**只写 outbox**，用户通过闸门得知结果，且闸门会注明「来自dsh」。
差别落在三处：`outbox/<id>.json` 的字段（多了 `source`，`to` 从 `用户` 改成 `gateway`）、
通知改落 `outbox/<id>.notice.json`、以及默认零上行。

### 自动拉起：扫到 pending 就自己干活（`autoDispatch`）

轮询发现新指令后，插件会**自己叫醒一个会话**去处理，不用用户手动喊：

```
sessionController.create({})        // 建会话：sessionId / cwd / 预设都可省略，走宿主默认
sessionController.prompt({          // 投一条用户消息（按 requestId 幂等，重复投喂会被去重）
  sessionId, requestId: `bridge-<id>`, mode: 'queue',
  content: [{ type: 'text', text: '【桥接指令 <id>】… 请 bridge_claim → 执行 → bridge_complete' }],
})
```

机制照抄部署里现成的 **`@agents-anywhere/dsh-bridge-next`**（AA 手机端 → DSH 会话，就是
「外部事件拉起会话」的官方实现），两个服务都用 `ctx.get` 取（可选取）。

容错设计（都很重要）：

- `sessionController` 缺失 / `create` 抛错 / `prompt` 抛错 → **只降级成「只通知」，插件本身照常跑**，
  并且在通知里如实写明失败原因；最多重试 `3` 次，两次之间至少隔 `dispatchRetryMs`
  （默认 60s，避免轮询 4s 时十几秒就把重试次数烧完），之后放弃并写明「需要你叫我处理」。
- 已拉起的指令写 `cache/.dispatched-<id>` 标记，重启后也不会重复拉起；
  即使标记写失败，`prompt` 的 `requestId` 幂等也能兜住重复投喂。
- **仍然不擅自把任务标成 `running`**：认领仍由 agent 显式调 `bridge_claim` 完成，
  这样没人干活时任务不会被悄悄吞掉。
- `capabilities.dispatch` 四种取值：`disabled`（关掉了）/ `ready` / `lazy` / `failed`。
  **`lazy` 是正常现象**：插件的行可能比 `session-controller` 那一行先激活，而 cordis 对
  尚未运行的服务 `ctx.get` 会返回 undefined。真正的判定发生在轮询拉起时（会重新 `ctx.get`），
  所以 `lazy` 不影响自动拉起。

### 桥接会话跑哪种「模式」（`agentPreset`）

`sessionController.create()` 不传 `agentPreset` 时用的是**宿主默认预设**，而本机
`$DSH_HOME/settings.yaml` 里 `agent-presets.default` 是 `teyvat-hoi4`（提瓦特黎明 HOI4
项目专用 persona，每回合强制先读 `E:\teyvatdaybreak\PROJECT_RULES.md` + SKILL 索引）。
不管它的话，**每条桥接指令拉起的会话都被 HOI4 模式接管** —— 跟桥接任务毫无关系，白烧几轮
读规则。实测三条桥接会话（`group-182442`、`rule-v2-…`、`selfcheck-v2-1`）的 header 全是
`"agentPreset":"teyvat-hoi4"`。

规矩（用户定的）：**桥接默认走「标准模式」（`standard`）；确实要 HOI4 模式的单条指令由闸门点名。**

优先级（高 → 低）：

| 来源 | 写法 | 说明 |
| --- | --- | --- |
| 单条指令 | inbox JSON 里 `"preset": "teyvat-hoi4"`（也认 `"agentPreset"`） | 闸门按这条指令的性质选模式 |
| 插件配置 | 行配置 `dispatchPreset: standard` | 本机 desktop profile 的补丁层已这么设 |
| 宿主默认 | 不传 `agentPreset` | 兜底，等于 `settings.yaml` 的 `agent-presets.default` |

点名一个**不存在的**预设不会让指令失败：记一行日志（`…点名的预设 "x" 不在花名册（可用: …），回退到 …`）
后按「插件配置 → 宿主默认」回退。花名册（`ctx.agentPresets`）读不到时也不拦，照传，
交给宿主 `create()` 用 `agent-preset/not-found` 说话 —— 「读不到花名册」和「预设不存在」是两回事。

拉起后的通知里会写明这次用的模式：`已自动拉起会话 <sessionId> 处理（模式 standard）。`

> 部署侧那个默认值写在 `$DSH_HOME/profiles/desktop/cordis.patch.yml`（desktop profile 是
> `patchReload: live`，**改完不重启就会重新组合**）。改插件**代码**则必须重启 dsh：
> base 里 `hmr` 那一行是 `disabled`，只有配置会被热重载。

### 为什么轮询不自动认领

`autoClaim` 默认 `false`：把 `status` 改成 `running` 由 `bridge_claim` 显式完成。
这样重复轮询、以及用户不在场/没人干活时，指令都不会被悄悄标成 running 而永久卡住。
需要自动认领就把 `autoClaim` 打开。

已通知过的指令会在 `cache/.notified-<id>` 留标记，所以插件重启后不会重复落通知文件。

## 目录约定

```
cache/
  bridge_access.json     # 闸门侧签发（含 token），本插件只读
  inbox/<id>.json        # 闸门筛选后转达的指令，本插件读 + 回写 status
  outbox/<id>.json       # 本插件写的结果（v2：to=gateway，带 source）
  outbox/<id>.notice.json# 本插件写的巡检通知（收到指令 / 已拉起 / 拉起失败）
  bridge_status.json     # 本插件写的自检/队列快照，便于排查（含 dispatch.cwd/preset、accessError、hint）
  .notified-<id>         # 本插件的「已通知」标记
  .dispatched-<id>       # 本插件的「已自动拉起」标记（含 session id）
```

`bridge_status.json` 里的 `hint` 是给人看的：上行自检通过时它是 `null`；不通时它会直接写明
「AstrBot 侧还没装好，去面板装哪个插件、填哪一项、然后重启」。桥断掉的时候先看这一行，
`bridge_inbox` 的返回里也会带上同一句。

`inbox/<id>.json` 结构（闸门落盘，`from` 应为 `gateway` —— v2 起 dsh 不直收用户原文）：

```json
{"id":"...","from":"gateway","to":"dsh","time":"ISO8601","type":"task","content":"文本","status":"pending"}
```

可选字段 `preset`（或 `agentPreset`）：**这条指令用哪个 agent 预设**跑。不写就用插件配置的
`dispatchPreset`（本机 = `standard`），再不写才落到宿主默认。见上面「桥接会话跑哪种模式」。

`outbox/<id>.json` 由本插件写（v2 规范，`docs/message-rules.md` 第二节）：

```json
{
  "id": "任务ID", "from": "dsh", "to": "gateway", "source": "dsh",
  "time": "ISO8601", "type": "result", "ref": "对应的任务ID",
  "status": "done", "summary": "一句话摘要", "content": "完整内容"
}
```

字段规矩：`source`（信息来源）与 `status`（当前状态）**缺一不可** —— 少了闸门侧就无法
判断这条该不该转、转的是谁的话；`content` 必须是**完整结果**（不能拿摘要顶替），
超长时截断处会留一行显式说明。`status` 取 `done` 或 `failed`。

`outbox/<id>.notice.json` 是本插件的巡检通知（`type: "notice"`、`notice: true`，字段与上面同构）。
它存在的理由：v2 下 dsh 连「我收到了，正在干」这种即时告知也不能直发用户，
只能落盘让闸门取件时一并转述。

写 outbox 一律用「临时文件 + rename」，读者不会看到半截文件。

## 配置

插件按 cordis 配置项读取，全部可选（默认值即可跑）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `root` | `<项目目录>\cache` | 桥接缓存根目录 |
| `pollMs` | `4000` | 轮询间隔；`0` 关闭轮询（只用工具手动处理） |
| `autoDispatch` | `true` | 扫到 `pending` 就自动拉起会话处理；设 `false` 退回「只通知」 |
| `dispatchPreset` | 空 | 自动拉起用哪个 agent 预设（= 会话以哪种「模式」跑）；空 = 宿主默认预设。**本机 desktop profile 的补丁层设成 `standard`**，免得每条桥接指令都继承 `settings.yaml` 里那个 HOI4 项目预设；单条指令可用 inbox JSON 的 `preset` 覆盖 |
| `dispatchCwd` | 桥接目录的上一级 | 自动拉起的会话归属哪个工作区组别；目录不存在则落「未分组」 |
| `autoClaim` | `false` | 轮询发现新指令时是否自动标 `running` |
| `uplinkMode` | `off` | `off`=只落盘交付闸门（v2 默认，**不直发用户**）；`on`=恢复 v1 直发（仅救火用） |
| `defaultTarget` | 空 | 上行目标；空则用 `bridge_access.json` 的 `default_target`（只对 `uplinkMode: 'on'` 有意义） |
| `targetType` | `PrivateMessage` | AstrBot 侧只接受 `PrivateMessage` / `GroupMessage` |

## 安装（已执行）

本插件是 **profile bundle 插件**（宿主组合里的一行），装好后长期生效、对所有会话可用，
但**需要重启 dsh** 才会加载。已经用 `tools/install.ps1 -Apply` 装好，重启即生效。

若要在别的机器/环境重装，脚本做两件事：

1. 在 profile 里把本包登记为本地依赖，并把 `"dsh-astrbot-gateway"` 追加进
   profile `package.json` 的 `dsh.profile.bundles`。本包自带 `cordis.patch.yml`
   （`insert` 一行 `dsh-astrbot-gateway`），所以只要它在 bundles 列表里就会自动挂载。
2. 改 `package.json` 前自动备份，可重复执行（幂等）。

```powershell
# 只看会改什么
powershell -ExecutionPolicy Bypass -File tools\install.ps1
# 真正执行
powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Apply
```

重启后确认：

- `cache/bridge_status.json` 出现且 `"uplink": true`；
- `capabilities` 字段里 `tools` / `timer` / `interval` 都是 `true`；
- 工具列表里能看到 `bridge_inbox` / `bridge_claim` / `bridge_complete`。

## 两个已经踩过的坑（改这个插件前务必先看）

### 1. pnpm 对 `file:` 依赖是「复制」，不是软链

改完 `lib/index.js` 后直接把插件加进 profile，pnpm 会在 `node_modules` 里留一份
**旧副本**，并且重跑 `pnpm add` 只会回一句 `Already up to date` —— dsh 加载的
始终是那份旧代码。表现是「改了没反应」，非常容易误判成 inject 或加载问题。

`tools/install.ps1` 现在会对比 `node_modules/<pkg>/lib/index.js` 与源码的哈希，
不一致就删掉副本再 `pnpm install`，装完还会再验一次哈希。**改完插件请用它重装。**

### 2. cordis 是严格注入，且 ESM 有缓存

- **`ctx.<name>` 属性访问**用到的服务**必须**在 `inject` 里声明（数组形式），
  否则 apply 开头就抛 `cannot get property "..." without inject`，整个插件不注册。
  本插件声明的是 `['tools', 'timer']`。
- **`ctx.get(name)` 不需要 inject**：它只是查表，取不到返回 `undefined`、不会抛
  （`get(name, strict)` 的 strict 只影响「存在但未启动」的服务）。
  **所以可选能力一律用 `ctx.get` + 判空，绝不能写进 inject** ——
  否则宿主没这个服务时连插件都加载不起来。本插件的 `sessionController`
  就是可选取服务（自动拉起用，见上面「自动拉起」一节）。
- 改完源码后 disable/enable、重装依赖都**不会**生效：ESM 模块按 URL 永久缓存，
  只能重启 web。
- 反过来，**纯 cordis 插件**（不声明 `dsh.bundle`）走 profile 的
  `cordis.patch.yml` insert 行是配置 HMR、可零重启挂载；bundle 插件必须重启。

`tests/selftest.mjs` 里的假 ctx 复刻了这两条语义：属性访问未声明服务就抛错并计入
`undeclared`，而 `get('未知服务')` 返回 `undefined`，所以这两类错误在离线自测阶段
就会暴露，不用等重启。

### 3. 同一个 id 只能有一层：进了 bundles 就别再写 profile patch

DSH Desktop 启动时这样组 profile 组合：

1. `dsh.profile.bundles` 里**每个 bundle 各一层**：读它的 `package.json` →
   `dsh.bundle.patch` 指向的 patch 文件；
2. 再叠加 **profile 自己的** `cordis.patch.yml`（又一层）；
3. 把各层 `insert` 行拼成 loader 行，最后统一检查 id 唯一性。

所以本包已经在 `bundles` 里时，profile 的 `cordis.patch.yml` 里**再手写一行**
`- insert: { id: dsh-astrbot-gateway }`，同一个 id 就被插了两次，桌面端启动直接抛：

```
dsh-plugin-desktop: duplicate loader entry id "dsh-astrbot-gateway" in the composed profile
    at assertUniqueEntryIds (.../lib/profile-*.js)
    at prepareDesktopProfile (.../lib/main.js)
```

随后进**恢复模式**：内部执行 `dsh plugin --profile desktop remove dsh-astrbot-gateway`。
而 remove 要跑 pnpm，profile 里只要有一个拉不动的私有 git 依赖（例如 gal-view 连不上
GitHub），**连恢复都会失败**，只剩人工回滚 profile —— 桌面端起不来。这个坑真踩过。

本包是 **bundle 插件**（`package.json` 里有 `dsh.bundle`），挂载方式就是「进 bundles」，
不需要、也不要再动 profile 的 `cordis.patch.yml`。

**重启前先离线预检**（复刻上面的分层组合 + id 唯一性检查，不起 DSH 也不会崩）：

```powershell
node ..\..\tools\check-profile.mjs --profile desktop
```

退出码 `0` = 无重复 id；`1` = 有冲突（会打印是哪两层撞了）。`install.ps1` 也加了同样的
守卫：发现 profile patch 里已有同名 insert 行就直接拒绝执行。

> 另外：`dsh plugin add/remove` 会跑 pnpm。profile 里有 `file:` 依赖时，直接改 profile
> 的 `package.json` + 保证 `node_modules\<pkg>` 是最新副本，比走 `dsh plugin` 更省事，
> 也不会因为网络问题把恢复流程拖失败。

### 4. 不要导出 `Config`（除非用 schemastery）

cordis 解析插件配置走 **Standard Schema** 协议，实现是：

```js
entry.plugin.Config['~standard'].validate(rawConfig)   // @deepseek-ai/cordis 的 resolveConfig
```

所以 `Config` 必须是 schemastery 的 `z.object({...})` 实例，**不是**描述字段的普通对象。
写成普通对象时 `Config['~standard']` 是 `undefined`，读 `.validate` 立刻抛：

```
dsh-plugin-desktop: plugin tree failed to load: failed to apply loader entry dsh-astrbot-gateway
  (dsh-astrbot-gateway): Cannot read properties of undefined (reading 'validate')
    at resolveConfig (…/@deepseek-ai/cordis/lib/index.js:957:45)
```

**整个插件树加载失败**（不是只有本插件不生效），桌面端同样进恢复模式回滚 profile —— 
和坑 3 是同一套恢复流程，也一样会因为 gal-view 连不上 GitHub 而恢复失败。这个坑也真踩过。

本插件刻意零依赖（只 `import` `node:` 内置模块），而 desktop profile 的 `node_modules`
里没有 `@deepseek-ai/schemastery`（装它要走 pnpm / 联网），所以**干脆不导出 `Config`**：
配置全靠 `apply` 里的默认值；需要覆盖时在组合的行里写 `config`，`apply` 照常读到（无校验）。
同一个 profile 里能跑的 `gal-view` 也是这个形态——只导出 `name` / `inject` / `apply`。

两道回归守卫：

- `tests/selftest.mjs`：`Config` 要么不存在，要么必须带 `'~standard'.validate`；
- `tools/check-profile.mjs`（仓库根 `tools\`）：重启前 `import` 每个 bundle 的入口，
  把 `name` / `inject` / `apply` / `Config` 契约一起查。

### 5. `ctx.tools.register()` **不编译任何东西**——传进去的必须是编译后的原始 JSON Schema

这是最绕、踩得最久的一条。dsh-tools 有**两个**层级：

| 层 | 角色 | 对 `parameters` / `output.schema` 做什么 |
| --- | --- | --- |
| `defineTool({...})` | **作者向包装器**（内置工具都走它） | 把描述符 DSL / 作者值 schema **编译**成原始 JSON Schema，再交给 register |
| `ctx.tools.register(definition)` | **注册表本身** | **什么都不编译**：只要求 `output.render` 是函数、`assertSupportedJsonSchema(output.schema)`，然后把 definition **原样**收下 |

也就是说 register 认为你给的就是编译后的成品：
`definition.parameters` 会被**原样发给模型**，`output.schema` 会被当成**已经是原始 JSON Schema** 来断言。
本插件刻意零依赖（拿不到 `@deepseek-ai/dsh-tools` 的 `defineTool`），所以**直接手写编译后的形态**。
写错就会连踩两个坑，两个都真踩过：

**坑 5a** —— 把作者 spec 直接当原始 schema（逐字段 `required: true`）：

```
dsh-plugin-desktop: plugin tree failed to load: failed to apply loader entry dsh-astrbot-gateway
  (dsh-astrbot-gateway): unsupported JSON schema: schema.properties.summary.properties.total.required
  is not supported on type "number"; schema.properties.tasks.required is not supported on type "array"; …
    at assertSupportedJsonSchema (…/@deepseek-ai/dsh-tools/lib/index.js)
```

→ **整个插件树加载失败**，桌面端回滚 profile。

**坑 5b** —— `parameters` 用了描述符 DSL（根节点没有 `type`）：

```
本轮运行失败 Invalid schema for function 'bridge_claim':
  schema must be a JSON Schema of 'type: "object"', got 'type: null'.
```

→ 插件挂得上、日志一切正常（`上行自检: OK`、`轮询已启动`），但**每一轮对话都失败**，而且同样触发回滚。这个坑最难查，因为它伪装成"运行期偶发"。

所以本项目里的规矩是：

- `parameters` 手写成 `{ type:'object', properties:{...}, required:[...] }`
  （没有必填参数时**省略** `required` 键，与 `defineTool` 产物一致）；
- `output.schema` 手写成 object 根、落在受支持子集内的原始 schema；
- 两者的写法必须逐字节等于 `defineTool` 会编译出来的东西
  （`cache/` 下跑一次保真度对比即可确认）。

受支持子集（取自 dsh-tools 源码）：关键字只有
`type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const`
加注解（`description`、`title` 等），并且：

- `properties` / `required` / `additionalProperties` 只能挂在 `type: "object"` 上；
- `items` 只能挂在 `type: "array"` 上；`enum` / `const` 只能挂在标量上；
- `type` 必须是**单个字符串**（不支持 type 数组）；同一节点不能同时写 `type` 与 `oneOf`；
- `additionalProperties` 必须是 boolean；`required` 必须是字符串数组且只能挂在 object 上；
- `parameters` 必须是 **object 根**（否则模型 API 直接拒收）。

两道离线门禁（都不用重启）：

```powershell
node tests\selftest.mjs                     # 自测：内置同规则校验 parameters(object 根) + output.schema
node ..\..\tools\validate-tool-schemas.mjs  # 真门禁：抽出 app.asar 里的真 dsh-tools 来断言
```

`validate-tool-schemas.mjs` 不是"复刻规则"，而是把 asar 里的 `node_modules/@deepseek-ai`
抽到 `cache/_dsh-asar/` 后**直接调用官方函数**（`assertObjectJsonSchema(parameters)` +
`assertSupportedJsonSchema(output.schema)`，正是 register 与模型 API 的要求），
所以结论和真启动一致。`tools\install.ps1 -Apply` 也会先跑这两道门禁，不通过就拒绝写 profile。

### 6. 工具返回值要过**两道输出校验**（都是活测才暴露的）

dsh-tools 对每个工具的**返回值**做两件事，任何一条不过，整个工具调用就报
`tool "<name>" returned invalid output: …`：

**6a. 必须是 lossless JSON**（`isJsonValue`）——带 `undefined` 的对象不是合法 JSON 值
（`JSON.stringify` 会静默丢掉它）：

```
tool "bridge_inbox" returned invalid output: value is not lossless JSON
```

真实触发条件：任务 JSON 里没有 `ref` 字段时 `t.ref` 是 `undefined`。
**队列为空时恰好没有 undefined，所以只在「真有任务」时才现形**。
修法是返回前统一过一遍 `jsonSafe()`（递归丢 undefined）。

**6b. 必须严格符合自己的 `output.schema`**（含 `additionalProperties: false`）：

```
tool "bridge_complete" returned invalid output:
  "value.uplink.result" is not a declared property (additionalProperties: false)
```

真实触发条件：`sendUplink` 成功时返回 `{ ok, status, result }`，而 schema 里 `uplink`
只声明了 `ok / status / message`。这是**只有成功路径才有的字段**，失败路径测不出来。
修法是把返回值归一化成 schema 里声明过的形状。

> 6a / 6b 都发生在 `execute()` **之后**：报错时副作用（写 outbox、回写 inbox、
> 上行回报 QQ）其实都已经做完了，只是这一轮的「工具结果」被判非法。

这两条现在由 `tools\validate-tool-schemas.mjs` 的**行为门禁**覆盖：它会在沙箱里
（stub 掉 fetch，绝不发真请求）真跑一遍 `bridge_inbox → bridge_claim → bridge_complete`，
再用官方的 `validateJsonSchemaValue` 校验每个返回值。

### 7. 自动拉起的三处宿主契约（都真踩过）

自动拉起用的宿主 API（照抄 `@agents-anywhere/dsh-bridge-next`）：

```js
await sessionController.create({ cwd })                        // 1) cwd 决定会话归到哪个工作区
await workspaceRegistry.create(cwd).attachSession(sessionId)  // 2) 挂进该工作区组别
await sessionController.prompt({ ... }, signal)                // 3) signal 是必需的第二参数
```

**7a. `prompt(request, signal)` 的 `signal` 是必需的**

同一个类里两个方法签名不一样，`prompt` 第一行就是 `signal.throwIfAborted()`
（`create` 只收 1 个参数）：

```js
create(request)           // 只收 1 个参数
prompt(request, signal) { // ← 第二参数必需
  signal.throwIfAborted();
  return this.commands.prompt(request);
}
```

漏传会得到：

```
自动拉起失败（Cannot read properties of undefined (reading 'throwIfAborted')），稍后重试。
```

宿主不关心"谁取消"，但会先检查它存在，所以传 `new AbortController().signal` 即可。

**7b. 不传 `cwd` 会拿到宿主的 `process.cwd()`（= DSH 安装目录）**

那个路径不属于任何工作区，会话就落到侧边栏的**「未分组」**里（能看到，但不在你的项目组下）。

**7c. 光有 `cwd` 还不够，必须 `attachSession()`**

GUI 侧边栏读的是**工作区的 `sessionIds`**，而 `attachSession` 会校验会话 header 的 `cwd`
必须等于工作区路径 —— 所以 `create` 的 `cwd` 与 `attachSession` 的工作区必须一致。

本项目的行为（用户定的规矩）：

- **能挂上工作区就带组别**：`dispatchCwd` 默认取桥接目录的上一级（`<项目目录>`），
  那是个真实存在、你也在用的工作区；
- **挂不上就落「未分组」，但绝不因此失败**：目录不存在 → 不传 `cwd`；`attachSession` 抛错 →
  只记日志。会话照样建、照样干活，只是显示在未分组里。

`tests/selftest.mjs` 里的假 `sessionController` / `workspaceRegistry` **刻意与真 API 同签名**
（`prompt(request, signal)` 第一行 `throwIfAborted()`；`attachSession` 记录调用），
所以漏 signal、漏 cwd、漏挂载这三类问题都会在离线自测里暴露。

## 自测

```powershell
node tests/selftest.mjs            # 默认：不发消息，只报告「本来会发什么」
node tests/selftest.mjs --live     # 真发到用户的 QQ（会打扰人，慎用）
```

以假的 cordis ctx 直接驱动插件本体，覆盖：读访问文件、上行 ping、轮询发现、去重通知、
认领（含拒绝路径穿越）、完成、outbox 结构与 v2 字段清单、状态快照、严格注入合规、
**全程零上行**（v2 守门断言）、以及救火开关 `uplinkMode:'on'` 仍可用。
使用沙箱目录 `cache/_selftest`，不碰真实的 `inbox/outbox`。

**默认模式会拦截 `/send`**（ping 仍放行），只把请求内容记下来做断言，所以反复跑也不会
打扰用户——这一点是踩过坑之后改的：早先版本每跑一轮就真发两条到 QQ，连跑几轮把用户
的消息列表刷了一串测试消息。v2 之后更强的保证是：**默认一次 `/send` 都不该发生**，
自测里那条「全程零上行」就是拦这件事的；真发生会打印每一条越权上行的内容。

## 已知边界

- **自动拉起会新建一个会话**（不是往当前会话注入消息——dsh 没有那种公开接口）。
  所以每条桥接指令对应会话列表里的一个新会话，你能在 GUI 里看到它跑了什么。
  工作目录/预设用 `dispatchCwd` / `dispatchPreset` 控制：本机 `dispatchCwd` 已指向
  `<项目目录>`、`dispatchPreset` 已设成 `standard`（见上面「桥接会话跑哪种模式」）。
- **被拉起的会话仍受宿主的审批与权限策略约束**。如果它的动作触发了审批，会停在
  等审批那一步——这不是桥接的问题，按需在宿主侧调权限预设即可。
- **新会话需要有可用的模型路由**：宿主没给这个会话配到能用的 provider 时，
  `prompt` 会抛 `session/model-unavailable`，此时插件降级成「只通知」，通知里会写明原因。
- `bridge_complete` 里「写 outbox / 回写 inbox」与「交付」是分开报告的：交付失败
  不会让「结果已落盘」变成失败，返回值里 `delivery.ok` 会如实为 `false`。
  v1 的 `uplink` 字段仍在返回值里（兼容老读者），它现在反映的是**交付**结果。
- token 只在本机使用，不下发到任何外部端点；插件只连 `bridge_access.json` 里的
  `127.0.0.1` 地址。
- **改完本插件必须重启 dsh**（bundle 插件 + ESM 缓存，见上面第 2 条）。
  重启前跑的仍是旧代码 —— 包括「还在直发用户」的 v1 行为。
- **改 profile 补丁层（`cordis.patch.yml` 里的配置覆盖）也要重启**：实测 2026-09-12
  改完 `$DSH_HOME/profiles/desktop/cordis.patch.yml`（`dispatchPreset: standard`）后，
  34 秒后自动拉起的会话仍是 `"agentPreset":"teyvat-hoi4"`，`bridge_status.json` 也没变成
  新结构 —— 即补丁**没有被热重载**。原因在宿主侧：热重载那条路 `watchUserPatches()` 要求
  `ctx.get('hmr')` 存在，而 base 里 `hmr` 那一行是 `disabled: true`（`dsh-app-boot` 的
  注释说 CLI launcher 有自己的 watch-only 回退，Desktop 这条路径没有）。所以 desktop
  profile 上的 `patchReload: live` 实际等于「下次启动才生效」。
  **判定方法**：重启后看 `cache/bridge_status.json` 有没有新的 `dispatch` 块、
  `dispatch.preset` 是不是 `standard` —— 有就是新代码+新配置都生效了。
