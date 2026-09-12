# dsh-funa-bridge

让 **DeepSeek Harness（DSH）** 里的智能体，通过 **AstrBot** 的猫娘助手 **Funa**，和主人对话。

DSH 不再拥有直接给主人发消息的能力：它说的话一律先落进中转箱，由 Funa 用自己的口吻总结后转达。主人说的话，也由 Funa 筛选确认是给它的才放行。

```
┌──────────┐   ① 指令    ┌───────────────┐   ② 拉会话   ┌──────────────┐
│  主人 qzy │ ─────────▶ │  Funa（AstrBot）│ ──────────▶ │ DSH 智能体    │
│  （聊天） │ ◀───────── │  唯一的闸门     │ ◀────────── │  小鲸鱼       │
└──────────┘   ④ 转达    └───────────────┘   ③ 回报    └──────────────┘
                              ▲                              │
                              └────── cache/dsh_relay ◀──────┘
                                    （中转箱，唯一通道）
```

## 三个部分

| 部分 | 位置 | 干什么 |
| --- | --- | --- |
| AstrBot 插件 | `astrbot-plugin/astrbot_plugin_funa_bridge/` | 提供本地 HTTP 接口，接收 DSH 的消息，落进中转箱并立刻用 Funa 的口吻总结转达 |
| DSH 侧插件 | `plugin/dsh-funa-bridge/` | cordis 插件，负责任务派发、会话拉起、完成后回报 |
| 中转区 | `cache/` | 指令收件箱、结果发件箱、中转箱、访问令牌，运行时自动生成 |

## 目录

```
dsh-funa-bridge/
├── astrbot-plugin/astrbot_plugin_funa_bridge/   # AstrBot 侧（Python）
├── plugin/dsh-funa-bridge/                      # DSH 侧（cordis 插件）
├── docs/                                        # 设计笔记、消息规则
├── tools/                                       # 台账工具、配置校验脚本
├── cache/                                       # 运行期缓存，勿提交
└── README.md
```

## 安装

### 一、AstrBot 侧

把 `astrbot-plugin/astrbot_plugin_funa_bridge/` 整个目录复制进 AstrBot 的插件目录：

```
<AstrBot 数据目录>/data/plugins/astrbot_plugin_funa_bridge/
```

重启 AstrBot。插件会在加载时用 Dashboard 的密钥自签一枚长期令牌，写进 `cache/bridge_access.json`，供 DSH 侧读取。

接口（仅监听本机，带令牌鉴权）：

```
GET  /api/plug/astrbot_plugin_funa_bridge/ping    健康检查
POST /api/plug/astrbot_plugin_funa_bridge/send    投递消息，交给 Funa 总结转达
```

### 二、DSH 侧

把 `plugin/dsh-funa-bridge/` 放进 DSH 的插件目录，重启 DSH。它会读取上一步生成的访问文件，按配置派发任务。

## 工作流程

1. 主人在聊天里说要给 DSH 的话，Funa 先判断是不是给它的，是就投进收件箱；
2. DSH 侧插件发现新指令，按指令点名的模式拉起会话执行；
3. 执行完写回发件箱，同时把结果推给中转箱；
4. AstrBot 插件收到后立刻用 Funa 的口吻总结，推给主人，文件归档。

任务完成一定会回报，不需要主人追问。

## 安全说明

- `cache/` 里的 `bridge_access.json` 含自签令牌，**已在 .gitignore 中排除**，切勿提交或外传；
- AstrBot 的接口只绑定回环地址，请勿把端口暴露到公网；
- DSH 智能体具备本机文件读写与命令执行能力，等同于授权它操作电脑，请只在可信环境启用。

## 许可

MIT，见 LICENSE。
