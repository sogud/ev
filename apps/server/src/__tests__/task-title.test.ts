import { describe, expect, it } from 'vitest';
import { taskTitleFromPrompt } from '../task-title';

describe('taskTitleFromPrompt (ticket 0001 title fallback rules)', () => {
  it('plain first message truncates at 42', () => {
    expect(taskTitleFromPrompt('修复登录页的报错')).toBe('修复登录页的报错');
    expect(taskTitleFromPrompt('a'.repeat(100))).toHaveLength(42);
  });

  it('XML first message falls back to the first plain-text line', () => {
    expect(taskTitleFromPrompt('<task>\n总结这个仓库\n</task>')).toBe('总结这个仓库');
  });

  it('bare URL first message falls back; URL+text mix keeps the original', () => {
    expect(taskTitleFromPrompt('https://example.com/x')).toBe('New task');
    expect(taskTitleFromPrompt('https://example.com\n看看这个')).toBe(
      'https://example.com 看看这个'
    );
  });

  it('empty message -> New task', () => {
    expect(taskTitleFromPrompt('   \n ')).toBe('New task');
  });
});
