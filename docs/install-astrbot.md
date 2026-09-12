# AstrBot 侧安装

## 三句话版

1. 面板装插件，地址填 `https://github.com/qzy033/dsh-astrbot-gateway/tree/astrbot-plugin`。
2. 配置页在「转达目标账号」里填你要转达给的 QQ 号。
3. 桥接目录留空，它会和 DSH 侧默认目录自动对齐，不用手工填。

装完在浏览器打开 `http://127.0.0.1:6185/api/plug/astrbot_plugin_dsh_gateway/ping`，看到 `pong` 就说明通道通了。

只装这一侧也很安全：dsh 那边还没装的时候，它就是个安静的本机接口，不报错也不刷屏，等 dsh 侧装好自己就接上了。

下面是想自己改路径、或者手动装的人的详细版。

AstrBot 的插件就是一个文件夹，装好以后出现在 `data/plugins/` 下面。
本仓库的 AstrBot 插件在 `astrbot-plugin/astrbot_plugin_dsh_gateway/`。

## 方式一：插件市场

等插件上架后，在面板的插件市场里搜 `astrbot_plugin_dsh_gateway`，点安装并启用就行。

## 方式二：从仓库一键装

面板 → 插件管理 → 安装插件 → 仓库地址填：

```
https://github.com/qzy033/dsh-astrbot-gateway/tree/astrbot-plugin
```

为什么要带 `/tree/astrbot-plugin`：AstrBot 装插件时会先整包下载仓库，再要求**仓库根目录**有
`metadata.yaml`。本仓库是「桥两边放一起」的结构，仓库根放的是项目本体，所以单独用一个
`astrbot-plugin` 分支，让它的根目录就是插件本体。装完 AstrBot 会按 `metadata.yaml` 里的
`name` 把目录改名成 `astrbot_plugin_dsh_gateway`。

如果你只想手动维护，也可以直接把 `astrbot-plugin/astrbot_plugin_dsh_gateway` 推成自己的
插件仓库，仓库根放同一批文件即可。

## 方式三：压缩包上传

把 `astrbot-plugin/astrbot_plugin_dsh_gateway` 里的文件打成 zip，注意 zip 的**第一层就直接是**
`metadata.yaml`、`main.py`、`_conf_schema.json`、`README.md`，不要再套一层目录。
面板 → 插件管理 → 上传插件。

## 方式四：手动放

把 `astrbot-plugin/astrbot_plugin_dsh_gateway` 整个文件夹拷进 `data/plugins/`，重启 AstrBot。

## 装完必须填的配置

面板 → 插件管理 → 大肥鱼桥 → 配置，至少填两项：

| 配置项 | 填什么 |
| --- | --- |
| 桥接项目目录 `project_dir` | 两边共用的那个目录，缓存区 `cache/` 在它下面 |
| 转达目标账号 `target_id` | 消息要转达给谁，私聊就填 QQ 号 |

其余 11 项都有默认值，见插件 `README.md` 里的配置项一览。
配置存在 `data/config/astrbot_plugin_dsh_gateway_config.json`。

## 验证

1. 插件列表里出现「大肥鱼桥」并且是启用状态；
2. `GET /api/plug/astrbot_plugin_dsh_gateway/ping` 返回 `pong`，说明路由挂上了；
3. 项目目录下出现 `cache/bridge_access.json`，说明自签令牌写出来了。

## 卸载

面板里点卸载即可；配置文件和数据目录默认保留，要一起删就在卸载对话框里勾上。
