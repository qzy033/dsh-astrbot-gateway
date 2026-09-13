# DSH 侧安装（写给 AI 的说明书）

这份文档是给 DSH 那边帮你干活的 AI 看的，照着一节一节做就行，不需要人类的经验。
目标：把 `dsh-astrbot-gateway` 挂进 DSH 的 profile，让它能读写桥接目录、按 inbox 里的指令
自动拉起会话、把结果写回 outbox。

## 零、先确认前置

1. DSH 桌面端能正常启动，profile 目录在 `%USERPROFILE%\.dsh\profiles\` 下；
   默认有两个：`web` 和 `desktop`。哪个会被启动就装哪个，两个都装也可以。
2. `node` 与 `pnpm` 可用，`pnpm -v` 能出版本号。DSH 的插件安装靠 pnpm。
3. 拿到插件源码目录，下面统一叫它 `<PLUGIN_DIR>`。它里面应该有 `package.json`、`lib/index.js`、
   `cordis.patch.yml`、`tools/install.ps1`。放哪都行，路径别带中文和空格。

## 一、把插件登记进 profile

编辑 `<PROFILE_DIR>/package.json`，两处要改：

```json
{
  "dependencies": {
    "dsh-astrbot-gateway": "file:<PLUGIN_DIR>"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-astrbot-gateway"
      ]
    }
  }
}
```

`dependencies` 里的 `file:` 后面写 `file:` + 插件目录的绝对路径，Windows 写法示例
`file:E:/somewhere/dsh-astrbot-gateway`。
`bundles` 数组末尾加上插件名，插件才会被挂载。

然后在 `<PROFILE_DIR>` 里执行：

```
pnpm install
```

装完确认 `<PROFILE_DIR>/node_modules/dsh-astrbot-gateway` 存在。

### 也可以从 npm 装

不想拷源码目录的话，依赖写成 npm 包名即可：

```json
"dependencies": {
  "dsh-astrbot-gateway": "0.6.1"
}
```

再执行 `pnpm install`。npm 上现在发布的是 0.6.1，与 AstrBot 侧插件版本号对齐，功能和本地目录那份一致；
本地目录改过代码、或是拿到的就是最新源码，就用上面 `file:` 那种写法，别两边混用。

## 二、写插件配置

编辑 `<PROFILE_DIR>/cordis.patch.yml`，加一段：

```yaml
- id: dsh-astrbot-gateway
  config:
    root: <桥接目录>/cache
    pollMs: 4000
    autoDispatch: true
    dispatchRetryMs: 60000
    runningTimeoutMs: 1800000
    dispatchCwd: <桥接目录>
    dispatchPreset: standard
    dispatchPromptFile: <桥接目录>/config/dispatch-prompt.md
    source: dsh
    gatekeeper: 闸门
    uplinkMode: off
```

三个必须按实际环境改的地方：`root`、`dispatchCwd`、`dispatchPromptFile`。
其余键都可以删掉，删掉就用默认值。**patch 是整块替换这个插件的 config**，
写了就要写全你想生效的键。

同一个 profile 里**不要**再手写第二行同样的 `id`，DSH 组 profile 时会报
`duplicate loader entry id` 直接起不来。

## 三、重启 DSH

关掉 DSH 再启动，让它重新组合 profile。启动后确认没有进「恢复模式」。

## 四、验证

1. 看 `<桥接目录>/cache/bridge_status.json`：`poller` 应该是定时器名而不是 `none`，
   `autodispatch` 是 `true`，`uplinkMode` 是 `off`。
2. 往 `<桥接目录>/cache/inbox/` 丢一个 JSON，字段照 `docs/message-rules.md` 写，
   `status` 写 `pending`。等一轮轮询，看它有没有被认领、有没有自动拉起会话。
3. 会话跑完应该会往 `<桥接目录>/cache/outbox/` 写结果 JSON，`status` 是 `done` 或 `failed`；
4. 结果落盘后，AstrBot 侧插件会在三秒内把闸门叫醒，由它把结果讲给用户。所以这个环节你不用做任何事，
   也不要再往别处转发结果，更不要直发用户；只在 `cache/dsh_relay/` 里留下一份交付就够了。

## 五、卸载与回滚

1. 从 `<PROFILE_DIR>/package.json` 的 `bundles` 里去掉 `dsh-astrbot-gateway`；
2. 在 `<PROFILE_DIR>` 执行 `pnpm remove dsh-astrbot-gateway`；
3. 删掉 `cordis.patch.yml` 里那段配置；
4. 重启 DSH。

DSH 自带恢复模式：插件挂不上会自动回滚 profile，但回滚要跑 pnpm，**离线时连恢复都会失败**，
所以动 profile 之前先确认网络与 pnpm 都正常。

## 六、答疑

- 报 `duplicate loader entry id`：`bundles` 和 profile 自己的 `cordis.patch.yml` 里同时有它，
  留一处就行。
- 起了但什么都不做：看 `pollMs` 是不是 0，0 表示关掉轮询。
- 一直显示 running：会话被中断了，认领后超过 `runningTimeoutMs` 会被自动回收成 `failed`。
- 拉起失败：只在「宿主没有会话服务」或「预设名写错」时发生，看 DSH 日志里的
  `[dsh-gateway]` 前缀那几行。
- 用户说没收到回报：先确认 AstrBot 侧装了「大肥鱼桥」并且填了「转达目标账号」，
  再看 `<桥接目录>/cache/outbox/` 里有没有对应的结果文件。两边都正常时回报是秒级送达的，
  不需要用户催，也不需要你做额外动作。
- npm 版本和本地目录不一致：二选一，用 `file:` 指向本地目录，或者用 npm 上那个版本号，别混着装。

## 七、装完怎么跟用户说

DSH 侧不需要用户懂路径，配置都在 profile 里；但 AstrBot 侧那两步得用户自己点，跟他说：

> 桥这边我装好了。你只要去 AstrBot 面板装一下「大肥鱼桥」，然后在它的配置里填上要转达给谁的
> QQ 号，重启一下就行，别的都不用管。

如果用户想把消息转给群，就在配置里把消息类型改成群聊、账号填群号。
