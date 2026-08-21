# Spec — UI 声音状态设计 v1

状态：提案
日期：2026-08-21

声音是状态反馈的第二通道：强化交互、状态、导航、进度与结果的感知，
**永远补充而不替代**视觉/文字反馈。来源：[uisfx](https://uisfx.com)
（[github.com/romainsimon/uisfx](https://github.com/romainsimon/uisfx)，
代码 MIT、音频 CC0）——936 个音效 = 78 个语义 cue × 12 种声音风格，
零依赖约 12kB，`npm install uisfx`。

## 语义优先，不是装饰

先定义产品的语义 cue 表，再选声音，不按"好不好听"挑：

| 状态类别 | 典型 cue | EV 场景示例 |
| :--- | :--- | :--- |
| 确认/选择 | select, click, toggle | Fleet 页点 pane、sidebar 切换 |
| 成功 | success, done, complete | 任务完成、批量操作成功 |
| 失败 | error, fail, invalid | 操作失败、校验不过 |
| 进行中 | processing, loop-progress | runtime working、批量进度 |
| 需要注意 | alert, blocked, warn | **agent blocked 升级提醒**（最该有声音的地方） |
| 通知 | notify, message | intercom 简报到达 |

选定一个"声音风格"（uisfx 的 12 种 feel 之一）并全站统一——
换风格不改交互代码，这是语义化音效系统的核心价值。

## 设计规则

1. **默认安静**：声音总开关 + 分类开关放设置里；工具型产品默认只开
   "需要注意"类（blocked/error），其余用户自选。
2. **浏览器音频策略**：AudioContext 必须在用户手势后解锁；首次交互前
   静音降级，不报错。
3. **循环节制**：loop 只用于持续状态（processing），状态解除立即停；
   同一 cue 短间隔去重（300ms 内不重播）。
4. **音量纪律**：全部 cue 归一化响度；UI 音效峰值不超过系统提示音，
   叠加时自动压低（ducking）。
5. **无障碍**：声音不作为唯一信息通道；提供视觉等价物；尊重系统
   "减少动态效果/静音"偏好。
6. **一致性测试**：同一语义在不同页面必须同一 cue；风格切换后回归全部 cue。

## 集成形态

```ts
// 语义层与实现分离：产品代码只调语义
import { play } from 'uisfx';
play('success');              // 状态成功
play('blocked', { loop: false }); // 需要注意
```

声音状态进入产品的顺序建议：先 blocked/error 提醒（信息价值最高），
再 success/complete（情绪价值），最后 select/toggle（手感价值）——
宁缺毋滥，每加一个声音都要回答"它替代了什么误判风险"。
