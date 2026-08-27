import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
const root = process.cwd();
const forbidden = [/console\.log\([^\n]*(?:key|cap|token|secret|plaintext|state)/i, /Authorization\s*:\s*[^\n]*console/i];
const files = [];
const visit = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', 'target', '.git'].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) visit(path);
    else if (/\.(ts|mjs|rs)$/.test(entry)) files.push(path);
  }
};
visit(root);
const violations = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const pattern of forbidden) if (pattern.test(text)) violations.push(`${file}: ${pattern}`);
}
if (violations.length) { console.error(violations.join('\n')); process.exit(1); }
console.log(`Lint policy passed for ${files.length} source files.`);
