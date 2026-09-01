import {createHash} from 'node:crypto';
import {cpSync, existsSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import canonicalize from 'canonicalize';

const fixtures = new Set(['tracker', 'calculator', 'decision-board']);
const fail = (code, detail) => { console.error(JSON.stringify({ok: false, error: {code, detail}})); process.exit(2); };
const validate = (source) => {
  const env = {...process.env, CC: process.env.CC ?? '/usr/bin/cc', PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH ?? ''}`};
  const result = spawnSync('npm', ['run', 'cli', '--', '--json', 'validate', source], {encoding: 'utf8', env});
  const lines = `${result.stdout}\n${result.stderr}`.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{'));
  const diagnostic = lines.at(-1) ?? JSON.stringify({ok: false, error: {code: 'VALIDATOR_OUTPUT_MISSING'}});
  if (result.status !== 0) fail('ADAPTATION_REJECTED', diagnostic);
  return JSON.parse(diagnostic);
};
const refreshIntegrity = (source) => {
  const module = readFileSync(join(source, 'app.worker.js'));
  const manifestPath = join(source, 'smallframe.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files['app.worker.js'] = {bytes: module.byteLength, sha256: createHash('sha256').update(module).digest('base64url')};
  const encoded = canonicalize(manifest);
  if (!encoded) fail('MANIFEST_CANONICALIZATION_FAILED', manifestPath);
  writeFileSync(manifestPath, `${encoded}\n`, {flag: 'w'});
};

const [command, nameOrPath, targetArgument] = process.argv.slice(2);
if (command === 'start') {
  if (!fixtures.has(nameOrPath)) fail('FIXTURE_UNKNOWN', nameOrPath ?? '');
  if (!targetArgument) fail('TARGET_REQUIRED', 'Choose a new target directory.');
  const source = resolve(`examples/${nameOrPath}/package`);
  const target = resolve(targetArgument);
  if (existsSync(target)) fail('TARGET_EXISTS', target);
  validate(source);
  cpSync(source, target, {recursive: true, errorOnExist: true, force: false});
  writeFileSync(join(target, '.smallframe-adaptation.json'), JSON.stringify({schemaVersion: 1, fixture: nameOrPath, startedAt: Date.now()}), {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({ok: true, fixture: nameOrPath, target, instructions: ['Edit app.worker.js', 'Run the finish command shown below'], finish: `npm run adapt -- finish ${target}`}));
} else if (command === 'finish') {
  if (!nameOrPath) fail('SOURCE_REQUIRED', 'Pass the adapted directory.');
  const source = resolve(nameOrPath);
  const stampPath = join(source, '.smallframe-adaptation.json');
  if (!existsSync(stampPath)) fail('ADAPTATION_SESSION_MISSING', stampPath);
  const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
  refreshIntegrity(source);
  const summary = validate(source);
  unlinkSync(stampPath);
  console.log(JSON.stringify({ok: true, fixture: stamp.fixture, elapsedSeconds: Math.round((Date.now() - stamp.startedAt) / 1000), source, summary}));
} else {
  fail('USAGE', 'Use: start <tracker|calculator|decision-board> <new-directory> OR finish <directory>');
}
