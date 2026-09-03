import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {signAsync} from '@noble/ed25519';
import canonicalize from 'canonicalize';
import {pathToFileURL} from 'node:url';
import {build as bundle} from 'vite';

const root = process.cwd();
const candidate = process.env.SMALLFRAME_CANDIDATE ?? 'U';
if (!['original', 'R', 'A', 'S', 'T', 'U'].includes(candidate)) throw new Error(`Unsupported SMALLFRAME_CANDIDATE=${candidate}`);
const dist = join(root, 'dist');
rmSync(dist, {recursive: true, force: true});
mkdirSync(dist, {recursive: true});
const childEnv = {...process.env, CC: '/usr/bin/cc', PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH ?? ''}`};
const run = (args) => {
  const result = spawnSync('npx', ['tsc', ...args], {cwd: root, stdio: 'inherit', env: childEnv});
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const inlineScriptString = (value) => JSON.stringify(value)
  .replaceAll('<', '\\u003c')
  .replaceAll('\u2028', '\\u2028')
  .replaceAll('\u2029', '\\u2029');
run(['-b', 'tsconfig.json']);
const wasmBuild = spawnSync('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'smallframe-phase0-wasm'], {cwd: root, stdio: 'inherit', env: childEnv});
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
const phase1WasmBuild = spawnSync('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'smallframe-core', '--no-default-features', '--features', 'wasm'], {cwd: root, stdio: 'inherit', env: childEnv});
if (phase1WasmBuild.status !== 0) process.exit(phase1WasmBuild.status ?? 1);
const wasmBindgen = join(root, '.tools', 'bin', 'wasm-bindgen');
if (!existsSync(wasmBindgen)) throw new Error('PHASE1_WASM_BINDGEN_MISSING: run npm run bootstrap');
const phase1WasmOutput = join(root, 'target', 'phase1-wasm');
rmSync(phase1WasmOutput, {recursive: true, force: true});
mkdirSync(phase1WasmOutput, {recursive: true});
const phase1Bindgen = spawnSync(wasmBindgen, ['--target', 'web', '--no-typescript', '--out-dir', phase1WasmOutput, '--out-name', 'smallframe_verifier', join(root, 'target', 'wasm32-unknown-unknown', 'release', 'smallframe_core.wasm')], {cwd: root, stdio: 'inherit', env: childEnv});
if (phase1Bindgen.status !== 0) process.exit(phase1Bindgen.status ?? 1);
const phase1Wasm = readFileSync(join(phase1WasmOutput, 'smallframe_verifier_bg.wasm'));
if (phase1Wasm.byteLength < 8 || phase1Wasm.byteLength > 2 * 1024 * 1024 || !phase1Wasm.subarray(0, 8).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))) throw new Error('PHASE1_WASM_ARTIFACT_INVALID');
const phase1WasmDigest = createHash('sha256').update(phase1Wasm).digest('hex');
// Public test template only. Each test publisher encrypts these exact shared
// genesis bytes before its local relay initialization; recipients never recreate them.
const genesisVerifier = await import(pathToFileURL(join(phase1WasmOutput, 'smallframe_verifier.js')).href);
genesisVerifier.initSync({module: phase1Wasm});
writeFileSync(join(phase1WasmOutput, 'phase3-genesis.bin'), genesisVerifier.wasm_automerge_genesis('{"decisions":{}}', '01'.repeat(16)));
const phase1GlueRaw = readFileSync(join(phase1WasmOutput, 'smallframe_verifier.js'), 'utf8');
const phase1Glue = phase1GlueRaw
  .replace(/^export \{[^\n]+\};?$/gmu, '')
  .replace(/^export /gmu, '')
  .replace(/import\.meta\.url/gu, "''");
if (/^\s*(?:import|export)\s/mu.test(phase1Glue) || /^\s*\{[^\n]*\bas\s+(?:default|[A-Za-z_$])/mu.test(phase1Glue)) {
  throw new Error('PHASE1_WASM_GLUE_MODULE_SYNTAX');
}
const phase1GluePrelude = `{\n${phase1Glue}\nglobalThis.__smallframePhase1Verifier = Object.freeze({initSync, wasm_prepare_package, wasm_sha256_hex, wasm_validate_state, wasm_verifier_self_test, wasm_verifier_version, wasm_verify_package, wasm_automerge_genesis, wasm_automerge_apply_patch, wasm_automerge_merge, wasm_automerge_project, wasm_automerge_validate});\n}\n`;
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

const nobleEd25519Raw = readFileSync(join(root, 'node_modules/@noble/ed25519/index.js'), 'utf8')
  .replace(/^export \{/mu, 'const ed25519_exports = {')
  .replace('Point as ExtendedPoint', 'ExtendedPoint: Point');
const canonicalizeRaw = readFileSync(join(root, 'node_modules/canonicalize/lib/canonicalize.js'), 'utf8')
  .replace(/module\.exports\s*=\s*/mu, 'const canonicalize = ');

const stateWorkerSource = `const PHASE1_WASM_BASE64 = ${inlineScriptString(phase1Wasm.toString('base64'))};
${phase1Glue}
${canonicalizeRaw}
${nobleEd25519Raw}

const STATE_CIPHERTEXT_LIMIT = 524288;
const PADDING_BUCKET_BYTES = 4096;

const encodeBase64Url = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const decodeBase64Url = (str) => {
  let base64 = str.replaceAll('-', '+').replaceAll('_', '/');
  while (base64.length % 4 !== 0) base64 += '=';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const uint32be = (value) => {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(0, value, false);
  return buf;
};

const uint64be = (value) => {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setBigUint64(0, BigInt(value), false);
  return buf;
};

const concatBytes = (...arrays) => {
  const total = arrays.reduce((acc, a) => acc + a.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out;
};

const sha256 = async (data) => {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
};

const deriveEnvelopeKey = async (roomKey, rawRoomId, envelopeSalt, stateEpoch, proposedRevision) => {
  const saltPrefix = new TextEncoder().encode('smallframe/state/salt/v1\\0');
  const hkdfSalt = await sha256(concatBytes(saltPrefix, rawRoomId, envelopeSalt));
  const infoPrefix = new TextEncoder().encode('smallframe/state/key/v1\\0');
  const hkdfInfo = concatBytes(infoPrefix, uint64be(stateEpoch), uint64be(proposedRevision));
  const keyMaterial = await crypto.subtle.importKey('raw', roomKey, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: hkdfInfo},
    keyMaterial,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt']
  );
};

const padPlaintext = (automergeBytes) => {
  const unpaddedLength = 4 + automergeBytes.byteLength;
  const bucketCount = Math.ceil(unpaddedLength / PADDING_BUCKET_BYTES);
  const totalLength = Math.max(PADDING_BUCKET_BYTES, bucketCount * PADDING_BUCKET_BYTES);
  const paddingLength = totalLength - unpaddedLength;
  const lenPrefix = uint32be(automergeBytes.byteLength);
  const padding = new Uint8Array(paddingLength);
  if (paddingLength > 0) crypto.getRandomValues(padding);
  return concatBytes(lenPrefix, automergeBytes, padding);
};

const unpadPlaintext = (padded) => {
  if (padded.byteLength < 4 || padded.byteLength % PADDING_BUCKET_BYTES !== 0) throw new Error('INVALID_PADDING_LENGTH');
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const declaredLength = view.getUint32(0, false);
  if (declaredLength > padded.byteLength - 4) throw new Error('DECLARED_LENGTH_EXCEEDS_PLAINTEXT');
  const expectedTotal = Math.max(PADDING_BUCKET_BYTES, Math.ceil((4 + declaredLength) / PADDING_BUCKET_BYTES) * PADDING_BUCKET_BYTES);
  if (padded.byteLength !== expectedTotal) throw new Error('NON_CANONICAL_PADDING_BUCKET');
  return padded.slice(4, 4 + declaredLength);
};

const computeWriteMessage = async (rawRoomId, rawPackageDigest, stateEpoch, proposedRevision, rawPreviousEnvelopeDigest, envelopeSalt, aadBytes, ciphertextBytes) => {
  const prefix = new TextEncoder().encode('smallframe-room-snapshot-v1\\0');
  const aadHash = await sha256(aadBytes);
  const cipherHash = await sha256(ciphertextBytes);
  return sha256(concatBytes(prefix, rawRoomId, rawPackageDigest, uint64be(stateEpoch), uint64be(proposedRevision), rawPreviousEnvelopeDigest, envelopeSalt, aadHash, cipherHash));
};

const computeEnvelopeDigest = async (envelopeWithoutSignature, writerSignature) => {
  const prefix = new TextEncoder().encode('smallframe/envelope-digest/v1\\0');
  const unsignedJcs = new TextEncoder().encode(canonicalize(envelopeWithoutSignature));
  return sha256(concatBytes(prefix, uint64be(unsignedJcs.byteLength), unsignedJcs, writerSignature));
};

const computeEtag = (stateEpoch, proposedRevision, envelopeDigest) => {
  return \`"sf1.\${stateEpoch}.\${proposedRevision}.\${encodeBase64Url(envelopeDigest)}"\`;
};

const encryptSnapshot = async (params) => {
  const rawRoomId = decodeBase64Url(params.roomId);
  const rawPackageDigest = decodeBase64Url(params.packageDigest);
  const rawPreviousDigest = decodeBase64Url(params.previousEnvelopeDigest);
  const envelopeSalt = new Uint8Array(16);
  crypto.getRandomValues(envelopeSalt);
  const derivedKey = await deriveEnvelopeKey(params.roomKey, rawRoomId, envelopeSalt, params.stateEpoch, params.proposedRevision);

  const aad = {
    protocolVersion: 1,
    appId: params.appId || params.roomId,
    roomId: params.roomId,
    packageDigest: params.packageDigest,
    stateEpoch: params.stateEpoch,
    proposedRevision: params.proposedRevision,
    previousEnvelopeDigest: params.previousEnvelopeDigest
  };
  const aadBytes = new TextEncoder().encode(canonicalize(aad));
  const paddedPlaintext = padPlaintext(params.automergeBytes);
  const nonce = new Uint8Array(12);

  const encryptedBuffer = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv: nonce, additionalData: aadBytes, tagLength: 128},
    derivedKey,
    paddedPlaintext
  );
  const ciphertextBytes = new Uint8Array(encryptedBuffer);
  if (ciphertextBytes.byteLength > STATE_CIPHERTEXT_LIMIT) throw new Error('STATE_CIPHERTEXT_LIMIT_EXCEEDED');

  const writeMessage = await computeWriteMessage(rawRoomId, rawPackageDigest, params.stateEpoch, params.proposedRevision, rawPreviousDigest, envelopeSalt, aadBytes, ciphertextBytes);
  const writerSignature = await signAsync(writeMessage, params.writerPrivateKey);
  const writerPublicKey = await getPublicKeyAsync(params.writerPrivateKey);

  const envelopeWithoutSig = {
    version: 1,
    stateEpoch: params.stateEpoch,
    proposedRevision: params.proposedRevision,
    envelopeSalt: encodeBase64Url(envelopeSalt),
    previousEnvelopeDigest: params.previousEnvelopeDigest,
    ciphertext: encodeBase64Url(ciphertextBytes),
    writerPublicKey: encodeBase64Url(writerPublicKey),
    aad
  };
  const envelopeDigest = await computeEnvelopeDigest(envelopeWithoutSig, writerSignature);
  const etag = computeEtag(params.stateEpoch, params.proposedRevision, envelopeDigest);
  const envelope = {
    ...envelopeWithoutSig,
    writerSignature: encodeBase64Url(writerSignature)
  };
  return {envelope, envelopeDigest: encodeBase64Url(envelopeDigest), etag};
};

const decryptSnapshot = async (params) => {
  const {envelope} = params;
  if (envelope.version !== 1) throw new Error('UNSUPPORTED_ENVELOPE_VERSION');
  if (envelope.aad.roomId !== params.roomId) throw new Error('ROOM_ID_AAD_MISMATCH');
  if (envelope.aad.packageDigest !== params.packageDigest) throw new Error('PACKAGE_DIGEST_AAD_MISMATCH');
  if (params.expectedAppId !== undefined && envelope.aad.appId !== params.expectedAppId) throw new Error('APP_ID_AAD_MISMATCH');
  if (envelope.aad.stateEpoch !== envelope.stateEpoch || envelope.aad.proposedRevision !== envelope.proposedRevision) throw new Error('EPOCH_REVISION_AAD_MISMATCH');

  const rawRoomId = decodeBase64Url(params.roomId);
  const rawPackageDigest = decodeBase64Url(params.packageDigest);
  const rawPreviousDigest = decodeBase64Url(envelope.previousEnvelopeDigest);
  const envelopeSalt = decodeBase64Url(envelope.envelopeSalt);
  const ciphertextBytes = decodeBase64Url(envelope.ciphertext);
  const writerPublicKey = decodeBase64Url(envelope.writerPublicKey);
  const writerSignature = decodeBase64Url(envelope.writerSignature);

  if (ciphertextBytes.byteLength > STATE_CIPHERTEXT_LIMIT) throw new Error('STATE_CIPHERTEXT_LIMIT_EXCEEDED');
  if (params.expectedWriterPublicKey) {
    if (writerPublicKey.byteLength !== 32 || params.expectedWriterPublicKey.byteLength !== 32) throw new Error('WRITER_KEY_LENGTH_MISMATCH');
    for (let i = 0; i < 32; i++) {
      if (writerPublicKey[i] !== params.expectedWriterPublicKey[i]) throw new Error('WRITER_PUBLIC_KEY_MISMATCH');
    }
  }

  const aadBytes = new TextEncoder().encode(canonicalize(envelope.aad));
  const writeMessage = await computeWriteMessage(rawRoomId, rawPackageDigest, envelope.stateEpoch, envelope.proposedRevision, rawPreviousDigest, envelopeSalt, aadBytes, ciphertextBytes);
  const validSig = await verifyAsync(writerSignature, writeMessage, writerPublicKey);
  if (!validSig) throw new Error('WRITER_SIGNATURE_INVALID');

  const unsignedEnvelope = {
    version: 1,
    stateEpoch: envelope.stateEpoch,
    proposedRevision: envelope.proposedRevision,
    envelopeSalt: envelope.envelopeSalt,
    previousEnvelopeDigest: envelope.previousEnvelopeDigest,
    ciphertext: envelope.ciphertext,
    writerPublicKey: envelope.writerPublicKey,
    aad: envelope.aad
  };
  const envelopeDigest = await computeEnvelopeDigest(unsignedEnvelope, writerSignature);
  const etag = computeEtag(envelope.stateEpoch, envelope.proposedRevision, envelopeDigest);

  const derivedKey = await deriveEnvelopeKey(params.roomKey, rawRoomId, envelopeSalt, envelope.stateEpoch, envelope.proposedRevision);
  const nonce = new Uint8Array(12);
  const decryptedBuffer = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: nonce, additionalData: aadBytes, tagLength: 128},
    derivedKey,
    ciphertextBytes
  );
  const automergeBytes = unpadPlaintext(new Uint8Array(decryptedBuffer));
  const val = JSON.parse(wasm_automerge_validate(automergeBytes, 475136));
  if (!val.ok) throw new Error(val.error?.code || 'REMOTE_STATE_INVALID');
  const projected = wasm_automerge_project(automergeBytes);
  return {automergeBytes, projectedState: JSON.parse(projected), envelopeDigest: encodeBase64Url(envelopeDigest), etag};
};

let initialized = false;
function ensureWasm() {
  if (initialized) return;
  const binary = atob(PHASE1_WASM_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  initSync({module: bytes});
  initialized = true;
}

self.onmessage = async (event) => {
  const {id, type} = event.data;
  try {
    ensureWasm();
    if (type === 'genesis') {
      const {initialJson, actorIdHex} = event.data;
      const bytes = wasm_automerge_genesis(initialJson, actorIdHex);
      const projected = wasm_automerge_project(bytes);
      self.postMessage({id, ok: true, bytes, projectedState: JSON.parse(projected)});
    } else if (type === 'apply_patch') {
      const {docBytes, patchJson, actorIdHex} = event.data;
      const bytes = wasm_automerge_apply_patch(docBytes, patchJson, actorIdHex);
      const projected = wasm_automerge_project(bytes);
      self.postMessage({id, ok: true, bytes, projectedState: JSON.parse(projected)});
    } else if (type === 'merge') {
      const {localBytes, remoteBytes} = event.data;
      const val = JSON.parse(wasm_automerge_validate(remoteBytes, 475136));
      if (!val.ok) throw new Error(val.error?.code || 'REMOTE_STATE_INVALID');
      const bytes = wasm_automerge_merge(localBytes, remoteBytes);
      const merged = JSON.parse(wasm_automerge_validate(bytes, 475136));
      if (!merged.ok) throw new Error(merged.error?.code || 'MERGED_STATE_INVALID');
      const projected = wasm_automerge_project(bytes);
      self.postMessage({id, ok: true, bytes, projectedState: JSON.parse(projected)});
    } else if (type === 'encrypt') {
      const result = await encryptSnapshot(event.data);
      self.postMessage({id, ok: true, ...result});
    } else if (type === 'decrypt') {
      const result = await decryptSnapshot(event.data);
      self.postMessage({id, ok: true, ...result});
    } else {
      self.postMessage({id, ok: false, error: 'UNKNOWN_COMMAND'});
    }
  } catch (err) {
    self.postMessage({id, ok: false, error: err instanceof Error ? err.message : String(err)});
  }
};
`;
writeFileSync(join(controller, 'state-worker.js'), stateWorkerSource);

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
const sharedFixtureBuild = spawnSync('cargo', ['run', '--quiet', '--locked', '-p', 'smallframe-core', '--example', 'generate_shared_test_package'], {cwd: root, encoding: 'utf8', env: childEnv});
if (sharedFixtureBuild.status !== 0) throw new Error(`SHARED_TEST_PACKAGE_BUILD_FAILED: ${sharedFixtureBuild.stderr}`);
const sharedFixture = JSON.parse(sharedFixtureBuild.stdout);
writeFileSync(join(phase1WasmOutput, 'shared-test-package.json'), JSON.stringify(sharedFixture));
const controllerReplacements = new Map([
  ['__RENDERER_DIGEST__', rendererDigest], ['__RENDERER_BOOTSTRAP_HASH__', rendererBootstrapHash],
  ['__RENDERER_CSS_HASH__', rendererCssHash], ['__RENDERER_WASM_EVAL_SOURCE__', wasmEvalSource],
  ['__PHASE0_WASM_BYTES__', String(phase0Wasm.byteLength)], ['__PHASE1_WASM_BYTES__', String(phase1Wasm.byteLength)],
  ['__CHANNEL_TEST_FIXTURE__', candidateUChannelFixture], ['__PHASE2_PACKAGE_BASE64__', phase2Package.toString('base64')],
  ['__SHARED_TEST_PACKAGE_BASE64__', sharedFixture.archiveBase64], ['__PHASE2_DEFAULT_FLAG__', phase2Default ? '1' : '0'],
  ['__PHASE2_EXPECTED_DIGEST__', phase2ExpectedDigest], ['__PHASE2_EXPECTED_KEY_ID__', phase2ExpectedKeyId],
  ['__ARCHITECTURE_CANDIDATE__', candidate]
]);
// Replace build constants before Vite can fold architecture branches, then
// bundle the actual shared protocol implementation rather than a copied verifier.
for (const name of ['main', 'shared-runtime']) {
  const result = await bundle({configFile: false, logLevel: 'silent', plugins: [{name: 'smallframe-build-constants',
    transform(code, id) {
      if (!id.endsWith('/apps/controller/src/main.ts')) return null;
      for (const [from, to] of controllerReplacements) code = code.replaceAll(from, to);
      return {code, map: null};
    }}], build: {write: false, target: 'es2022', minify: false,
    lib: {entry: join(root, 'apps/controller/src', `${name}.ts`), name: `smallframe_${name.replaceAll('-', '_')}`, formats: ['iife']}}});
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs.flatMap((output) => output.output).filter((chunk) => chunk.type === 'chunk');
  if (chunks.length !== 1) throw new Error('CONTROLLER_BUNDLE_INVALID');
  writeFileSync(join(controller, `${name}.js`), chunks[0].code);
}
let main = readFileSync(mainPath, 'utf8').replace(/\nexport \{\};\s*$/u, '').replaceAll('__RENDERER_DIGEST__', rendererDigest)
  .replaceAll('__RENDERER_BOOTSTRAP_HASH__', rendererBootstrapHash)
  .replaceAll('__RENDERER_CSS_HASH__', rendererCssHash)
  .replaceAll('__RENDERER_WASM_EVAL_SOURCE__', wasmEvalSource)
  .replaceAll('__PHASE0_WASM_BYTES__', String(phase0Wasm.byteLength))
  .replaceAll('__PHASE1_WASM_BYTES__', String(phase1Wasm.byteLength))
  .replaceAll('__CHANNEL_TEST_FIXTURE__', candidateUChannelFixture)
  .replaceAll('__PHASE2_PACKAGE_BASE64__', phase2Package.toString('base64'))
  .replaceAll('__SHARED_TEST_PACKAGE_BASE64__', sharedFixture.archiveBase64)
  .replaceAll('__PHASE2_DEFAULT_FLAG__', phase2Default ? '1' : '0')
  .replaceAll('__PHASE2_EXPECTED_DIGEST__', phase2ExpectedDigest)
  .replaceAll('__PHASE2_EXPECTED_KEY_ID__', phase2ExpectedKeyId)
  .replaceAll('__ARCHITECTURE_CANDIDATE__', candidate);
writeFileSync(mainPath, main);
for (const helper of ['personal-store.js', 'personal-runtime.js', 'shared-store.js', 'shared-runtime.js']) {
  const helperPath = join(controller, helper);
  if (existsSync(helperPath)) {
    writeFileSync(helperPath, readFileSync(helperPath, 'utf8').replace(/\nexport \{\};\s*$/u, '\n'));
  }
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
  '/shared-runtime.js',
  '/shared-store.js',
  '/state-worker.js',
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
