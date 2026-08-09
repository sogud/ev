# Wayfinder 本地 Markdown Tracker 约定

本目录是 EV Desktop UI 交互工作的 wayfinder local-markdown tracker。

- 地图：`desktop-ui-interaction-map.md`（等价 label：`wayfinder:map`），是唯一规范产物。
- Ticket：`tickets/NNNN-<slug>.md`，均为地图的子项。
- Ticket frontmatter：
  - `status`: `open` | `claimed` | `closed`
  - `type`: `research` | `prototype` | `grilling` | `task`
  - `hitl`: `true` | `false`
  - `assignee`: 空 = 未认领
  - `blocked-by`: 阻塞本 ticket 的编号列表；全部 closed 才算 unblocked
- Frontier：`status: open`、`assignee` 为空、且 `blocked-by` 全部 closed 的 ticket。
- 认领：先写 `assignee` 并把 `status` 置 `claimed`，再开始工作。
- 解决：在 ticket 内写 `## Resolution`，`status` 置 `closed`，并在地图
  `Decisions so far` 追加一行（名字 + 一行 gist + 链接）。
- 每个 session 最多解决一个 ticket。
