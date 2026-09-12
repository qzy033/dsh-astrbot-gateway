# AstrBot 侧调研笔记（Funa 本体）

## 运行环境
- 根目录：`C:\Users\qzy\.astrbot`
- 数据目录：`C:\Users\qzy\.astrbot\data`
  - `plugins\`        已安装插件
  - `config\`         各插件配置
  - `data_v4.db`      主数据库
  - `workspaces\`     Agent / 工具工作区（Funa 当前工作区在此）
  - `skills\`         技能
  - `plugin_data\`、`plugins_data\`  插件数据
  - `webchat\`        网页聊天
- Funa 与 qzy 当前会话：私聊 session `Funa_FriendMessage_3582167749`

## 模型配置（cmd_config.json）
- deepseek：`https://api.deepseek.com/`
- ollama：`http://127.0.0.1:11434/v1`
- 嵌入模型：qwen3-embedding:4b

## 已安装插件（data\plugins）
- astrbot_plugin_apis
- astrbot_plugin_gpt_sovits（语音合成）
- astrbot_plugin_hapi_connector
- astrbot_plugin_livingmemory（长期记忆）
- astrbot_plugin_music
- astrbot_plugin_portrayal（人物画像）
- astrbot_plugin_private_companion
- astrbot_plugin_proactive_chat（主动对话）
- astrbot_plugin_qqadmin
- astrbot_plugin_self_learning
- astrbot_sowing_discord

## Funa 现有能力（可直接用）
- 通过 `send_message_to_user` 主动向 qzy 发文本/图片/语音/视频/文件。
- 执行 shell 与 Python，读写文件。
- 通过 `future_task` 创建定时任务（可做周期轮询）。

## 被外部（dsh）触发的可能路径（待深入确认）
1. 在 AstrBot 侧写 Python 插件，注册一个本地 HTTP 路由，dsh 调用后由插件推消息给 qzy。
2. AstrBot 侧只读文件缓存区，由 Funa 定时轮询转发。
3. 复用现有 connector 类插件（hapi_connector 当前 endpoint 为空，未配置）。

## 待确认
- AstrBot 插件注册 HTTP 路由的确切方式与可用端口。
- 从插件向指定私聊会话发送消息的 API 名称与调用方式。
- 是否需要鉴权 / 是否只监听 127.0.0.1。
