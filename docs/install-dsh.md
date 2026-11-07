# DSH 侧安装（手动版）

这份文档是给**人**看的：把 `dsh-astrbot-gateway` 挂进 DSH 的 profile，让它能读写桥接目录、
按 inbox 里的指令自动拉起会话、把结果写回 outbox。

> 只想快速装完：看[三句话版](#三句话版)；想搞清楚每一步在做什么：从第三章顺序读。
> 如果你更愿意让 DSH 里的 AI 代劳，本章末尾有[给 AI 的附录](#附录给-ai-的版本)。

## 三句话版

1. 在 profile 目录执行 `pnpm add dsh-astrbot-gateway@0.7.0`；
2. 把 `"dsh-astrbot-gateway"` 加进该 profile `package.json` 的 `dsh.profile.bundles`；
3. 在 `cordis.patch.yml` 里按 `- id:` 写配置（`root` / `dispatchCwd` / `dispatchPromptFile` 指向桥接目录），
   重启 DSH。

---

## 一、先确认前置

1. DSH 桌面端能正常启动，profile 目录在 `%USERPROFILE%\.dsh\profiles\` 下，
   常见的两个是 `web` 和 `desktop`。**桌面端用 `desktop`**，命令行/Web 版用 `web`。
2. `node` 与 `pnpm` 可用：`node -v`、`pnpm -v` 都能出版本号。
3. AstrBot 侧已经装好「大肥鱼桥」并填了「转达目标账号」（没有也不影响装 DSH 侧，
   只是装完还没闭环；`bridge_status.json` 的 `hint` 会提示）。

本机路径示例（换成你自己的）：

```
<PROFILE_DIR> = C:\Users\你的用户名\.dsh\profiles\desktop
<桥接目录>    = C:\Users\你的用户名\dsh-astrbot-gateway
```

---

## 二、装插件包

### 方式 A：从 npm 装（推荐）

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add dsh-astrbot-gateway@0.7.0
```

装完确认 `<PROFILE_DIR>\node_modules\dsh-astrbot-gateway\` 存在。

> 先跑 `npm view dsh-astrbot-gateway version` 看 npm 上有没有 0.7.0；
> 没到就用方式 B（仓库源码），功能一样。

### 方式 B：从仓库源码装

先把本仓库（或 `plugin/dsh-astrbot-gateway/` 目录）放到任意位置，路径别带中文和空格。
pnpm 对 `file:` 依赖是**复制**，不是软链，所以改完源码必须重装（方式 B 的脚本会处理）。
把插件目录的绝对路径记作 `<PLUGIN_DIR>`。

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "file:E:/project/dsh-funa-bridge/plugin/dsh-astrbot-gateway"
```

### 方式 C：用安装脚本（会自动改 profile）

```powershell
cd E:\project\dsh-funa-bridge\plugin\dsh-astrbot-gateway
# 先 dry-run 看看会改什么
powershell -ExecutionPolicy Bypass -File tools\install.ps1 `
  -ProfileDir "$env:USERPROFILE\.dsh\profiles\desktop"
# 确认无误再执行
powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Apply `
  -ProfileDir "$env:USERPROFILE\.dsh\profiles\desktop"
```

脚本会：检查 profile 里有没有重复 insert → 跑离线自测和工具 schema 校验 → 登记 `file:` 依赖 →
把 `dsh-astrbot-gateway` 加进 `bundles`。改 `package.json` 前自动备份，可重复执行。

> 方式 C 也可以用在 npm 装好之后，只让它补 `bundles`（脚本是幂等的）。

---

## 三、把插件挂进 profile

打开 `<PROFILE_DIR>\package.json`，确认两处：

```json
{
  "dependencies": {
    "dsh-astrbot-gateway": "^0.7.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-astrbot-gateway"
      ]
    }
  }
}
```

`bundles` 数组末尾加上 `"dsh-astrbot-gateway"`，插件才会被挂载。
改完在该目录执行一次：

```powershell
pnpm install
```

---

## 四、写插件配置

编辑 `<PROFILE_DIR>\cordis.patch.yml`，在末尾加：

```yaml
- id: dsh-astrbot-gateway
  config:
    root: C:\Users\你的用户名\dsh-astrbot-gateway\cache
    pollMs: 4000
    autoDispatch: true
    dispatchRetryMs: 60000
    runningTimeoutMs: 1800000
    dispatchCwd: C:\Users\你的用户名\dsh-astrbot-gateway
    dispatchPreset: standard
    dispatchPromptFile: C:\Users\你的用户名\dsh-astrbot-gateway\config\dispatch-prompt.md
    reuseSession: true
    source: dsh
    uplinkMode: off
```

三个必须按实际环境改的地方：`root`、`dispatchCwd`、`dispatchPromptFile`。
其余键都可以删掉，删掉就用默认值。

### 两条硬规矩

1. **不要写 `- insert:`**。这是 bundle 插件，进了 `bundles` 就已经被插入一次；
   profile patch 里再 `insert` 同一个 id，DSH 启动直接抛：

   ```
   dsh-plugin-desktop: duplicate loader entry id "dsh-astrbot-gateway" in the composed profile
   ```

   然后进恢复模式。profile patch 只做「按 id 覆盖 config」。
2. **`config` 是整块替换**这个插件的配置；写了就写全你想生效的键。

> 为什么默认 `dispatchPreset: standard`：DSH 的宿主默认预设可能是你自己项目用的
> （比如 HOI4 项目 persona）。桥接会话不需要那套规则，固定 `standard` 更干净。
> 单条指令仍可用 inbox JSON 里的 `preset` 覆盖。

---

## 五、重启 DSH

关掉 DSH 再启动（不是最小化）。bundle 插件 + ESM 缓存，**必须重启**才会加载新代码和新配置。

**你应该看到**：正常进主界面、没进恢复模式、侧边栏会话列表正常。

---

## 六、验证

1. 看 `<桥接目录>\cache\bridge_status.json`：

   - `poller` 是定时器名（不是 `none`）；
   - `dispatch.autoDispatch` 是 `true`；
   - `dispatch.reuseSession` 是 `true`；
   - `uplinkMode` 是 `off`。

2. 往 `<桥接目录>\cache\inbox\` 丢一个 JSON（字段照 [message-rules.md](message-rules.md) 写，
   `status` 写 `pending`）。等一轮轮询（默认 4 秒），看它有没有被认领、有没有自动拉起会话。
3. 会话跑完应该往 `<桥接目录>\cache\outbox\` 写结果 JSON，`status` 是 `done` 或 `failed`。
4. 结果落盘后 AstrBot 侧会把闸门叫醒，由它把结果讲给用户。这个环节 DSH 侧不用做任何事。

### 手动跑一遍工具（不依赖自动拉起）

在 DSH 会话里让 agent 调用：

```
bridge_inbox  → bridge_claim { id } → 执行 → bridge_complete { id, result, summary }
```

`bridge_complete` 会写 outbox 并把摘要推给闸门。

---

## 七、卸载与回滚

1. 从 `<PROFILE_DIR>/package.json` 的 `bundles` 里去掉 `dsh-astrbot-gateway`；
2. 在 `<PROFILE_DIR>` 执行 `pnpm remove dsh-astrbot-gateway`；
3. 删掉 `cordis.patch.yml` 里 `- id: dsh-astrbot-gateway` 那一段；
4. 重启 DSH。

**DSH 自带恢复模式**：插件挂不上会自动回滚 profile，但回滚要跑 pnpm，**离线时连恢复都会失败**，
所以动 profile 之前先确认网络与 pnpm 都正常。万一进了恢复模式，手动删 `bundles` 和 patch 里那段再启动。

---

## 八、答疑

| 现象 | 原因 / 做法 |
| --- | --- |
| 报 `duplicate loader entry id` | `bundles` 和 profile 自己的 `cordis.patch.yml` 里同时插了它，留一处（patch 里只按 id 覆盖 config） |
| 起了但什么都不做 | 看 `pollMs` 是不是 0（0 = 关掉轮询） |
| 一直显示 running | 会话被中断了，认领后超过 `runningTimeoutMs` 会被自动回收成 `failed` |
| 拉起失败 | 只在「宿主没有会话服务」或「预设名写错」时发生，看 DSH 日志里 `[dsh-gateway]` 前缀那几行 |
| 用户说没收到回报 | 先确认 AstrBot 侧装了「大肥鱼桥」并且填了「转达目标账号」，再看 `outbox/` 里有没有对应结果文件 |
| 改完代码没反应 | pnpm 对 `file:` 是复制；用 `install.ps1 -Apply` 重装，或删 `node_modules\dsh-astrbot-gateway` 再 `pnpm install` |
| 改完配置没反应 | bundle 插件 + ESM 缓存，**必须重启 DSH**；profile patch 不会热重载 |
| npm 版本和本地目录不一致 | 二选一：用 `file:` 指本地，或用 npm 版本号；别混装 |
| 桥接会话被 HOI4 预设接管 | 没设 `dispatchPreset: standard` |
| 直通里发 `dsh/2` 没换会话 | DSH 侧插件低于 0.7.0，不认 `newSession` |

---

## 附录：给 AI 的版本

如果你确实想让 DSH 里的 AI 代劳，把下面这段发给它即可（内容就是本文的浓缩）：

```
请把 dsh-astrbot-gateway 装进当前 DSH 的 profile：
1. 确认 node/pnpm 可用；
2. 在 profile 目录执行 pnpm add dsh-astrbot-gateway@0.7.0；
3. 把 "dsh-astrbot-gateway" 加进该 profile package.json 的 dsh.profile.bundles；
4. 在 cordis.patch.yml 末尾按「- id: dsh-astrbot-gateway」+ config 写配置，
   root/dispatchCwd/dispatchPromptFile 指向桥接目录；不要写 insert；
5. 重启 DSH；
6. 检查 cache/bridge_status.json 的 poller / autoDispatch / reuseSession / uplinkMode；
7. 如果 AstrBot 侧还没装，告诉用户去面板装 astrbot_plugin_dsh_gateway 并填转达账号。
```

装完对用户说一句：

> 桥这边我装好了。你只要去 AstrBot 面板装一下「大肥鱼桥」，然后在它的配置里填上要转达给谁的
> QQ 号，重启一下就行，别的都不用管。
