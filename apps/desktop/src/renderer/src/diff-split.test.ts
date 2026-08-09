import { describe, expect, it } from 'vitest';
import { splitDiffByFile } from './diff-split';

const sample = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 line
+added
 line
diff --git a/docs/b.md b/docs/b.md
new file mode 100644
--- /dev/null
+++ b/docs/b.md
@@ -0,0 +1 @@
+hello
`;

describe('splitDiffByFile（ticket 0005 diff-first）', () => {
  it('按文件切分并保留段头', () => {
    const map = splitDiffByFile(sample);
    expect([...map.keys()]).toEqual(['src/a.ts', 'docs/b.md']);
    expect(map.get('src/a.ts')).toContain('+added');
    expect(map.get('docs/b.md')).toContain('+hello');
  });

  it('空 diff → 空 map', () => {
    expect(splitDiffByFile('').size).toBe(0);
  });
});
