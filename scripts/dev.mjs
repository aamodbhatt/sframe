import {spawn} from 'node:child_process';

const environment = {...process.env, SMALLFRAME_CANDIDATE: process.env.SMALLFRAME_CANDIDATE ?? 'U', SMALLFRAME_PHASE2_DEFAULT: process.env.SMALLFRAME_PHASE2_DEFAULT ?? '1'};
const build = spawn('npm', ['run', 'build'], {stdio: 'inherit', env: environment});
await new Promise((resolve, reject) => { build.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`build exited ${code}`))); });
const server = spawn(process.execPath, ['scripts/test-server.mjs'], {stdio: 'inherit', env: environment});
console.log('Smallframe is ready at http://app.localhost:4173/ — press Ctrl-C to stop.');
const stop = () => server.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise((resolve) => server.once('exit', resolve));
