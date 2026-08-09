# @ev/design-tokens

EV Desktop 与 EV Browser 共用的主题和密度 token。`theme.css` 是颜色、字体、间距、圆角、阴影和层级的唯一事实源。

支持：

- 跟随系统：不设置主题属性或 class
- 浅色：`data-theme="light"` 或 `.light`
- 深色：`data-theme="dark"` 或 `.dark`

组件只使用 `--ev-*` semantic tokens，不在业务样式中复制主题色。
