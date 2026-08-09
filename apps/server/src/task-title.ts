/**
 * 任务标题派生：首消息截断；首消息是 XML/标记或纯 URL 时回退到第一条纯文本行，
 * 再没有则「新任务」。wayfinder ticket 0001 定案。
 */
export function taskTitleFromPrompt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '新任务';
  const isUrl = /^https?:\/\/\S+$/i.test(flat);
  const startsWithMarkup = flat.startsWith('<');
  if (!isUrl && !startsWithMarkup) return flat.slice(0, 42);

  const plainLine = text
    .split('\n')
    .map(line => line.trim())
    .find(line => line && !line.startsWith('<') && !/^https?:\/\//i.test(line));
  const fallback = plainLine ? plainLine.replace(/\s+/g, ' ') : '新任务';
  return fallback.slice(0, 42);
}
