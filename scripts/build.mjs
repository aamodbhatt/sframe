import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {signAsync} from '@noble/ed25519';
import canonicalize from 'canonicalize';

const root = process.cwd();
const candidate = process.env.SMALLFRAME_CANDIDATE ?? 'U';
if (!['original', 'R', 'A', 'S', 'T', 'U'].includes(candidate)) throw new Error(`Unsupported SMALLFRAME_CANDIDATE=${candidate}`);
const dist = join(root, 'dist');
rmSync(dist, {recursive: true, force: true});
mkdirSync(dist, {recursive: true});
const run = (args) => {
  const result = spawnSync('npx', ['tsc', ...args], {cwd: root, stdio: 'inherit'});
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const inlineScriptString = (value) => JSON.stringify(value)
  .replaceAll('<', '\\u003c')
  .replaceAll('\u2028', '\\u2028')
  .replaceAll('\u2029', '\\u2029');
run(['-b', 'tsconfig.json']);
const wasmBuild = spawnSync('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'smallframe-phase0-wasm'], {cwd: root, stdio: 'inherit'});
if (wasmBuild.status !== 0) process.exit(wasmBuild.status ?? 1);
const phase0Wasm = readFileSync(join(root, 'target', 'wasm32-unknown-unknown', 'release', 'smallframe_phase0_wasm.wasm'));
if (phase0Wasm.byteLength < 8 || phase0Wasm.byteLength > 65_536 || !phase0Wasm.subarray(0, 8).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))) throw new Error('PHASE0_WASM_ARTIFACT_INVALID');
const phase0WasmModule = new WebAssembly.Module(phase0Wasm);
if (WebAssembly.Module.imports(phase0WasmModule).length !== 0) throw new Error('PHASE0_WASM_IMPORT_FORBIDDEN');
const phase0WasmExports = WebAssembly.Module.exports(phase0WasmModule);
const phase0ProbeExports = phase0WasmExports.filter((entry) => entry.name === 'smallframe_phase0_probe' && entry.kind === 'function');
if (phase0ProbeExports.length !== 1 || phase0WasmExports.some((entry) => !['memory', 'smallframe_phase0_probe', '__data_end', '__heap_base'].includes(entry.name))) throw new Error('PHASE0_WASM_EXPORT_INVALID');
const phase0WasmInstance = new WebAssembly.Instance(phase0WasmModule);
if ((phase0WasmInstance.exports.smallframe_phase0_probe(0x13579bdf) >>> 0) !== 0xf88bbfb9) throw new Error('PHASE0_WASM_PROBE_INVALID');
const phase0WasmDigest = createHash('sha256').update(phase0Wasm).digest('hex');
const phase1WasmBuild = spawnSync('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'smallframe-core', '--no-default-features', '--features', 'wasm'], {cwd: root, stdio: 'inherit'});
if (phase1WasmBuild.status !== 0) process.exit(phase1WasmBuild.status ?? 1);
const wasmBindgen = join(root, '.tools', 'bin', 'wasm-bindgen');
if (!existsSync(wasmBindgen)) throw new Error('PHASE1_WASM_BINDGEN_MISSING: run npm run bootstrap');
const phase1WasmOutput = join(root, 'target', 'phase1-wasm');
rmSync(phase1WasmOutput, {recursive: true, force: true});
mkdirSync(phase1WasmOutput, {recursive: true});
const phase1Bindgen = spawnSync(wasmBindgen, ['--target', 'web', '--no-typescript', '--out-dir', phase1WasmOutput, '--out-name', 'smallframe_verifier', join(root, 'target', 'wasm32-unknown-unknown', 'release', 'smallframe_core.wasm')], {cwd: root, stdio: 'inherit'});
if (phase1Bindgen.status !== 0) process.exit(phase1Bindgen.status ?? 1);
const phase1Wasm = readFileSync(join(phase1WasmOutput, 'smallframe_verifier_bg.wasm'));
if (phase1Wasm.byteLength < 8 || phase1Wasm.byteLength > 2 * 1024 * 1024 || !phase1Wasm.subarray(0, 8).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))) throw new Error('PHASE1_WASM_ARTIFACT_INVALID');
const phase1WasmDigest = createHash('sha256').update(phase1Wasm).digest('hex');
const phase1GlueRaw = readFileSync(join(phase1WasmOutput, 'smallframe_verifier.js'), 'utf8');
const phase1Glue = phase1GlueRaw
  .replace(/^export \{[^\n]+\};?$/gmu, '')
  .replace(/^export /gmu, '');
if (/^\s*(?:import|export)\s/mu.test(phase1Glue) || /^\s*\{[^\n]*\bas\s+(?:default|[A-Za-z_$])/mu.test(phase1Glue)) {
  throw new Error('PHASE1_WASM_GLUE_MODULE_SYNTAX');
}
const phase1GluePrelude = `{\n${phase1Glue}\nglobalThis.__smallframePhase1Verifier = Object.freeze({initSync, wasm_prepare_package, wasm_sha256_hex, wasm_validate_state, wasm_verifier_self_test, wasm_verifier_version, wasm_verify_package});\n}\n`;
const phase0WasmCsp = process.env.SMALLFRAME_U_WASM_CSP ?? 'allow';
if (!['allow', 'deny'].includes(phase0WasmCsp) || (candidate !== 'U' && phase0WasmCsp !== 'allow')) throw new Error('SMALLFRAME_U_WASM_CSP requires Candidate U and allow|deny');
const wasmEvalSource = phase0WasmCsp === 'allow' ? " 'wasm-unsafe-eval'" : '';

const controller = join(dist, 'controller');
mkdirSync(join(controller, 'runtime', 'renderer'), {recursive: true});
cpSync(join(root, 'apps/controller/public/index.html'), join(controller, 'index.html'));
cpSync(join(root, 'apps/controller/public/controller.css'), join(controller, 'controller.css'));
cpSync(join(root, 'apps/controller/public/manifest.webmanifest'), join(controller, 'manifest.webmanifest'));
cpSync(join(root, 'apps/controller/public/icon.svg'), join(controller, 'icon.svg'));
cpSync(join(root, 'apps/controller/public/fixture-module.js'), join(controller, 'fixture-module.js'));

const candidateFactoryPath = candidate === 'U' ? 'candidate-u-factory.js' : candidate === 'T' ? 'candidate-t-factory.js' : 'candidate-s-factory.js';
const legacyFixture = process.env.SMALLFRAME_T_FIXTURE ?? '';
const candidateUFixture = process.env.SMALLFRAME_U_FIXTURE ?? '';
const candidateUChannelFixture = process.env.SMALLFRAME_U_CHANNEL_FIXTURE ?? '';
if (legacyFixture && candidateUFixture) throw new Error('Set only one Candidate fixture environment variable');
if (candidateUFixture && candidateUChannelFixture) throw new Error('Set only one Candidate U fixture dimension');
if ([Boolean(candidateUFixture), Boolean(candidateUChannelFixture), phase0WasmCsp === 'deny', process.env.SMALLFRAME_U_MUTATE_RENDERER === '1'].filter(Boolean).length > 1) throw new Error('Set only one Candidate U fault dimension');
const fixture = candidate === 'U' ? candidateUFixture : legacyFixture;
if (candidate === 'U' && legacyFixture) throw new Error('SMALLFRAME_T_FIXTURE is not valid for SMALLFRAME_CANDIDATE=U');
if (candidate !== 'U' && candidateUFixture) throw new Error('SMALLFRAME_U_FIXTURE requires SMALLFRAME_CANDIDATE=U');
if (candidate !== 'U' && candidateUChannelFixture) throw new Error('SMALLFRAME_U_CHANNEL_FIXTURE requires SMALLFRAME_CANDIDATE=U');
if (candidate !== 'T' && candidate !== 'U' && fixture) throw new Error('Candidate fixtures require SMALLFRAME_CANDIDATE=T or U');
if (!['', 'missing', 'duplicate', 'thenable', 'malformed', 'oversized', 'syntax', 'exception', 'top-level', 'global-forge', 'poison', 'invalid-factory', 'hidden-key', 'symbol-key', 'accessor-result', 'reentrant-caught', 'named-array', 'nonfinite', 'sparse-array', 'array-accessor'].includes(fixture)) throw new Error(`Unsupported Candidate fixture=${fixture}`);
if (!['', 'ready-schema-extra', 'ready-port', 'init-schema-extra', 'init-oversized', 'controller-replay', 'controller-wrong-session', 'controller-extra-key', 'controller-unknown-type', 'controller-oversized', 'controller-transfer', 'renderer-replay', 'renderer-wrong-session', 'renderer-extra-key', 'renderer-unknown-type', 'renderer-oversized', 'renderer-transfer', 'renderer-duplicate-ready', 'window-init-replay', 'worker-inbound-replay', 'worker-outbound-replay', 'worker-outbound-nonobject'].includes(candidateUChannelFixture)) throw new Error(`Unsupported Candidate U channel fixture=${candidateUChannelFixture}`);
const rawCandidateFactorySource = readFileSync(join(root, 'apps/controller/public', candidateFactoryPath), 'utf8').trim();
let candidateFactorySource = rawCandidateFactorySource.replaceAll(candidate === 'U' ? '__SMALLFRAME_U_FIXTURE__' : '__SMALLFRAME_T_FIXTURE__', fixture);
if (candidate === 'T' && fixture === 'syntax') candidateFactorySource += '\n(';
if (candidate === 'U') {
  if (fixture === 'syntax') candidateFactorySource += '\n(';
  const parsed = ts.createSourceFile(candidateFactoryPath, candidateFactorySource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length > 0) {
    const diagnostic = parsed.parseDiagnostics[0];
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    throw new Error(`APP_SOURCE_SYNTAX_INVALID: ${message}`);
  }
  if (parsed.statements.some((statement) => ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isExportAssignment(statement))) {
    throw new Error('APP_SOURCE_MODULE_SYNTAX_FORBIDDEN');
  }
  candidateFactorySource = ts.createPrinter({newLine: ts.NewLineKind.LineFeed, removeComments: false}).printFile(parsed).trim();
}
const rendererProgramSource = readFileSync(join(dist, 'renderer', 'renderer.js'), 'utf8')
  .replaceAll('__ARCHITECTURE_CANDIDATE__', candidate)
  .replaceAll('__CHANNEL_TEST_FIXTURE__', candidateUChannelFixture)
  .replaceAll('__PHASE0_WASM_BASE64__', phase0Wasm.toString('base64'))
  .replaceAll('__PHASE0_WASM_SHA256__', phase0WasmDigest)
  .replaceAll('__PHASE0_WASM_BYTES__', String(phase0Wasm.byteLength))
  .replaceAll('__PHASE1_WASM_BASE64__', phase1Wasm.toString('base64'))
  .replaceAll('__PHASE1_WASM_SHA256__', phase1WasmDigest)
  .replaceAll('__PHASE1_WASM_BYTES__', String(phase1Wasm.byteLength))
  .replaceAll("'__CANDIDATE_FACTORY_SOURCE__'", inlineScriptString(candidateFactorySource));
const rendererSource = `${phase1GluePrelude}${rendererProgramSource}`;
const rendererCss = readFileSync(join(root, 'apps/renderer/renderer.css'), 'utf8');
const rendererBootstrapHash = createHash('sha256').update(rendererSource).digest('base64');
const rendererCssHash = createHash('sha256').update(rendererCss).digest('base64');
const rendererMetaCsp = `default-src 'none'; script-src 'sha256-${rendererBootstrapHash}'${wasmEvalSource} blob:; style-src 'sha256-${rendererCssHash}'; img-src 'none'; font-src 'none'; connect-src 'none'; worker-src blob:; child-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'; require-trusted-types-for 'script'; trusted-types smallframe-renderer-worker`;
const rendererMetaTag = candidate === 'A' ? `<meta http-equiv="Content-Security-Policy" content="${rendererMetaCsp.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">` : '';
const rendererHtml = `<!doctype html><html><head>${rendererMetaTag}<meta charset="utf-8"><style>${rendererCss}</style></head><body><div id="sf-app-root"></div><script type="module">${rendererSource}</script></body></html>`;
const rendererDigest = createHash('sha256').update(rendererHtml).digest('hex');
const rendererPath = join(controller, 'runtime', 'renderer', `${rendererDigest}.html`);
writeFileSync(rendererPath, rendererHtml);

const swPath = join(controller, 'sw.js');
let sw = readFileSync(swPath, 'utf8');
sw = sw.replace(/\nexport \{\};\s*$/u, '\n');
sw = sw.replaceAll('__RENDERER_DIGEST__', rendererDigest)
  .replaceAll('__RENDERER_BOOTSTRAP_HASH__', rendererBootstrapHash)
  .replaceAll('__RENDERER_CSS_HASH__', rendererCssHash)
  .replaceAll('__RENDERER_WASM_EVAL_SOURCE__', wasmEvalSource);
writeFileSync(swPath, sw);
const mainPath = join(controller, 'main.js');
const configuredPackage = process.env.SMALLFRAME_DEV_PACKAGE;
const phase2DefaultPackagePath = join(root, 'packages/protocol/vectors/phase2-decision-board-v1.zip.b64');
const phase2DefaultPackageMetadata = JSON.parse(readFileSync(join(root, 'packages/protocol/vectors/phase2-decision-board-v1.json'), 'utf8'));
const phase2Package = configuredPackage
  ? readFileSync(configuredPackage)
  : Buffer.from(readFileSync(phase2DefaultPackagePath, 'utf8').trim(), 'base64');
if (phase2Package.byteLength < 1 || phase2Package.byteLength > 1_310_720) throw new Error('PHASE2_PACKAGE_SIZE_INVALID');
const phase2Default = process.env.SMALLFRAME_PHASE2_DEFAULT === '1';
const phase2ExpectedDigest = configuredPackage ? (process.env.SMALLFRAME_DEV_PACKAGE_DIGEST ?? '') : phase2DefaultPackageMetadata.packageDigest;
const phase2ExpectedKeyId = configuredPackage ? (process.env.SMALLFRAME_DEV_PUBLISHER_KEY_ID ?? '') : phase2DefaultPackageMetadata.publisherKeyId;
let main = readFileSync(mainPath, 'utf8').replace(/\nexport \{\};\s*$/u, '').replaceAll('__RENDERER_DIGEST__', rendererDigest)
  .replaceAll('__RENDERER_BOOTSTRAP_HASH__', rendererBootstrapHash)
  .replaceAll('__RENDERER_CSS_HASH__', rendererCssHash)
  .replaceAll('__RENDERER_WASM_EVAL_SOURCE__', wasmEvalSource)
  .replaceAll('__PHASE0_WASM_BYTES__', String(phase0Wasm.byteLength))
  .replaceAll('__PHASE1_WASM_BYTES__', String(phase1Wasm.byteLength))
  .replaceAll('__CHANNEL_TEST_FIXTURE__', candidateUChannelFixture)
  .replaceAll('__PHASE2_PACKAGE_BASE64__', phase2Package.toString('base64'))
  .replaceAll('__PHASE2_DEFAULT_FLAG__', phase2Default ? '1' : '0')
  .replaceAll('__PHASE2_EXPECTED_DIGEST__', phase2ExpectedDigest)
  .replaceAll('__PHASE2_EXPECTED_KEY_ID__', phase2ExpectedKeyId)
  .replaceAll('__ARCHITECTURE_CANDIDATE__', candidate);
writeFileSync(mainPath, main);
for (const helper of ['personal-store.js', 'personal-runtime.js']) {
  const helperPath = join(controller, helper);
  writeFileSync(helperPath, readFileSync(helperPath, 'utf8').replace(/\nexport \{\};\s*$/u, '\n'));
}

const staticPaths = [
  '/controller.css',
  '/fixture-module.js',
  '/icon.svg',
  '/index.html',
  '/main.js',
  '/manifest.webmanifest',
  '/personal-runtime.js',
  '/personal-store.js',
  `/runtime/renderer/${rendererDigest}.html`
].sort();
const controllerAssetSet = {};
for (const p of staticPaths) {
  const filePath = p.startsWith('/runtime/renderer/')
    ? join(controller, 'runtime', 'renderer', `${rendererDigest}.html`)
    : join(controller, p.slice(1));
  const content = readFileSync(filePath);
  controllerAssetSet[p] = {
    bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('base64url')
  };
}
const controllerAssetSetDigest = createHash('sha256').update(Buffer.from(canonicalize(controllerAssetSet))).digest('base64url');
const controllerShellDigest = controllerAssetSet['/index.html'].sha256;
const rendererDigestB64 = controllerAssetSet[`/runtime/renderer/${rendererDigest}.html`].sha256;
const verifierDigestB64 = createHash('sha256').update(phase1Wasm).digest('base64url');
const serviceWorkerDigestB64 = createHash('sha256').update(readFileSync(swPath)).digest('base64url');
let gitCommit = '0123456789abcdef0123456789abcdef01234567';
try {
  const gitProc = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'});
  if (gitProc.status === 0 && /^[0-9a-f]{40}$/i.test(gitProc.stdout.trim())) {
    gitCommit = gitProc.stdout.trim().toLowerCase();
  }
} catch (_) {}
const createdAt = process.env.SMALLFRAME_DETERMINISTIC_RELEASE === '1' ? 1780000000000 : Date.now();
const recordWithoutBuildId = {
  schemaVersion: 1,
  gitCommit,
  createdAt,
  controllerShellDigest,
  controllerAssetSetDigest,
  serviceWorkerDigest: serviceWorkerDigestB64,
  rendererDigest: rendererDigestB64,
  verifierDigest: verifierDigestB64,
  protocolMin: process.env.SMALLFRAME_RELEASE_PROTOCOL_INCOMPATIBLE === '1' ? 2 : 1,
  protocolMax: process.env.SMALLFRAME_RELEASE_PROTOCOL_INCOMPATIBLE === '1' ? 2 : 1
};
const prefix = Buffer.from('smallframe/controller-release/v1\0');
const canonicalWithout = Buffer.from(canonicalize(recordWithoutBuildId));
let buildId = createHash('sha256').update(prefix).update(canonicalWithout).digest('base64url');
if (process.env.SMALLFRAME_RELEASE_CORRUPT_BUILD_ID === '1') {
  buildId = 'CorruptedBuildId_' + buildId.slice(17);
}
const fullRecord = {...recordWithoutBuildId, buildId};
const payloadType = 'application/vnd.smallframe.controller-release.v1+json';
const canonicalFull = Buffer.from(canonicalize(fullRecord));
const paePrefix = Buffer.from(`DSSEv1 ${payloadType.length} ${payloadType} ${canonicalFull.byteLength} `);
const pae = Buffer.concat([paePrefix, canonicalFull]);
const rootPriv = Buffer.alloc(32, 0x52);
let sigBytes = await signAsync(pae, rootPriv);
if (process.env.SMALLFRAME_RELEASE_CORRUPT_SIG === '1') {
  sigBytes = Uint8Array.from(sigBytes);
  sigBytes[0] ^= 1;
}
const signature = Buffer.from(sigBytes).toString('base64url');
if (process.env.SMALLFRAME_RELEASE_CORRUPT_ASSET === '1') {
  controllerAssetSet['/controller.css'].sha256 = 'CorruptedAssetSha256_______________________';
}
const releaseEnvelope = {
  schemaVersion: 1,
  payloadType,
  payload: canonicalFull.toString('base64url'),
  signatures: [{keyId: 'sha256:h-5zg31LoCDgdHkLQnZ6NPQ16O9g8tTJ2qdzt8QlGkA', sig: signature}],
  record: fullRecord,
  assetSet: controllerAssetSet
};
writeFileSync(join(controller, 'release.json'), JSON.stringify(releaseEnvelope, null, 2) + '\n');

writeFileSync(join(dist, 'renderer', 'renderer.js'), rendererSource);
console.log(JSON.stringify({candidate, fixture: fixture || 'valid', channelFixture: candidateUChannelFixture || 'valid', rendererDigest, rendererBytes: Buffer.byteLength(rendererHtml), rendererBootstrapHash, rendererCssHash, phase0WasmBytes: phase0Wasm.byteLength, phase0WasmDigest, phase1WasmBytes: phase1Wasm.byteLength, phase1WasmDigest, phase2PackageBytes: phase2Package.byteLength, phase2PackageArtifactDigest: createHash('sha256').update(phase2Package).digest('hex'), phase2Default, phase0WasmCsp, candidateFactory: candidateFactoryPath, candidateFactoryBytes: Buffer.byteLength(candidateFactorySource), candidateFactoryDigest: createHash('sha256').update(candidateFactorySource).digest('hex'), buildId}, null, 2));

