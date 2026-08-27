import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const root = process.cwd();
mkdirSync(join(root, '.tools'), {recursive: true});
const tools = [
  ['cargo-audit', '0.21.2'],
  ['cargo-deny', '0.18.3']
];
for (const [name, version] of tools) {
  const result = spawnSync('cargo', ['install', '--locked', '--version', version, '--root', '.tools', name], {cwd: root, stdio: 'inherit'});
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('Extended audit tools installed under .tools/. cargo-fuzz remains an opt-in nightly tool until the hardening gate.');
