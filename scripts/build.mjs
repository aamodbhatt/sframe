import {createHash} from 'node:crypto';
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';

const root = process.cwd();
const candidate = process.env.SMALLFRAME_CANDIDATE ?? 'original';
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
const phase0WasmCsp = process.env.SMALLFRAME_U_WASM_CSP ?? 'allow';
if (!['allow', 'deny'].includes(phase0WasmCsp) || (candidate !== 'U' && phase0WasmCsp !== 'allow')) throw new Error('SMALLFRAME_U_WASM_CSP requires Candidate U and allow|deny');
const wasmEvalSource = phase0WasmCsp === 'allow' ? " 'wasm-unsafe-eval'" : '';

const controller = join(dist, 'controller');
mkdirSync(join(controller, 'runtime', 'renderer'), {recursive: true});
cpSync(join(root, 'apps/controller/public/index.html'), join(controller, 'index.html'));
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
const rendererSource = readFileSync(join(dist, 'renderer', 'renderer.js'), 'utf8')
  .replaceAll('__ARCHITECTURE_CANDIDATE__', candidate)
  .replaceAll('__CHANNEL_TEST_FIXTURE__', candidateUChannelFixture)
  .replaceAll('__PHASE0_WASM_BASE64__', phase0Wasm.toString('base64'))
  .replaceAll('__PHASE0_WASM_SHA256__', phase0WasmDigest)
  .replaceAll('__PHASE0_WASM_BYTES__', String(phase0Wasm.byteLength))
  .replaceAll("'__CANDIDATE_FACTORY_SOURCE__'", inlineScriptString(candidateFactorySource));
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
let main = readFileSync(mainPath, 'utf8').replace(/\nexport \{\};\s*$/u, '').replaceAll('__RENDERER_DIGEST__', rendererDigest)
  .replaceAll('__RENDERER_BOOTSTRAP_HASH__', rendererBootstrapHash)
  .replaceAll('__RENDERER_CSS_HASH__', rendererCssHash)
  .replaceAll('__RENDERER_WASM_EVAL_SOURCE__', wasmEvalSource)
  .replaceAll('__PHASE0_WASM_BYTES__', String(phase0Wasm.byteLength))
  .replaceAll('__CHANNEL_TEST_FIXTURE__', candidateUChannelFixture)
  .replaceAll('__ARCHITECTURE_CANDIDATE__', candidate);
writeFileSync(mainPath, main);
writeFileSync(join(dist, 'renderer', 'renderer.js'), rendererSource);
console.log(JSON.stringify({candidate, fixture: fixture || 'valid', channelFixture: candidateUChannelFixture || 'valid', rendererDigest, rendererBytes: Buffer.byteLength(rendererHtml), rendererBootstrapHash, rendererCssHash, phase0WasmBytes: phase0Wasm.byteLength, phase0WasmDigest, phase0WasmCsp, candidateFactory: candidateFactoryPath, candidateFactoryBytes: Buffer.byteLength(candidateFactorySource), candidateFactoryDigest: createHash('sha256').update(candidateFactorySource).digest('hex')}, null, 2));
