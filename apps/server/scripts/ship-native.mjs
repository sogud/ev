import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 把 better-sqlite3 原生依赖链拷进 dist-server/node_modules，
// 使打包 entry 在任意 node 运行时下可解析（打包产物旁没有 workspace node_modules）。
const req = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../desktop/dist-server/node_modules');
mkdirSync(out, { recursive: true });

const ship = (pkg, dir) => {
  rmSync(join(out, pkg), { recursive: true, force: true });
  cpSync(dir, join(out, pkg), { recursive: true, dereference: true });
};

const sqliteDir = dirname(req.resolve('better-sqlite3/package.json'));
const sqliteReq = createRequire(join(sqliteDir, 'package.json'));
const bindingsDir = dirname(sqliteReq.resolve('bindings/package.json'));
ship('better-sqlite3', sqliteDir);
ship('bindings', bindingsDir);
try {
  const bindingsReq = createRequire(join(bindingsDir, 'package.json'));
  ship('file-uri-to-path', dirname(bindingsReq.resolve('file-uri-to-path/package.json')));
} catch {
  // 新版 bindings 不再依赖 file-uri-to-path，可缺省。
}
console.log('native deps shipped to dist-server/node_modules');
