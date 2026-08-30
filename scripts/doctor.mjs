import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import net from 'node:net';

const root = process.cwd();
const failures = [];
const command = (name, args) => {
  const result = spawnSync(name, args, {cwd: root, encoding: 'utf8'});
  return {status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? ''};
};
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

check('Node engine', Number.parseInt(process.versions.node, 10) >= 24 && Number.parseInt(process.versions.node, 10) < 26, process.version);
check('npm version', command('npm', ['--version']).status === 0, command('npm', ['--version']).stdout.trim());
check('Rust toolchain', command('rustc', ['--version']).status === 0, command('rustc', ['--version']).stdout.trim());
const targets = command('rustup', ['target', 'list', '--installed']);
check('wasm32 target', targets.stdout.split(/\s+/).includes('wasm32-unknown-unknown'), targets.stdout.trim());
check('wasm-bindgen CLI', existsSync(join(root, '.tools', 'bin', 'wasm-bindgen')), '.tools/bin/wasm-bindgen 0.2.127');
check('workspace dependencies', existsSync(join(root, 'node_modules', 'typescript')), 'node_modules/typescript');
check('Playwright package', existsSync(join(root, 'node_modules', '@playwright', 'test')), '@playwright/test');
check('built renderer', existsSync(join(root, 'dist', 'controller', 'runtime', 'renderer')), 'run npm run build after bootstrap');

const temp = mkdtempSync(join(tmpdir(), 'smallframe-doctor-'));
try {
  const probe = join(temp, 'probe.txt');
  writeFileSync(probe, 'doctor');
  check('temporary filesystem', existsSync(probe));
} finally {
  rmSync(temp, {recursive: true, force: true});
}

const ports = [4173, 8787, 8790, 8791];
const probePort = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.once('listening', () => server.close(() => resolve(true)));
  server.listen(port, '127.0.0.1');
});
for (const port of ports) check(`loopback port ${port}`, await probePort(port), 'available');

console.log(`Environment=local Controller=http://app.localhost:4173 API=http://api.localhost:8787 Canary=http://localhost:8790/ws://localhost:8791`);
if (failures.length) process.exit(1);
