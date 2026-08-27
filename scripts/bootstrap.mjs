import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';

const root = process.cwd();
const run = (command, args) => {
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', env: process.env});
  if (result.status !== 0) process.exit(result.status ?? 1);
};

mkdirSync(join(root, '.tools'), {recursive: true});
run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
run('npm', ['exec', '--', 'playwright', 'install', 'chromium', 'firefox', 'webkit']);
console.log('Bootstrap complete. Repository-local tools are ready; no cloud credentials were touched.');
