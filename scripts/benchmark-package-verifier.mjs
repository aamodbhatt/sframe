import {readFileSync, statSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

// Local Node/V8 simulation only; this cannot establish billed Cloudflare CPU.
// Use an already signed public archive. Never print archive contents or paths.
try {
  const server = process.argv[2] === '--server';
  const path = process.argv[server ? 3 : 2];
  if (!path || process.argv.length !== (server ? 4 : 3) || !statSync(path).isFile() || statSync(path).size > 1_048_576) {
    throw new Error('BENCHMARK_INPUT_INVALID');
  }
  const bytes = readFileSync(path);
  const artifact = server ? 'target/server-verifier-wasm/smallframe_server_verifier' : 'target/phase1-wasm/smallframe_verifier';
  const verifier = await import(pathToFileURL(resolve(`${artifact}.js`)).href);
  const startupBefore = process.cpuUsage(); const startupAt = performance.now();
  verifier.initSync({module: readFileSync(`${artifact}_bg.wasm`)});
  if (!verifier.wasm_verifier_self_test()) throw new Error('BENCHMARK_SELF_TEST_FAILED');
  const startupWallMs = performance.now() - startupAt;
  const startupCpu = process.cpuUsage(startupBefore);
  const startupProcessCpuMs = (startupCpu.user + startupCpu.system) / 1_000;
  const wall = []; const cpu = [];
  for (let iteration = 0; iteration < 30; iteration++) {
    const before = process.cpuUsage(); const started = performance.now();
    const result = JSON.parse((server ? verifier.wasm_inspect_package : verifier.wasm_verify_package)(bytes, '', ''));
    wall.push(performance.now() - started);
    const used = process.cpuUsage(before); cpu.push((used.user + used.system) / 1_000);
    if (result.ok !== true) throw new Error('BENCHMARK_INPUT_INVALID');
  }
  console.log(JSON.stringify({simulation: 'Node V8 shared Wasm', artifact: server ? 'server' : 'browser', startupWallMs, startupProcessCpuMs, firstWallMs: wall[0], firstProcessCpuMs: cpu[0], byteLength: bytes.length, iterations: wall.length,
    maxWallMs: Math.max(...wall), maxProcessCpuMs: Math.max(...cpu),
    meanWallMs: wall.reduce((sum, value) => sum + value, 0) / wall.length,
    meanProcessCpuMs: cpu.reduce((sum, value) => sum + value, 0) / cpu.length}));
} catch {
  console.error('PACKAGE_VERIFIER_BENCHMARK_FAILED'); process.exitCode = 1;
}
