## 这里放「用户自己填」的东西

代码里不写死任何提示词、模式名、路径和账号，全都从配置来：

| 文件 | 谁读它 | 说明 |
| --- | --- | --- |
| `dispatch-prompt.md` | dsh 侧插件 | 自动拉起会话时投给那條会话的提示词模板，占位符见文件内 |
| `plugin.example.yml` | 你（手贴） | dsh 侧插件的全部配置项示例，含默认模式、工作区、轮询等 |
| `summary-prompt.md` | AstrBot 侧插件 | 「把消息总结成人话再转达」用的系统提示词，想改就填进插件配置的 summary_prompt |

dsh 侧插件找模板的顺序是：

1. 配置项 `dispatchPromptFile` 指定的文件；
2. `<桥接目录>/../config/dispatch-prompt.md`（就是本文件夹，装好后放在项目根下）；
3. 插件目录下的 `config/dispatch-prompt.md`；
4. 都没有就用内置的通用兜底模板。

模板占位符：`{{id}}` `{{content}}` `{{source}}` `{{gatekeeper}}` `{{preset}}` `{{workspace}}`。
