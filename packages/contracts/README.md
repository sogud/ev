# @ev/contracts

EV Desktop 与 EV Browser 之间的稳定消息契约。

- 所有外部输入先通过 Zod schema 验证。
- 变更优先增加可选字段，不修改或删除现有字段。
- `EV_PROTOCOL_VERSION` 只在不兼容变更时递增。
- 这里只保存 wire contract，不放 Desktop 或浏览器实现。
- Browser actions 保持最小权限，不提供任意 `eval`。
