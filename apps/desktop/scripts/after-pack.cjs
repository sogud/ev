// electron-builder prunes node_modules from extraResources sources inside the app dir,
// so ship the server's native modules (better-sqlite3) explicitly after packaging.
const { cpSync, existsSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  const source = join(context.packager.projectDir, 'dist-server', 'node_modules');
  if (!existsSync(source)) {
    throw new Error(`Missing ${source}; run the server build (ship-native) before packaging`);
  }
  const productName = context.packager.appInfo.productFilename;
  const resourcesDir =
    process.platform === 'darwin'
      ? join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources');
  const target = join(resourcesDir, 'server', 'node_modules');
  cpSync(source, target, { recursive: true });
  console.log(`after-pack: shipped server native modules to ${target}`);
};
