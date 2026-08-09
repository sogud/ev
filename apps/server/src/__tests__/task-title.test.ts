import { describe, expect, it } from 'vitest';
import { taskTitleFromPrompt } from '../task-title';

describe('taskTitleFromPrompt（ticket 0001 标题回退规则）', () => {
  it('普通首消息直接截断 42', () => {
    expect(taskTitleFromPrompt('修复登录页的报错')).toBe('修复登录页的报错');
    expect(taskTitleFromPrompt('a'.repeat(100))).toHaveLength(42);
  });

  it('XML 首消息回退到第一条纯文本行', () => {
    expect(taskTitleFromPrompt('<task>\n总结这个仓库\n</task>')).toBe('总结这个仓库');
  });

  it('纯 URL 首消息回退；URL+文本混合保留原文', () => {
    expect(taskTitleFromPrompt('https://example.com/x')).toBe('新任务');
    expect(taskTitleFromPrompt('https://example.com\n看看这个')).toBe(
      'https://example.com 看看这个'
    );
  });

  it('空消息 → 新任务', () => {
    expect(taskTitleFromPrompt('   \n ')).toBe('新任务');
  });
});
