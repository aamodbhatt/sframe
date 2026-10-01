import {readFileSync, statSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

// Local Node/V8 simulation only; this cannot establish billed Cloudflare CPU.
// Use an already signed public archive. Never print archive contents or paths.
try {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3 || !statSync(path).isFile() || statSync(path).size > 1_048_576) {
    throw new Error('BENCHMARK_INPUT_INVALID');
  }
  const bytes = readFileSync(path);
  const verifier = await import(pathToFileURL(resolve('target/phase1-wasm/smallframe_verifier.js')).href);
  verifier.initSync({module: readFileSync('target/phase1-wasm/smallframe_verifier_bg.wasm')});
  const wall = []; const cpu = [];
  for (let iteration = 0; iteration < 30; iteration++) {
    const before = process.cpuUsage(); const started = performance.now();
    const result = JSON.parse(verifier.wasm_verify_package(bytes, '', ''));
    wall.push(performance.now() - started);
    const used = process.cpuUsage(before); cpu.push((used.user + used.system) / 1_000);
    if (result.ok !== true) throw new Error('BENCHMARK_INPUT_INVALID');
  }
  console.log(JSON.stringify({simulation: 'Node V8 shared Wasm', byteLength: bytes.length, iterations: wall.length,
    maxWallMs: Math.max(...wall), maxProcessCpuMs: Math.max(...cpu),
    meanWallMs: wall.reduce((sum, value) => sum + value, 0) / wall.length,
    meanProcessCpuMs: cpu.reduce((sum, value) => sum + value, 0) / cpu.length}));
} catch {
  console.error('PACKAGE_VERIFIER_BENCHMARK_FAILED'); process.exitCode = 1;
}
