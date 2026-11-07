# AstrBot 侧插件已搬到独立仓库

这里**不再放插件源码**。AstrBot 侧插件（大肥鱼桥）现在住在：

**<https://github.com/qzy033/astrbot_plugin_dsh_gateway>**

- 那个仓库的**根目录就是插件本体**（`metadata.yaml`、`main.py`、`_conf_schema.json`、`README.md`、`logo.png`），
  所以 AstrBot 面板里填干净地址就能装，插件市场也才能收录；
- 安装、改代码、提 issue 都去那边；
- 本目录只保留这份说明，避免有人改错地方（改了本目录不会生效）。

## 为什么分开

AstrBot 从仓库装插件时要求**仓库根目录**有 `metadata.yaml`，而主仓库根目录放的是 DSH 侧项目本体
（`plugin/`、`docs/` 等），两者无法塞进同一个根。早期用过 `git subtree split` 推分支 +
`/tree/astrbot-plugin` 地址的绕法，但插件市场的 CI 只 clone 主仓库、只认根目录，分支法骗不过市场，
所以 2026-09-13 把插件本体迁到了独立仓库。

详细来龙去脉见 [`docs/PROJECT-MEMORY.md`](../docs/PROJECT-MEMORY.md#2-两个-github-仓库重点)，
安装说明见 [`docs/install-astrbot.md`](../docs/install-astrbot.md)。

## 本地开发

需要同时改两侧时，把插件仓库 clone 到任意目录（建议 `E:\project\astrbot_plugin_dsh_gateway`），
改那份、提交到插件仓库；主仓库这边只维护 DSH 侧与文档。

```powershell
git clone https://github.com/qzy033/astrbot_plugin_dsh_gateway.git E:\project\astrbot_plugin_dsh_gateway
```
