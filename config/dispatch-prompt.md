【桥接指令 {{id}}】来自用户，经闸门转达。

{{content}}

请按桥接流程处理这条指令：
1. 先调用 bridge_claim，id = {{id}}（认领，把状态改成 running）；
2. 执行上面的指令内容；
3. 完成后调用 bridge_complete，id = {{id}}，result 写完整结果，summary 写一句话摘要。
   每次完成都必须汇报，不许默默结束。

补充说明：
- 结果写进 outbox/<id>.json 就行，不要自己想办法直接给用户发消息，交付给闸门、由它转述。
- 本次会话：模式 {{preset}}，工作区 {{workspace}}，信息来源标记 {{source}}。
