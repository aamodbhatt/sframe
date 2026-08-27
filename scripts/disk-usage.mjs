import {existsSync, statSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
const root = process.cwd();
const roots = ['node_modules', 'target', 'dist', '.tools', 'test-results', 'coverage'];
const size = (path) => {
  if (!existsSync(path)) return 0;
  const info = statSync(path);
  if (info.isFile()) return info.size;
  return readdirSync(path).reduce((sum, entry) => sum + size(join(path, entry)), 0);
};
for (const item of roots) console.log(`${item}\t${(size(join(root, item)) / 1024 / 1024).toFixed(1)} MiB`);
