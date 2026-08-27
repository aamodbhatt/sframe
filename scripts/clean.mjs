import {existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
const root = process.cwd();
const targets = ['dist', 'target', 'coverage', 'test-results', 'playwright-report', '.wrangler'];
console.log(`Removing only generated repository paths: ${targets.join(', ')}`);
for (const target of targets) {
  const path = join(root, target);
  if (existsSync(path)) rmSync(path, {recursive: true, force: true});
}
