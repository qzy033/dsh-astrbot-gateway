# 安装总览

两侧可以独立装，谁先装谁后装都不报错；要打通才有意义。

| 你想干的事 | 看哪份 |
| --- | --- |
| 在 DSH 那边装插件、配模式和工作区 | [install-dsh.md](install-dsh.md)，写给 AI 的，照做即可 |
| 在 AstrBot 面板装插件、填转达账号 | [install-astrbot.md](install-astrbot.md)，三句话就能装完 |

AstrBot 插件（大肥鱼桥）住在独立仓库 <https://github.com/qzy033/astrbot_plugin_dsh_gateway>：
面板插件市场搜 `astrbot_plugin_dsh_gateway`，或者插件管理 → 安装插件 → 仓库地址填这个干净地址（不带 `/tree/...`）。

## 为什么 AstrBot 侧不用配路径

两侧的默认桥接目录是同一个：`<用户主目录>/dsh-astrbot-gateway`，
缓存区就在它下面的 `cache/`。也就是说两边都留空时，天然指向同一个地方。
只有想把数据放到别处的用户才需要手工填目录，而且填的时候两边保持一致即可。

## 最短路径

1. 在 DSH 侧装好插件，配置里只要不动 `root`，就跟 AstrBot 侧默认对齐；
2. 去 AstrBot 面板装「大肥鱼桥」（插件市场搜 `astrbot_plugin_dsh_gateway`，或按上面那个仓库地址装），配置里填一个「转达目标账号」；
3. 重启 AstrBot，往 DSH 丢一句话试试，能在 QQ 上收到就通了。
