/**
 * Task title derivation: truncate the first message; when the first message is
 * XML/markup or a bare URL, fall back to the first plain-text line, else the
 * "New task" placeholder. Settled in wayfinder ticket 0001.
 */
export function taskTitleFromPrompt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return 'New task';
  const isUrl = /^https?:\/\/\S+$/i.test(flat);
  const startsWithMarkup = flat.startsWith('<');
  if (!isUrl && !startsWithMarkup) return flat.slice(0, 42);

  const plainLine = text
    .split('\n')
    .map(line => line.trim())
    .find(line => line && !line.startsWith('<') && !/^https?:\/\//i.test(line));
  const fallback = plainLine ? plainLine.replace(/\s+/g, ' ') : 'New task';
  return fallback.slice(0, 42);
}
