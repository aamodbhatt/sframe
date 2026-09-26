import {createHash, randomBytes} from 'node:crypto';
import {encryptSnapshot, computeEnvelopeDigest, computeEtag, decodeBase64Url} from '../packages/protocol/src/crypto-envelope.js';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {Miniflare} from 'miniflare';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {build} from 'vite';

const ROOT = resolve(import.meta.dirname, '..');
const CONTROLLER_ORIGIN = 'http://app.localhost:4173';
const WORKER_NAME = 'smallframe-phase3-do';
const DO_CLASS = 'RoomDurableObject';

let temporaryDirectory = '';
let miniflare: Miniflare;
let apiOrigin = '';

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const hash = (bytes: Uint8Array): Uint8Array => createHash('sha256').update(bytes).digest();
const roomId = (fill: number): string => base64url(Uint8Array.from({length: 16}, () => fill));
const capability = (fill: number): string => base64url(Uint8Array.from({length: 32}, () => fill));
const capabilityHash = (encoded: string): string => base64url(hash(Buffer.from(encoded, 'base64url')));
const authorization = (encoded: string): string => `SF-Cap ${encoded}`;

const initializeRoom = async (
  room: string,
  viewer: string,
  editor: string,
  ciphertext = Uint8Array.of(1),
  expiresAtMs = Date.now() + 3_600_000,
): Promise<Response> => fetch(
  `${apiOrigin}/__phase0/rooms/${room}/init`,
  {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      viewerCapHash: capabilityHash(viewer),
      editorCapHash: capabilityHash(editor),
      expiresAtMs,
      ciphertext: base64url(ciphertext),
    }),
  },
);

describe('SQLite Durable Object Phase 3 Protocol & Lifecycle', () => {
  it('returns a frozen encrypted candidate only to room members and rejects a corrupted stored candidate', async () => {
    const room = roomId(0x91);
    const viewer = capability(0x92);
    const editor = capability(0x93);
    const params = {roomKey: new Uint8Array(randomBytes(32)), writerPrivateKey: new Uint8Array(randomBytes(32)),
      roomId: room, appId: 'test.room', packageDigest: base64url(randomBytes(32)), stateEpoch: 0,
      proposedRevision: 1, previousEnvelopeDigest: base64url(new Uint8Array(32)), automergeBytes: Uint8Array.of(1, 2, 3)};
    const genesis = await encryptSnapshot(params);
    const init = await fetch(`${apiOrigin}/__phase0/rooms/${room}/init-envelope`, {method: 'POST', body: JSON.stringify({
      viewerCapHash: capabilityHash(viewer), editorCapHash: capabilityHash(editor),
      expiresAtMs: Date.now() + 60_000, envelope: genesis.envelope
    })});
    expect(init.status).toBe(201);
    const storage = await miniflare.unsafeGetDurableObjectStorage(WORKER_NAME, DO_CLASS, {name: room});
    await storage.exec("UPDATE room_state SET recovery_status = 'RECOVERY_REQUIRED'");
    const url = `${apiOrigin}/v1/rooms/${room}/state`;
    const headers = {Origin: CONTROLLER_ORIGIN, Authorization: authorization(viewer), 'If-None-Match': genesis.etag};
    expect((await fetch(url, {headers: {Origin: CONTROLLER_ORIGIN}})).status).toBe(403);
    const frozen = await fetch(url, {headers});
    expect(frozen.status).toBe(503);
    expect(frozen.headers.get('ETag')).toBe(genesis.etag);
    const response = await frozen.json() as Record<string, unknown>;
    expect(response).toMatchObject({status: 'RECOVERY_REQUIRED', stateEpoch: 0, revision: 1,
      envelopeDigest: base64url(genesis.envelopeDigest), etag: genesis.etag,
      candidateEnvelope: genesis.envelope, repairStatement: null});
    const next = await encryptSnapshot({...params, proposedRevision: 2, previousEnvelopeDigest: base64url(genesis.envelopeDigest)});
    expect((await fetch(url, {method: 'PUT', headers: {Origin: CONTROLLER_ORIGIN,
      Authorization: authorization(editor), 'If-Match': genesis.etag, 'Content-Type': 'application/json'},
    body: JSON.stringify(next.envelope)})).status).toBe(503);
    await storage.exec('UPDATE room_state SET envelope_digest = ?', base64url(randomBytes(32)));
    expect((await fetch(url, {headers})).status).toBe(409);
  });

  it('rejects a stalled encrypted upload without advancing the head and permits a valid retry', async () => {
    const room = base64url(randomBytes(16));
    const viewer = base64url(randomBytes(32));
    const editor = base64url(randomBytes(32));
    const params = {roomKey: new Uint8Array(randomBytes(32)), writerPrivateKey: new Uint8Array(randomBytes(32)),
      roomId: room, appId: 'test.room', packageDigest: base64url(randomBytes(32)), stateEpoch: 0,
      proposedRevision: 1, previousEnvelopeDigest: base64url(new Uint8Array(32)), automergeBytes: Uint8Array.of(1)};
    const genesis = await encryptSnapshot(params);
    const init = await fetch(`${apiOrigin}/__phase0/rooms/${room}/init-envelope`, {method: 'POST', body: JSON.stringify({
      viewerCapHash: capabilityHash(viewer), editorCapHash: capabilityHash(editor),
      expiresAtMs: Date.now() + 60_000, envelope: genesis.envelope
    })});
    expect(init.status).toBe(201);
    const endpoint = `${apiOrigin}/v1/rooms/${room}/state`;
    const headers = {Origin: CONTROLLER_ORIGIN, Authorization: authorization(editor),
      'If-Match': genesis.etag, 'Content-Type': 'application/json'};
    const abort = new AbortController();
    try {
      const body = new ReadableStream<Uint8Array>({start(controller) { controller.enqueue(Uint8Array.of(123)); }});
      const stalled = await fetch(endpoint, {method: 'PUT', headers, body, duplex: 'half', signal: abort.signal} as RequestInit);
      expect(stalled.status).toBe(400);
      expect((await stalled.json() as {title: string}).title).toBe('BODY_INVALID');
    } finally { abort.abort(); }
    const retained = await fetch(endpoint, {headers: {Origin: CONTROLLER_ORIGIN, Authorization: authorization(viewer), 'If-None-Match': genesis.etag}});
    expect(retained.status).toBe(304);
    const next = await encryptSnapshot({...params, proposedRevision: 2, previousEnvelopeDigest: base64url(genesis.envelopeDigest)});
    expect((await fetch(endpoint, {method: 'PUT', headers, body: JSON.stringify(next.envelope)})).status).toBe(204);
  }, 15_000);
  it('pins encrypted genesis and rejects raw downgrade, wrong writer/package, viewer writes, forged signatures and legacy recovery', async () => {
    const room = base64url(randomBytes(16));
    const viewer = base64url(randomBytes(32));
    const editor = base64url(randomBytes(32));
    const params = {roomKey: new Uint8Array(randomBytes(32)), writerPrivateKey: new Uint8Array(randomBytes(32)),
      roomId: room, appId: 'test.room', packageDigest: base64url(randomBytes(32)), stateEpoch: 0,
      proposedRevision: 1, previousEnvelopeDigest: base64url(new Uint8Array(32)), automergeBytes: Uint8Array.of(1, 2, 3)};
    const genesis = await encryptSnapshot(params);
    const bootstrapBody = JSON.stringify({
      viewerCapHash: capabilityHash(viewer), editorCapHash: capabilityHash(editor), expiresAtMs: Date.now() + 60_000, envelope: genesis.envelope
    });
    const bootstrap = (body: string) => fetch(`${apiOrigin}/__phase0/rooms/${room}/init-envelope`, {method: 'POST', body});
    expect((await bootstrap('{"expiresAtMs":1,' + bootstrapBody.slice(1))).status).toBe(400);
    expect((await bootstrap(bootstrapBody.replace('"envelope":{', '"envelope":{"version":1,'))).status).toBe(400);
    const init = await bootstrap(bootstrapBody);
    expect(init.status).toBe(201);
    const nextParams = {...params, proposedRevision: 2, previousEnvelopeDigest: base64url(genesis.envelopeDigest)};
    const next = await encryptSnapshot(nextParams);
    const put = (body: unknown, cap = editor, contentType = 'application/json') => fetch(`${apiOrigin}/v1/rooms/${room}/state`, {
      method: 'PUT', headers: {Origin: CONTROLLER_ORIGIN, Authorization: authorization(cap), 'If-Match': genesis.etag, 'Content-Type': contentType},
      body: JSON.stringify(body)
    });
    expect((await put({untrusted: true}, editor, 'application/octet-stream')).status).toBe(400);
    expect((await put({version: 1})).status).toBe(400);
    expect((await put(next.envelope, viewer)).status).toBe(403);
    const putRaw = (body: string | Uint8Array) => fetch(`${apiOrigin}/v1/rooms/${room}/state`, {
      method: 'PUT', headers: {Origin: CONTROLLER_ORIGIN, Authorization: authorization(editor),
        'If-Match': genesis.etag, 'Content-Type': 'application/json'}, body
    });
    const serialized = JSON.stringify(next.envelope);
    const ambiguous = [
      '{"version":1,' + serialized.slice(1),
      '{"\\u0076ersion":1,' + serialized.slice(1),
      serialized.replace('"aad":{', '"aad":{"protocolVersion":1,'),
      '{"ignored":' + '['.repeat(33) + '0' + ']'.repeat(33) + ',' + serialized.slice(1)
    ];
    for (const body of ambiguous) expect((await putRaw(body)).status).toBe(400);
    const invalidUtf8 = new Uint8Array([123, 34, 255, 34, 58, 49, 125]);
    expect((await putRaw(invalidUtf8)).status).toBe(400);
    const {revision, ...withoutRevision} = next.envelope;
    expect((await put({...withoutRevision, proposedRevision: revision})).status).toBe(400);
    expect((await put({...next.envelope, proposedRevision: revision})).status).toBe(400);
    expect((await put({...next.envelope, aad: {...next.envelope.aad, proposedRevision: revision + 1}})).status).toBe(400);
    const read = (etag = genesis.etag) => fetch(`${apiOrigin}/v1/rooms/${room}/state`, {
      headers: {Origin: CONTROLLER_ORIGIN, Authorization: authorization(viewer), 'If-None-Match': etag}
    });
    expect((await read()).status).toBe(304);
    // Simulate a pre-correction persisted head without rewriting its ciphertext.
    const {writerSignature, revision: genesisRevision, ...genesisRest} = genesis.envelope;
    const legacyDigest = await computeEnvelopeDigest({...genesisRest, proposedRevision: genesisRevision}, decodeBase64Url(writerSignature));
    const storage = await miniflare.unsafeGetDurableObjectStorage(WORKER_NAME, DO_CLASS, {name: room});
    await storage.exec('UPDATE room_state SET envelope_digest = ?, etag = ?', base64url(legacyDigest), computeEtag(0, 1, legacyDigest));
    expect((await read(computeEtag(0, 1, legacyDigest))).status).toBe(409);
    expect((await put(next.envelope)).status).toBe(409);
    const retained = await storage.exec<{unchanged: number}>('SELECT (revision = 1 AND envelope_digest = ? AND envelope_salt = ?) AS unchanged FROM room_state', base64url(legacyDigest), genesis.envelope.envelopeSalt);
    expect(retained).toEqual([{unchanged: 1}]);
    // Restore only the test metadata and prove subsequent valid writes still work.
    await storage.exec('UPDATE room_state SET envelope_digest = ?, etag = ?', base64url(genesis.envelopeDigest), genesis.etag);
    const forged = {...next.envelope, writerSignature: base64url(randomBytes(64))};
    expect((await put(forged)).status).toBe(400);
    const wrongWriter = await encryptSnapshot({...nextParams, writerPrivateKey: new Uint8Array(randomBytes(32))});
    expect((await put(wrongWriter.envelope)).status).toBe(403);
    const wrongPackage = await encryptSnapshot({...nextParams, packageDigest: base64url(randomBytes(32))});
    expect((await put(wrongPackage.envelope)).status).toBe(403);
    const winners = await Promise.all([put(next.envelope), put(next.envelope)]);
    expect(winners.map((r) => r.status).sort()).toEqual([204, 409]);
    const unsignedRepair = await fetch(`${apiOrigin}/v1/rooms/${room}/request-repair`, {method: 'POST',
      headers: {Origin: CONTROLLER_ORIGIN, Authorization: authorization(editor), 'If-Match': next.etag},
      body: '{}'});
    expect(unsignedRepair.status).toBe(503);
    expect((await read(next.etag)).status).toBe(304);
    const recovery = await fetch(`${apiOrigin}/v1/rooms/${room}/recover`, {method: 'POST',
      headers: {Origin: CONTROLLER_ORIGIN, Authorization: authorization(editor)}, body: '{}'});
    expect(recovery.status).toBe(503);
  });
  beforeAll(async () => {
    const testRoot = join(ROOT, '.wrangler');
    await mkdir(testRoot, {recursive: true});
    temporaryDirectory = await mkdtemp(join(testRoot, 'phase3-do-'));
    const entry = join(temporaryDirectory, 'worker.mjs');
    await build({
      configFile: false,
      root: ROOT,
      build: {
        lib: {entry: resolve(ROOT, 'apps/api/src/do-test-worker.ts'), formats: ['es'], fileName: () => 'worker.mjs'},
        outDir: temporaryDirectory,
        emptyOutDir: true,
        target: 'es2022',
        minify: false,
        sourcemap: false,
        rollupOptions: {external: ['cloudflare:workers']},
      },
      logLevel: 'silent',
    });

    miniflare = new Miniflare({
      modules: true,
      scriptPath: entry,
      name: WORKER_NAME,
      compatibilityDate: '2026-07-30',
      host: '127.0.0.1',
      port: 0,
      bindings: {
        CONTROLLER_ORIGIN,
        ENVIRONMENT: 'local',
        BUILD_VERSION: 'local',
        API_ORIGIN: 'http://api.localhost:8787',
        WEBSOCKET_ORIGIN: 'ws://api.localhost:8787',
        PHASE0_HOLD_MS: '120',
        PHASE0_MAX_TRANSPORTS: '1',
      },
      d1Databases: ['DB'],
      r2Buckets: ['PACKAGES'],
      durableObjects: {ROOMS: {className: DO_CLASS, useSQLite: true}},
      unsafeInspectDurableObjects: true,
    });

    const url = await miniflare.ready;
    apiOrigin = url.origin;
  });

  afterAll(async () => {
    await miniflare?.dispose();
    if (temporaryDirectory) await rm(temporaryDirectory, {recursive: true, force: true});
  });

  it('reads room metadata with valid viewer capability', async () => {
    const room = roomId(0x51);
    const viewer = capability(0x52);
    const editor = capability(0x53);

    const init = await initializeRoom(room, viewer, editor);
    expect(init.status).toBe(201);

    const metaRes = await fetch(`${apiOrigin}/v1/rooms/${room}`, {
      headers: {Authorization: authorization(viewer), Origin: CONTROLLER_ORIGIN},
    });

    expect(metaRes.status).toBe(200);
    const meta = await metaRes.json();
    expect(meta.roomId).toBe(room);
    expect(meta.stateEpoch).toBe(0);
    expect(meta.revision).toBe(1);
    expect(meta.isRevoked).toBe(false);
  });

  it('rotates room capability links atomically and invalidates old capabilities', async () => {
    const room = roomId(0x61);
    const viewer1 = capability(0x62);
    const editor1 = capability(0x63);
    const viewer2 = capability(0x64);
    const editor2 = capability(0x65);

    await initializeRoom(room, viewer1, editor1);

    // Old viewer can read state
    const readOld = await fetch(`${apiOrigin}/v1/rooms/${room}/state`, {
      headers: {Authorization: authorization(viewer1), Origin: CONTROLLER_ORIGIN},
    });
    expect(readOld.status).toBe(200);

    // Rotate links using editor1 authority
    const rotateRes = await fetch(`${apiOrigin}/v1/rooms/${room}/rotate-links`, {
      method: 'POST',
      headers: {
        Authorization: authorization(editor1),
        'Content-Type': 'application/json',
        Origin: CONTROLLER_ORIGIN,
      },
      body: JSON.stringify({
        viewerCapHash: capabilityHash(viewer2),
        editorCapHash: capabilityHash(editor2),
      }),
    });
    expect(rotateRes.status).toBe(200);

    // Old viewer is now rejected (403)
    const readOldAfter = await fetch(`${apiOrigin}/v1/rooms/${room}/state`, {
      headers: {Authorization: authorization(viewer1), Origin: CONTROLLER_ORIGIN},
    });
    expect(readOldAfter.status).toBe(403);

    // New viewer can read state
    const readNew = await fetch(`${apiOrigin}/v1/rooms/${room}/state`, {
      headers: {Authorization: authorization(viewer2), Origin: CONTROLLER_ORIGIN},
    });
    expect(readNew.status).toBe(200);
  });

  it('revokes room and rejects all future capability accesses', async () => {
    const room = roomId(0x71);
    const viewer = capability(0x72);
    const editor = capability(0x73);

    await initializeRoom(room, viewer, editor);

    // Revoke using editor authority
    const revokeRes = await fetch(`${apiOrigin}/v1/rooms/${room}/revoke`, {
      method: 'POST',
      headers: {
        Authorization: authorization(editor),
        Origin: CONTROLLER_ORIGIN,
      },
    });
    expect(revokeRes.status).toBe(200);

    // Future state read is rejected
    const readAfter = await fetch(`${apiOrigin}/v1/rooms/${room}/state`, {
      headers: {Authorization: authorization(viewer), Origin: CONTROLLER_ORIGIN},
    });
    expect(readAfter.status).toBe(403);
  });

  it('freezes room on request-repair and recovers forward to new epoch', async () => {
    const room = roomId(0x81);
    const viewer = capability(0x82);
    const editor = capability(0x83);

    await initializeRoom(room, viewer, editor, Uint8Array.of(1, 2, 3));
    const stateUrl = `${apiOrigin}/v1/rooms/${room}/state`;
    const initial = await fetch(stateUrl, {headers: {Authorization: authorization(viewer), Origin: CONTROLLER_ORIGIN}});
    const initialEtag = initial.headers.get('ETag');
    expect(initialEtag).toBeTruthy();
    const repairUrl = `${apiOrigin}/v1/rooms/${room}/request-repair`;
    const repairHeaders = {Authorization: authorization(editor), Origin: CONTROLLER_ORIGIN, 'If-Match': initialEtag!};
    expect((await fetch(repairUrl, {method: 'POST', headers: {Authorization: authorization(viewer), Origin: CONTROLLER_ORIGIN, 'If-Match': initialEtag!}})).status).toBe(403);
    expect((await fetch(repairUrl, {method: 'POST', headers: {Authorization: authorization(editor), Origin: CONTROLLER_ORIGIN}})).status).toBe(409);
    expect((await fetch(repairUrl, {method: 'POST', headers: {...repairHeaders, 'If-Match': '"stale"'}})).status).toBe(409);
    expect((await fetch(stateUrl, {headers: {Authorization: authorization(viewer), Origin: CONTROLLER_ORIGIN, 'If-None-Match': initialEtag!}})).status).toBe(304);
    const recoverUrl = `${apiOrigin}/v1/rooms/${room}/recover`;
    const recoveryHeaders = {Authorization: authorization(editor), 'Content-Type': 'application/json', Origin: CONTROLLER_ORIGIN, 'If-Match': initialEtag!};
    const recoveryBody = {newEpoch: 1, ciphertext: base64url(Uint8Array.of(9, 9, 9))};
    expect((await fetch(recoverUrl, {method: 'POST', headers: recoveryHeaders, body: JSON.stringify(recoveryBody)})).status).toBe(409);

    // Request repair
    const repairRes = await fetch(repairUrl, {
      method: 'POST',
      headers: repairHeaders,
    });
    expect(repairRes.status).toBe(200);
    expect((await fetch(repairUrl, {method: 'POST', headers: repairHeaders})).status).toBe(409);
    for (const body of [
      {...recoveryBody, newEpoch: 3},
      {...recoveryBody, extra: true},
      {...recoveryBody, ciphertext: 'AAAA='},
    ]) {
      expect((await fetch(recoverUrl, {method: 'POST', headers: recoveryHeaders, body: JSON.stringify(body)})).status).toBe(400);
    }
    expect((await fetch(recoverUrl, {method: 'POST', headers: {...recoveryHeaders, 'If-Match': '"stale"'}, body: JSON.stringify(recoveryBody)})).status).toBe(409);

    // Recover forward to epoch 1
    const recoverRes = await fetch(recoverUrl, {
      method: 'POST',
      headers: recoveryHeaders,
      body: JSON.stringify(recoveryBody),
    });
    expect(recoverRes.status).toBe(200);
    const recovered = await recoverRes.json();
    expect(recovered.epoch).toBe(1);
    expect(recovered.revision).toBe(1);
    expect((await fetch(recoverUrl, {method: 'POST', headers: recoveryHeaders, body: JSON.stringify(recoveryBody)})).status).toBe(409);

    // Read state in new epoch
    const stateRes = await fetch(`${apiOrigin}/v1/rooms/${room}/state`, {
      headers: {Authorization: authorization(viewer), Origin: CONTROLLER_ORIGIN},
    });
    expect(stateRes.status).toBe(200);
    expect(stateRes.headers.get('X-Smallframe-State-Epoch')).toBe('1');
    expect(stateRes.headers.get('X-Smallframe-Revision')).toBe('1');
  });
});
