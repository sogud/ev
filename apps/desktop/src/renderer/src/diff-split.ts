/**
 * 把整仓 unified diff 切成 path → 该文件 diff 段（ticket 0005 diff-first）。
 * 以 `diff --git a/<path> b/<path>` 为段头；取 b 侧路径（含空格/重命名场景够用）。
 */
export function splitDiffByFile(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!diff) return out;
  const sections = diff.split(/^(diff --git .*)$/m);
  // split 带捕获组：[前导空串, header1, body1, header2, body2, ...]
  for (let index = 1; index < sections.length; index += 2) {
    const header = sections[index];
    const body = sections[index + 1] ?? '';
    const match = / b\/(.+)$/.exec(header);
    if (!match) continue;
    const path = match[1];
    out.set(path, `${header}\n${body}`.trimEnd() + '\n');
  }
  return out;
}
