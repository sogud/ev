/**
 * Split a repo-wide unified diff into path -> per-file diff hunks (ticket 0005 diff-first).
 * Segment headers are `diff --git a/<path> b/<path>`; the b-side path is used
 * (good enough for spaces and renames).
 */
export function splitDiffByFile(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!diff) return out;
  const sections = diff.split(/^(diff --git .*)$/m);
  // split with a capture group: [leading empty, header1, body1, header2, body2, ...]
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
