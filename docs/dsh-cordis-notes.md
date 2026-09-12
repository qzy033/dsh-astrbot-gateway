# dsh（DeepSeek Harness）插件开发要点

来源：dsh 自带技能 `cordis-plugin-development` 与 `editing-cordis-compositions`。

## 一、什么是 cordis 插件
- dsh 的每一项能力都是 Cordis Plugin。
- 插件代码是**纯 JavaScript 函数体**，必须返回一个 Plugin 对象。
- **禁止**使用：`import`、`require`、TypeScript 类型、`as`、装饰器、JSX、以及未被 `Builtin.listBuiltins` 确认的全局对象（`window`/`document`/`process`/`Buffer`/`fetch`/原生定时器都不能直接用）。
- Client 端 React 只能用 `React.createElement(...)`。

## 二、两个平台
| 需求 | 平台 |
| --- | --- |
| 文件、命令、进程、网络 | Host |
| Agent、持久会话、宿主生命周期 | Host |
| 注册下一个模型步骤可调用的动态工具 | Host |
| 页面主题、布局、页面状态 | Client |
| 设置页、侧边栏、输入区、浮层、工具卡片 | Client |
| Host 取数、Client 展示 | 两者配合（harness.handle + host.call）|

原则：优先选择离数据所有者最近的能力，别动不动替换整块 UI。

## 三、标准开发流程
1. `cordis_inspect_list`：拿到当前 Host/Client 已注册的 Provider、方法与 schema。
2. `cordis_inspect_query`：只查实现要用到的 Service / Event / Builtin / Slot / Theme / Tool 的精确签名。
3. 新插件设计首个 Package；改已有插件先在 `cordis_inspect_self` 读源码与诊断。
4. 写 `code.host` / `code.client` 的普通 JS，调 `cordis_define`。
5. `cordis_run`（用 define 返回的 pluginId + packageId 激活）。
6. 用 Run 卡片 / steering / `cordis_inspect_self` 处理审批、等待、加载、渲染失败。
7. `cordis_stop` 临时停用；`cordis_undefine` 永久删除。

注意：不要在同一个 turn 里傻等用户审批或异步浏览器结果；拿到 `awaiting-approval` / `starting` 就结束本轮，等系统状态更新。

## 四、关键 API
- 取服务：`ctx.get('name')`，默认读可选能力并判空；确属硬依赖才写 `inject: ['name']`。
- 事件：`ctx.on('some/event', payload => {...})`；Waterfall 事件最后参数是 `next`，除非故意截断否则必须 `return next()`。
- 副作用清理：`ctx.on` / `ctx.effect` / 保留各 API 返回的 disposer，别在模块作用域造全局副作用。
- 定时器：是两个平台同名的 `timer` 服务，需 `inject: ['timer']`，用 `ctx.timeout` / `ctx.interval`。
- 客户端 UI：`ctx.get('slots')` → `slots.inject('目标槽', () => slots.register({name, id/key}, props => ...))`；注册前必须查 `Slots.listSubTree`。
- Client→Host：Host 用 `harness.handle('方法', async args => {...})`，Client 用 `await host.call('方法', args)`，只传可无损 JSON 化数据。

## 五、版本与审批模型
- Plugin（`pluginId`）= 稳定实例；Package（`packageId`）= 不可变代码版本；每次激活有 `pluginRunId`。
- `currentPackageId` = 最近成功版本；`nextPackageId` = 待审批/激活/失败的版本。
- `cordis_run` 模式：
  - 无 current → 任意 Package 用 `run`
  - 有 current、同一 Package → `run`
  - 有 current、不同 Package → `update`
  - update 失败重试 → 对 `nextPackageId` 用 `update`
  - 回滚 → 对 `currentPackageId` 用 `run`
- 未授权的 Client Package 返回 `awaiting-approval`；单勾只授权当前 Package，双勾授权同插件后续版本。
- 技术失败后：读失败版源码与诊断 → 重新 list/query 相关 Provider → 在同一 Plugin 下 define 新 Package（别覆盖旧包）→ 用正确 mode 重跑。

## 六、常见失败对照
| 现象 | 先查 |
| --- | --- |
| `service "x" is not declared` | 是否用了 `ctx.x` 却没 `inject`；改用 `ctx.get` 判空或声明硬依赖 |
| `cannot get property "timer" without inject` | 查 timer 服务并 `inject: ['timer']` |
| Client 解析失败 | 是否用了 JSX / TS / import / 不存在的全局 |
| Slot 注册失败 | 是否查过实时子树、Slot 是否存在、options/key/selector 是否符合协议 |
| UI 加载但页面报错 | 看 `client-render` 诊断与堆栈，define 新 Package 修复 |
| `host.call` 失败 | Host handler 名、当前 pluginRunId、JSON 参数、内部真实服务依赖 |

## 七、编辑 Agent 预设（editing-cordis-compositions）
- 预设 = 一个目录：`agent.cordis.yml`（必须）+ `preset.yml`（显示元数据 name/description）。
- 本地自建预设位置：`${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/`。
- 两个平面：
  - **Host composition**：注册表本身（tools/systemPrompt/agents/agent-loop/sessions）、跨会话能力、沙箱审批、模型路由、子代理注册表。
  - **Agent preset**：单个会话对上述注册表的贡献（工具插件、人格与提示段、压缩策略）。
- **对外发布服务的行不能裸放在预设里**：必须在带 `isolate` realm 的 group 内，否则第二个会话挂载时冲突。
  - `isolate: { 服务名: true }` 表示每个挂载会话私有；字符串标签则合并共享 realm。
  - 只消费宿主能力的行不要包 realm，否则解析不到。
- 用 `ctx.agentPresets` 服务：`list()` / `read(id)` / `copy(from,id,name?)` / `resolve(id)` / `standingKeyFor(id)`。
- 唯一授权写入是 `copy()`；之后改文件可能触发沙箱写入审批。
- 校验用 `standingKeyFor(id)` 做挂载校验，不要只看 roster 的 `broken` 字段。
- 禁用项：绝不改动部署自带的预设（standard/code/minimal/cordis），要改就复制一份再改。

## 八、现成可参考的预设
qzy 机器上已有：
- `C:\Users\qzy\.dsh\.agent-presets\hoi4-mod`
- `C:\Users\qzy\.dsh\.agent-presets\teyvat-hoi4`

两者都带 cordis-plugin-development / editing-cordis-compositions / hoi4-modding 技能，可作为新预设的复制来源。

## 九、会话用哪个预设：默认值 + 热重载的两个坑（2026-09-12 实测）

### 9.1 `sessionController.create()` 不传 `agentPreset` 就吃宿主默认预设

`SessionCreateRequest = { workspaceId?, cwd?, sessionId?, agentPreset? }`，四个字段全可选。
省略 `agentPreset` 时，会话用 `$DSH_HOME/settings.yaml` 里的 **`agent-presets.default`**。
本机那个值是 `teyvat-hoi4`（提瓦特黎明 HOI4 项目专用 persona）——

**后果**：任何「外部事件 → 拉起会话」的插件（本项目的桥接就是）如果不显式指定预设，拉起的
会话全被 HOI4 项目 persona 接管：每回合强制先读 `E:\teyvatdaybreak\PROJECT_RULES.md`、
SKILL 索引、加载 `teyvat-hoi4` skill。跟桥接任务毫无关系，纯烧 token。
实测 4 条桥接会话的 session header 全是 `"agentPreset":"teyvat-hoi4"`。

**会话实际用的预设存在 session header 里**（`$DSH_HOME/sessions/<cwd 桶>/<sessionId>/session.v3.jsonl.zstd`
的第一行，zstd 压缩，`zlib.zstdDecompressSync` 解）：

```json
{"type":"session","version":3,"id":"session-…","cwd":"E:\\project\\dsh-funa-bridge",
 "isSeeded":false,"delegationDepth":0,"agentPreset":"teyvat-hoi4"}
```

**修法**：插件里显式传 `agentPreset`（本项目：单条指令 `preset` 字段 > 行配置
`dispatchPreset` > 宿主默认）；只想改某个部署的行为就写行配置覆盖，别动全局
`agent-presets.default`（那是 qzy 日常手开会话要用的）。

预设花名册服务 `ctx.agentPresets.list()` 返回 `{ presets: [{id, trust, isDefault, name?, description?,
broken?}], authorable }`；`create()` 遇到不存在的预设抛 `agent-preset/not-found`（错误详情里
`available` 列出可用 id）。校验与否要看情况：**「读不到花名册」和「预设不存在」是两回事**，
前者不该拦，后者才回退。

### 9.2 行配置覆盖的语法：`{ id, ...overrides }`

`cordis.patch.yml` 的 patch 条目在 `dsh-app-boot` 的 `applyEntryPatches()` 里这样落地：

```js
const { id, insert, name, ...overrides } = patch
if (insert) { …插到 id 指定的 group / 追加到顶层… ; continue }
const target = entryMap.get(id)          // id 不存在 → 警告并跳过
if (name && name !== target.name) { …跳过… }
for (const [key, value] of Object.entries(overrides)) target[key] = value
```

所以「按 id 改一行的配置」写成：

```yaml
- id: dsh-funa-bridge
  config:
    dispatchPreset: standard
```

注意两点：**overrides 是整块替换该行的 `config`**（不与 bundle 层合并，写就把这一行的配置写全）；
patch 层顺序 = 各 bundle 的 `dsh.bundle.patch` → profile 自己的 `cordis.patch.yml`（后者能覆盖前者）。

### 9.3 `patchReload: live` 在 Desktop 上不等于「热生效」

`dsh-app-boot` 的热重载入口是 `watchUserPatches(ctx, …)`，第一件事就是：

```js
const hmr = ctx.get('hmr')
if (hmr === undefined) throw new Error('… user patch-layer watching requires the Cordis HMR service')
```

而 `dsh-base` 里 `hmr` 那一行是 **`disabled: true`**（注释说 CLI launcher 有自己的 watch-only
回退，所以不需要它）。结果：**DSH Desktop 下改 `cordis.patch.yml` 不会热生效**，实测改完 34 秒后
拉起的会话仍是旧预设、`bridge_status.json` 也没变成新结构 —— 要**重启 dsh** 才生效。
（`desktop` profile 的 `package.json` 里虽然写着 `patchReload: "live"`。）

判定「重启后新代码 + 新配置都生效了」的懒人办法：让插件把关键配置写进状态文件
（本项目 `cache/bridge_status.json` 的 `dispatch` 块），一眼就能看，不用真去拉一个会话。

