import {spawnSync} from 'node:child_process';

const root = process.cwd();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const channelsOnly = process.argv.includes('--channels-only');
const skipValid = process.argv.includes('--skip-valid');
const skipChannels = process.argv.includes('--skip-channels');
const skipHostileFixtures = process.argv.includes('--skip-hostile-fixtures');
const negativeFixtures = [
  'missing',
  'invalid-factory',
  'duplicate',
  'thenable',
  'malformed',
  'oversized',
  'exception',
  'top-level',
  'hidden-key',
  'symbol-key',
  'accessor-result',
  'reentrant-caught',
  'named-array',
  'nonfinite',
  'sparse-array',
  'array-accessor'
];
const channelFixtures = [
  'ready-schema-extra',
  'ready-port',
  'init-schema-extra',
  'init-oversized',
  'window-init-replay',
  'controller-replay',
  'controller-wrong-session',
  'controller-extra-key',
  'controller-unknown-type',
  'controller-oversized',
  'controller-transfer',
  'renderer-replay',
  'renderer-wrong-session',
  'renderer-extra-key',
  'renderer-unknown-type',
  'renderer-oversized',
  'renderer-transfer',
  'renderer-duplicate-ready',
  'worker-inbound-replay',
  'worker-outbound-replay',
  'worker-outbound-nonobject'
];
const channelStart = process.argv.find((argument) => argument.startsWith('--channel-start='))?.slice('--channel-start='.length) ?? '';
const channelStartIndex = channelStart ? channelFixtures.indexOf(channelStart) : 0;
if (channelStart && channelStartIndex < 0) throw new Error(`UNKNOWN_CHANNEL_START:${channelStart}`);
const selectedChannelFixtures = channelFixtures.slice(channelStartIndex);

const environment = (extra = {}) => {
  const value = {...process.env, SMALLFRAME_CANDIDATE: 'U', ...extra};
  delete value.SMALLFRAME_T_FIXTURE;
  delete value.SMALLFRAME_T_MUTATE_RENDERER;
  if (!Object.hasOwn(extra, 'SMALLFRAME_U_FIXTURE')) delete value.SMALLFRAME_U_FIXTURE;
  if (!Object.hasOwn(extra, 'SMALLFRAME_U_MUTATE_RENDERER')) delete value.SMALLFRAME_U_MUTATE_RENDERER;
  if (!Object.hasOwn(extra, 'SMALLFRAME_U_WASM_CSP')) delete value.SMALLFRAME_U_WASM_CSP;
  if (!Object.hasOwn(extra, 'SMALLFRAME_U_CHANNEL_FIXTURE')) delete value.SMALLFRAME_U_CHANNEL_FIXTURE;
  return value;
};

const run = (label, command, args, extra = {}) => {
  console.log(`[candidate-u] ${label}`);
  const result = spawnSync(command, args, {cwd: root, env: environment(extra), stdio: 'inherit'});
  if (result.status !== 0) throw new Error(`CANDIDATE_U_GATE_FAILED:${label}:${result.status ?? 'signal'}`);
};

const runBrowserFile = (label, file, extra = {}) => run(
  label,
  npm,
  ['run', 'test:e2e', '--', file, '--workers=1'],
  extra
);

if (!channelsOnly && !skipValid) runBrowserFile('valid architecture matrix', 'tests/e2e/phase0.spec.ts');
if (!skipChannels) {
  for (const fixture of selectedChannelFixtures) runBrowserFile(
    `channel fixture ${fixture}`,
    'tests/e2e/candidate-u-channel.spec.ts',
    {SMALLFRAME_U_CHANNEL_FIXTURE: fixture}
  );
}
if (channelsOnly) {
  run('final valid artifact restore', npm, ['run', 'build']);
  console.log(JSON.stringify({candidate: 'U', channelFixtures: selectedChannelFixtures.length, channelBrowserAssertions: selectedChannelFixtures.length * 3, resumedFrom: channelStart || null, status: 'PASS'}, null, 2));
  process.exit(0);
}
if (!skipHostileFixtures) {
  for (const fixture of negativeFixtures) runBrowserFile(
    `negative fixture ${fixture}`,
    'tests/e2e/candidate-u-negative.spec.ts',
    {SMALLFRAME_U_FIXTURE: fixture}
  );
  for (const fixture of ['poison', 'global-forge']) runBrowserFile(
    `contained hostile fixture ${fixture}`,
    'tests/e2e/candidate-u-poison.spec.ts',
    {SMALLFRAME_U_FIXTURE: fixture}
  );
}
runBrowserFile(
  'Wasm CSP fail-closed negative',
  'tests/e2e/candidate-u-wasm-csp.spec.ts',
  {SMALLFRAME_U_WASM_CSP: 'deny'}
);

run('restore valid artifact for deterministic tamper vectors', npm, ['run', 'build']);
run('deterministic one-byte digest vectors', process.execPath, ['scripts/phase0-tamper.mjs']);
runBrowserFile(
  'runtime one-byte renderer rejection',
  'tests/e2e/candidate-u-tamper.spec.ts',
  {SMALLFRAME_U_MUTATE_RENDERER: '1'}
);

console.log('[candidate-u] syntax rejection fixture');
const syntax = spawnSync(npm, ['run', 'build'], {
  cwd: root,
  env: environment({SMALLFRAME_U_FIXTURE: 'syntax'}),
  encoding: 'utf8'
});
const syntaxOutput = `${syntax.stdout ?? ''}\n${syntax.stderr ?? ''}`;
if (syntax.status === 0 || !syntaxOutput.includes('APP_SOURCE_SYNTAX_INVALID')) throw new Error('CANDIDATE_U_SYNTAX_GATE_FAILED');
console.log('[candidate-u] syntax fixture rejected with APP_SOURCE_SYNTAX_INVALID');
run('final valid artifact restore', npm, ['run', 'build']);

console.log(JSON.stringify({
  candidate: 'U',
  validBrowserAssertions: skipValid ? 0 : 24,
  negativeFixtures: negativeFixtures.length,
  negativeBrowserAssertions: skipHostileFixtures ? 0 : negativeFixtures.length * 3,
  channelFixtures: channelFixtures.length,
  channelBrowserAssertions: skipChannels ? 0 : channelFixtures.length * 3,
  containedAttackBrowserAssertions: skipHostileFixtures ? 0 : 6,
  wasmCspNegativeBrowserAssertions: 3,
  runtimeTamperBrowserAssertions: 3,
  syntaxRejection: 'APP_SOURCE_SYNTAX_INVALID',
  status: 'PASS'
}, null, 2));
