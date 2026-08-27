import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

if (!existsSync(join(process.cwd(), 'dist', 'controller', 'index.html'))) {
  const build = spawn('npm', ['run', 'build'], {stdio: 'inherit'});
  await new Promise((resolve, reject) => { build.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`build exited ${code}`))); });
}
const server = spawn(process.execPath, ['scripts/test-server.mjs'], {stdio: 'inherit'});
const stop = () => server.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise((resolve) => server.once('exit', resolve));
