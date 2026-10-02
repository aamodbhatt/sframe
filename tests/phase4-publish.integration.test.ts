import {createCipheriv, createDecipheriv, createHash, createPrivateKey, randomBytes} from 'node:crypto';
import {execFile, spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {promisify} from 'node:util';
import {cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it, beforeAll, afterAll} from 'vitest';
import {Miniflare} from 'miniflare';
import type {D1Database} from '@cloudflare/workers-types';
import {DurableRoomStorage, type PublisherRoomNamespace} from '../apps/api/src/durable-room-storage.js';
import {build} from 'vite';
import {compiledVerifierPlugin} from '../scripts/compiled-verifier-plugin.mjs';
import {getPublicKeyAsync, utils} from '@noble/ed25519';
import {
  createSignedEnrollment,
  createSignedRoomDescriptor,
  encodeBase64Url,
  decodeBase64Url,
  encryptSnapshot,
  decryptSnapshot,
  parseInviteFragment,
} from '../packages/protocol/src/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const CONTROLLER_ORIGIN = 'http://app.localhost:4173';
const WORKER_NAME = 'smallframe-phase4-publish';
const DO_CLASS = 'RoomDurableObject';

let temporaryDirectory = '';
let miniflare: Miniflare;
let workerOptions: ConstructorParameters<typeof Miniflare>[0];
let apiOrigin = '';

describe('local publishing prototype and capability-scoped package retrieval', () => {
  beforeAll(async () => {
    const testRoot = join(ROOT, '.wrangler');
    await mkdir(testRoot, {recursive: true});
    temporaryDirectory = await mkdtemp(join(testRoot, 'phase4-publish-'));
    const entry = join(temporaryDirectory, 'worker.mjs');
    await build({
      plugins: [compiledVerifierPlugin({worker: true})],
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

    workerOptions = {
      unsafeInspectDurableObjects: true,
      modules: true,
      modulesRoot: temporaryDirectory,
      modulesRules: [{type: 'CompiledWasm', include: ['**/*.wasm']}],
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
      d1Persist: join(temporaryDirectory, 'd1-storage'),
      r2Persist: join(temporaryDirectory, 'r2-storage'),
      durableObjectsPersist: join(temporaryDirectory, 'do-storage'),
      r2Buckets: ['PACKAGES'],
      durableObjects: {
        ROOMS: {className: DO_CLASS, useSQLite: true},
      },
    };
    miniflare = new Miniflare(workerOptions);

    const url = await miniflare.ready;
    apiOrigin = url.origin;
  });

  afterAll(async () => {
    if (miniflare) await miniflare.dispose();
    if (temporaryDirectory) await rm(temporaryDirectory, {recursive: true, force: true});
  });

  it('publishes a real signed package and encrypted Automerge genesis with the native CLI', async () => {
    const built = spawnSync('cargo', ['build', '--locked', '-q', '-p', 'smallframe-cli'], {cwd: ROOT, encoding: 'utf8'});
    if (built.status !== 0) throw new Error('CLI_BUILD_FAILED');
    const binary = join(ROOT, 'target', 'debug', 'smallframe-cli');
    const store = await mkdtemp(join(temporaryDirectory, 'publisher-'));
    const run = async (...args: string[]): Promise<Record<string, any>> => {
      try {
        const result = await promisify(execFile)(binary, ['--json', '--test-store', store, ...args],
          {cwd: ROOT, encoding: 'utf8', maxBuffer: 32_768});
        return JSON.parse(result.stdout) as Record<string, any>;
      } catch (error) {
        let code = 'CLI_COMMAND_FAILED';
        try {
          const stderr = String((error as {stderr?: unknown}).stderr ?? '');
          const parsed = JSON.parse(stderr) as {error?: {code?: unknown}};
          if (typeof parsed.error?.code === 'string') {
            const candidate = parsed.error.code.split(':')[0]!;
            if (/^[A-Z_]+$/u.test(candidate)) code = candidate;
          }
        } catch { /* Failures never include request bodies or secret URLs. */ }
        if (code === 'CLI_COMMAND_FAILED') {
          const detail = error as {stderr?: unknown; stdout?: unknown; code?: unknown; signal?: unknown};
          const stderr = String(detail.stderr ?? '');
          throw new Error(`CLI_COMMAND_FAILED:${stderr.length}:${stderr.trimStart().startsWith('{')}:${String(detail.code)}:${String(detail.signal)}:${String(detail.stdout ?? '').length}`);
        }
        throw new Error(code);
      }
    };
    await run('identity', 'init');
    const inviteCode = randomBytes(24).toString('base64url');
    const inviteFile = join(store, 'test-invite.txt');
    await writeFile(inviteFile, inviteCode, {mode: 0o600});
    const invite = await fetch(`${apiOrigin}/v1/admin/invite`, {method: 'POST', headers: {Origin: CONTROLLER_ORIGIN,
      'Content-Type': 'application/json'}, body: JSON.stringify({code: inviteCode})});
    expect(invite.status).toBe(201);
    const requestDigests: string[] = [];
    let loseConfirmation = true;
    let extraConfirmationField = true;
    const proxy = createServer(async (request, response) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk as Uint8Array);
      const bytes = Buffer.concat(chunks);
      requestDigests.push(createHash('sha256').update(bytes).digest('hex'));
      try {
        const upstream = await fetch(`${apiOrigin}/v1/enroll`, {method: 'POST',
          headers: {Origin: CONTROLLER_ORIGIN, 'Content-Type': 'application/json'}, body: bytes});
        response.writeHead(loseConfirmation ? 503 : upstream.status, {'Content-Type': 'application/json'});
        const confirmation = await upstream.json() as Record<string, unknown>;
        if (!loseConfirmation && extraConfirmationField) {
          confirmation.unexpected = true;
          extraConfirmationField = false;
        }
        response.end(loseConfirmation ? '{"error":"confirmation_lost"}' : JSON.stringify(confirmation));
        loseConfirmation = false;
      } catch {
        response.writeHead(502).end();
      }
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('TEST_PROXY_ADDRESS_INVALID');
    const enrollmentApiUrl = `http://127.0.0.1:${address.port}`;
    try {
      await expect(run('enroll', '--invite-file', inviteFile, '--api-url', enrollmentApiUrl))
        .rejects.toThrow('ENROLLMENT_PENDING_USE_OPERATIONS_RESUME');
      await rm(inviteFile);
      const pendingEnrollment = await readFile(join(store, 'enrollment-pending.json'), 'utf8');
      expect(pendingEnrollment).not.toContain('apiToken');
      expect(pendingEnrollment).not.toContain('requestBytes');
      expect((await run('operations', 'status', 'enrollment')).localStatus).toBe('PENDING');
      await expect(run('enroll', '--api-url', enrollmentApiUrl))
        .rejects.toThrow('ENROLLMENT_PENDING_USE_OPERATIONS_RESUME');
      expect(requestDigests).toHaveLength(1);
      const pendingFile = join(store, 'enrollment-pending.json');
      const sealedPending = JSON.parse(pendingEnrollment) as {nonce: string; ciphertext: string};
      const unlockKey = await readFile(join(store, 'unlock.key'));
      const pendingAad = Buffer.from('smallframe/local-secret/v1\0enrollment-pending');
      const pendingCiphertext = Buffer.from(sealedPending.ciphertext, 'base64url');
      const pendingDecipher = createDecipheriv('aes-256-gcm', unlockKey, Buffer.from(sealedPending.nonce, 'base64url'));
      pendingDecipher.setAAD(pendingAad);
      pendingDecipher.setAuthTag(pendingCiphertext.subarray(-16));
      const pendingRecord = JSON.parse(Buffer.concat([
        pendingDecipher.update(pendingCiphertext.subarray(0, -16)), pendingDecipher.final(),
      ]).toString()) as Record<string, unknown>;
      pendingRecord.requestSha256 = randomBytes(32).toString('base64url');
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', unlockKey, nonce);
      cipher.setAAD(pendingAad);
      const corrupted = Buffer.concat([cipher.update(JSON.stringify(pendingRecord)), cipher.final(), cipher.getAuthTag()]);
      await writeFile(pendingFile, JSON.stringify({schemaVersion: 1, nonce: nonce.toString('base64url'),
        ciphertext: corrupted.toString('base64url')}));
      await expect(run('operations', 'resume', 'enrollment')).rejects.toThrow('ENROLLMENT_PENDING_INVALID');
      expect(requestDigests).toHaveLength(1);
      await writeFile(pendingFile, pendingEnrollment);
      const alteredRequest = JSON.parse(Buffer.from(String(pendingRecord.requestBytes), 'base64url').toString()) as Record<string, unknown>;
      alteredRequest.signature = randomBytes(64).toString('base64url');
      const alteredBytes = Buffer.from(JSON.stringify(alteredRequest));
      pendingRecord.requestBytes = alteredBytes.toString('base64url');
      pendingRecord.requestSha256 = createHash('sha256').update(alteredBytes).digest('base64url');
      const signatureNonce = randomBytes(12);
      const signatureCipher = createCipheriv('aes-256-gcm', unlockKey, signatureNonce);
      signatureCipher.setAAD(pendingAad);
      const altered = Buffer.concat([signatureCipher.update(JSON.stringify(pendingRecord)), signatureCipher.final(), signatureCipher.getAuthTag()]);
      await writeFile(pendingFile, JSON.stringify({schemaVersion: 1, nonce: signatureNonce.toString('base64url'),
        ciphertext: altered.toString('base64url')}));
      await expect(run('operations', 'resume', 'enrollment')).rejects.toThrow('ENROLLMENT_PENDING_INVALID');
      expect(requestDigests).toHaveLength(1);
      await writeFile(pendingFile, pendingEnrollment);
      await expect(run('operations', 'resume', 'enrollment')).rejects.toThrow('ENROLLMENT_RESPONSE_MISMATCH');
      expect((await run('operations', 'status', 'enrollment')).localStatus).toBe('PENDING');
      await run('operations', 'resume', 'enrollment');
      expect((await run('operations', 'status', 'enrollment')).localStatus).toBe('CONFIRMED');
      await expect(run('enroll', '--api-url', enrollmentApiUrl)).rejects.toThrow('PUBLISHER_ALREADY_ENROLLED');
      expect(requestDigests).toHaveLength(3);
      expect(requestDigests[1]).toBe(requestDigests[0]);
      expect(requestDigests[2]).toBe(requestDigests[0]);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
    const source = join(temporaryDirectory, 'publish-source');
    await cp(join(ROOT, 'examples', 'decision-board', 'package'), source, {recursive: true});
    const uploadDigests: string[] = [];
    const uploadOperations: string[] = [];
    let dropUpload = true;
    let unexpectedUploadField = true;
    const uploadProxy = createServer(async (request, response) => {
      try {
        const chunks: Uint8Array[] = [];
        for await (const chunk of request) chunks.push(chunk as Uint8Array);
        const bytes = Buffer.concat(chunks);
        uploadDigests.push(createHash('sha256').update(bytes).digest('hex'));
        uploadOperations.push(String(request.headers['idempotency-key']));
        const upstream = await fetch(`${apiOrigin}/v1/packages`, {method: 'POST', body: bytes,
          headers: {Origin: CONTROLLER_ORIGIN, 'Content-Type': 'application/vnd.smallframe.package',
            Authorization: String(request.headers.authorization),
            'Idempotency-Key': String(request.headers['idempotency-key']),
            'X-Smallframe-Package-Digest': String(request.headers['x-smallframe-package-digest'])}});
        const confirmation = await upstream.json() as Record<string, unknown>;
        if (!dropUpload && unexpectedUploadField) { confirmation.unexpected = true; unexpectedUploadField = false; }
        response.writeHead(dropUpload ? 503 : upstream.status, {'Content-Type': 'application/json'});
        response.end(dropUpload ? '{}' : JSON.stringify(confirmation));
        dropUpload = false;
      } catch { response.writeHead(502).end(); }
    });
    await new Promise<void>((resolve) => uploadProxy.listen(0, '127.0.0.1', resolve));
    const uploadAddress = uploadProxy.address();
    if (!uploadAddress || typeof uploadAddress === 'string') throw new Error('UPLOAD_PROXY_ADDRESS_INVALID');
    try {
      const uploadApiUrl = `http://127.0.0.1:${uploadAddress.port}`;
      await expect(run('publish', source, '--api-url', uploadApiUrl)).rejects.toThrow('PACKAGE_UPLOAD_PENDING');
      const journals = (await readdir(store)).filter((name) => /^upload-[A-Za-z0-9_-]{43}\.json$/u.test(name));
      expect(journals).toHaveLength(1);
      const digest = journals[0]!.slice(7, -5);
      const reference = `upload:${digest}`;
      const journalPath = join(store, journals[0]!);
      const savedJournal = await readFile(journalPath, 'utf8');
      expect(savedJournal.includes('apiToken')).toBe(false);
      expect(savedJournal.includes('requestBytes')).toBe(false);
      expect((await run('operations', 'status', reference)).localStatus).toBe('PENDING');
      await expect(run('publish', source, '--api-url', apiOrigin)).rejects.toThrow('PACKAGE_UPLOAD_REQUEST_CONFLICT');
      await writeFile(journalPath, '{}');
      await expect(run('operations', 'resume', reference)).rejects.toThrow();
      expect(uploadDigests).toHaveLength(1);
      await writeFile(journalPath, savedJournal);
      const savedWorker = await readFile(join(source, 'app.worker.js'));
      await rm(join(source, 'app.worker.js'));
      await expect(run('operations', 'resume', reference)).rejects.toThrow('PACKAGE_UPLOAD_PENDING');
      expect((await run('operations', 'status', reference)).localStatus).toBe('PENDING');
      await run('operations', 'resume', reference);
      expect((await run('operations', 'status', reference)).localStatus).toBe('CONFIRMED');
      expect(uploadDigests).toHaveLength(3);
      expect(new Set(uploadDigests).size).toBe(1);
      expect(new Set(uploadOperations).size).toBe(1);
      await writeFile(join(source, 'app.worker.js'), savedWorker);
      // Test-only removal lets the independent existing publication path below
      // exercise its original API target; production offers no local abandon shortcut.
      await rm(journalPath);
    } finally { await new Promise<void>((resolve) => uploadProxy.close(() => resolve())); }
    const oversizedSource = join(temporaryDirectory, 'oversized-publish-source');
    await cp(join(ROOT, 'examples/decision-board/package'), oversizedSource, {recursive: true});
    const oversizedWorker = join(oversizedSource, 'app.worker.js');
    await writeFile(oversizedWorker, `${await readFile(oversizedWorker, 'utf8')}\n/*${'x'.repeat(9_000)}*/`);
    const oversizedManifestPath = join(oversizedSource, 'smallframe.json');
    const oversizedManifest = JSON.parse(await readFile(oversizedManifestPath, 'utf8')) as Record<string, any>;
    const oversizedModule = await readFile(oversizedWorker);
    oversizedManifest.files['app.worker.js'] = {bytes: oversizedModule.byteLength,
      sha256: createHash('sha256').update(oversizedModule).digest('base64url')};
    await writeFile(oversizedManifestPath, JSON.stringify(oversizedManifest));
    await expect(run('publish', oversizedSource, '--api-url', apiOrigin)).rejects.toThrow('PACKAGE_UPLOAD_LOCAL_BETA_SIZE_LIMIT');
    expect((await readdir(store)).filter((name) => name.startsWith('upload-'))).toHaveLength(0);
    let db = await miniflare.getD1Database('DB') as unknown as D1Database;
    await new DurableRoomStorage(db, async () => {}).initialize();
    await db.prepare("CREATE TRIGGER room_activation_fault BEFORE UPDATE OF status ON rooms WHEN NEW.status='ACTIVE' BEGIN SELECT RAISE(ABORT,'TEST_ROOM_ACTIVATION_FAULT'); END").run();
    await expect(run('publish', source, '--api-url', apiOrigin, '--show-secrets')).rejects.toThrow('ROOM_CREATION_PENDING');
    const pendingRooms = (await readdir(store)).filter((name) => /^room-[A-Za-z0-9_-]{22}\.json$/u.test(name));
    expect(pendingRooms).toHaveLength(1);
    const pendingRoomId = pendingRooms[0]!.slice(5, -5);
    expect((await run('operations', 'status', pendingRoomId)).localStatus).toBe('PENDING');
    expect((await db.prepare('SELECT state FROM publisher_room_operations WHERE roomId=?').bind(pendingRoomId).first<{state: string}>())?.state).toBe('DO_ACTIVE_WITH_GENESIS');
    expect((await db.prepare('SELECT status FROM rooms WHERE id=?').bind(pendingRoomId).first<{status: string}>())?.status).toBe('PENDING');
    const sameOrigin = apiOrigin; const port = Number(new URL(apiOrigin).port);
    await miniflare.dispose();
    miniflare = new Miniflare({...workerOptions, port});
    apiOrigin = (await miniflare.ready).origin;
    expect(apiOrigin).toBe(sameOrigin);
    db = await miniflare.getD1Database('DB') as unknown as D1Database;
    await db.prepare('DROP TRIGGER room_activation_fault').run();
    await rm(join(source, 'app.worker.js'));
    const published = await run('operations', 'resume', pendingRoomId, '--show-secrets');
    expect((await db.prepare('SELECT status FROM rooms WHERE id=?').bind(pendingRoomId).first<{status: string}>())?.status).toBe('ACTIVE');
    expect(published.ok).toBe(true);
    const viewer = await parseInviteFragment(new URL(published.viewerInviteUrl).hash);
    const editor = await parseInviteFragment(new URL(published.editorInviteUrl).hash);
    expect(viewer.descriptor.packageDigest).toBe(published.packageDigest);
    expect(editor.descriptor.packageDigest).toBe(published.packageDigest);
    const headers = {Origin: CONTROLLER_ORIGIN, Authorization: `SF-Cap ${encodeBase64Url(viewer.capability)}`};
    const packageResponse = await fetch(`${apiOrigin}/v1/rooms/${viewer.descriptor.roomId}/packages/${published.packageDigest}`, {headers});
    expect(packageResponse.status).toBe(200);
    expect(packageResponse.headers.get('X-Smallframe-Package-Digest')).toBe(published.packageDigest);
    expect(packageResponse.headers.get('X-Smallframe-Artifact-Digest')).not.toBe(published.packageDigest);
    const packageBytes = new Uint8Array(await packageResponse.arrayBuffer());
    const gluePath = join(ROOT, 'target', 'phase1-wasm', 'smallframe_verifier.js');
    const verifier = await import(pathToFileURL(gluePath).href);
    verifier.initSync({module: await readFile(join(ROOT, 'target', 'phase1-wasm', 'smallframe_verifier_bg.wasm'))});
    const verified = JSON.parse(verifier.wasm_verify_package(packageBytes, published.packageDigest,
      published.publisherKeyId)) as {ok: boolean};
    expect(verified.ok).toBe(true);
    const stateResponse = await fetch(`${apiOrigin}/v1/rooms/${viewer.descriptor.roomId}/state`, {headers});
    expect(stateResponse.status).toBe(200);
    const restored = await decryptSnapshot({roomKey: viewer.roomKey, expectedAppId: 'dev.example.decision-board',
      expectedWriterPublicKey: decodeBase64Url(viewer.descriptor.writerPublicKey),
      roomId: viewer.descriptor.roomId, packageDigest: published.packageDigest, envelope: await stateResponse.json()});
    expect(restored.automergeBytes.byteLength).toBeGreaterThan(0);
    expect(editor.descriptor.writerPublicKey).toBe(viewer.descriptor.writerPublicKey);
    const stored = await readFile(join(store, `room-${published.roomId}.json`), 'utf8');
    expect(stored.includes('roomKey')).toBe(false);
    expect(stored.includes('creationRequest')).toBe(false);
    expect((await run('operations', 'status', published.operationRef)).localStatus).toBe('CONFIRMED');
    await writeFile(join(source, 'app.worker.js'), 'source changed after publication');
    const roomFile = join(store, `room-${published.roomId}.json`);
    const unlock = await readFile(join(store, 'unlock.key'));
    const sealed = JSON.parse(stored) as {nonce: string; ciphertext: string; schemaVersion: number};
    const aad = Buffer.from(`smallframe/local-secret/v1\0room:${published.roomId}`);
    const encrypted = Buffer.from(sealed.ciphertext, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', unlock, Buffer.from(sealed.nonce, 'base64url'));
    decipher.setAAD(aad);
    decipher.setAuthTag(encrypted.subarray(-16));
    const record = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString()) as Record<string, any>;
    record.status = 'PENDING';
    const saveRecord = async () => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', unlock, nonce);
      cipher.setAAD(aad);
      const resealed = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final(), cipher.getAuthTag()]);
      await writeFile(roomFile, JSON.stringify({schemaVersion: 1, nonce: nonce.toString('base64url'),
        ciphertext: resealed.toString('base64url')}));
    };
    const originalRequest = record.creationRequestBytes;
    const originalDigest = record.creationRequestSha256;
    const changed = JSON.parse(Buffer.from(originalRequest, 'base64url').toString()) as Record<string, any>;
    changed.envelope.aad.appId = 'changed-after-commit';
    const changedBytes = Buffer.from(JSON.stringify(changed));
    record.creationRequestBytes = changedBytes.toString('base64url');
    record.creationRequestSha256 = createHash('sha256').update(changedBytes).digest('base64url');
    await saveRecord();
    await expect(run('operations', 'resume', published.operationRef)).rejects.toThrow('OPERATION_STILL_PENDING');
    record.creationRequestBytes = originalRequest;
    record.creationRequestSha256 = originalDigest;
    await saveRecord();
    expect((await run('operations', 'status', published.operationRef)).localStatus).toBe('PENDING');
    const operationRow = await db.prepare('SELECT initBody FROM publisher_room_operations WHERE roomId=?').bind(published.roomId).first<{initBody: string}>();
    expect(operationRow).not.toBeNull();
    expect((await fetch(`${apiOrigin}/__publisher/rooms/${published.roomId}/init-envelope`, {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: operationRow!.initBody})).status).toBe(404);
    const namespace = await miniflare.getDurableObjectNamespace('ROOMS');
    const object = namespace.get(namespace.idFromName(published.roomId));
    const initialize = (body: string) => object.fetch(`http://internal/__publisher/rooms/${published.roomId}/init-envelope`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body});
    expect((await initialize(operationRow!.initBody)).status).toBe(200);
    const conflicting = JSON.parse(operationRow!.initBody) as Record<string, unknown>;
    conflicting.operationId = randomBytes(16).toString('base64url');
    expect((await initialize(JSON.stringify(conflicting))).status).toBe(409);
    const extra = JSON.parse(operationRow!.initBody) as Record<string, unknown>; extra.unexpected = true;
    expect((await initialize(JSON.stringify(extra))).status).toBe(400);
    // Simulate a stale D1 mirror while the authoritative DO retains its receipt.
    await db.prepare("UPDATE rooms SET status='PENDING' WHERE id=?").bind(published.roomId).run();
    await db.prepare("UPDATE publisher_room_operations SET state='DO_ACTIVE_WITH_GENESIS' WHERE roomId=?").bind(published.roomId).run();
    const localNamespace: PublisherRoomNamespace = {idFromName: (name) => namespace.idFromName(name), get: (id) => ({
      fetch: async (request) => {
        const result = await namespace.get(id).fetch(request.url, {method: 'POST',
          headers: {'Content-Type': 'application/json'}, body: await request.arrayBuffer()});
        return new Response(null, {status: result.status});
      },
    })};
    expect(await new DurableRoomStorage(db, async () => {}).reconcile(localNamespace)).toEqual({activated: 1, pending: 0});
    const resumed = await run('operations', 'resume', published.operationRef, '--show-secrets');
    expect(resumed.ok).toBe(true);
    const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(fingerprint(resumed.viewerInviteUrl)).toBe(fingerprint(published.viewerInviteUrl));
    expect(fingerprint(resumed.editorInviteUrl)).toBe(fingerprint(published.editorInviteUrl));
    expect((await run('operations', 'status', published.operationRef)).localStatus).toBe('CONFIRMED');
    await expect(run('operations', 'abandon', published.operationRef)).rejects.toThrow('OPERATION_ABANDON_REQUIRES_SERVER_RECONCILIATION');
    await expect(run('export', 'package', published.packageDigest, '--output', join(temporaryDirectory, 'unused-package')))
      .rejects.toThrow('PACKAGE_EXPORT_NOT_IMPLEMENTED');
  }, 180_000);

  it('creates an encrypted local room from authenticated descriptors and pins its package for members', async () => {
    // 1. Admin creates an invite code
    const inviteCode = randomBytes(24).toString('base64url');
    const adminRes = await fetch(`${apiOrigin}/v1/admin/invite`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: CONTROLLER_ORIGIN},
      body: JSON.stringify({code: inviteCode})
    });
    expect(adminRes.status).toBe(201);
    const adminData = (await adminRes.json()) as {ok: boolean; codeHash: string};
    expect(adminData.ok).toBe(true);

    // 2. Publisher generates keypair, API token, operation ID, and signs enrollment
    const packageStore = await mkdtemp(join(temporaryDirectory, 'package-author-'));
    const binary = join(ROOT, 'target', 'debug', 'smallframe-cli');
    const native = async (...args: string[]): Promise<Record<string, any>> => {
      try {
        const output = await promisify(execFile)(binary, ['--json', '--test-store', packageStore, ...args],
          {cwd: ROOT, encoding: 'utf8', maxBuffer: 32_768});
        return JSON.parse(output.stdout) as Record<string, any>;
      } catch { throw new Error('NATIVE_PACKAGE_FIXTURE_FAILED'); }
    };
    await native('identity', 'init');
    const identityVault = JSON.parse(await readFile(join(packageStore, 'identity-v1.json'), 'utf8')) as
      {keyId: string; nonce: string; ciphertext: string};
    const vaultBytes = Buffer.from(identityVault.ciphertext, 'base64url');
    const vaultCipher = createDecipheriv('aes-256-gcm', await readFile(join(packageStore, 'unlock.key')),
      Buffer.from(identityVault.nonce, 'base64url'));
    vaultCipher.setAAD(Buffer.from(`smallframe-vault-v1\0${identityVault.keyId}`));
    vaultCipher.setAuthTag(vaultBytes.subarray(-16));
    const vaultPlain = JSON.parse(Buffer.concat([vaultCipher.update(vaultBytes.subarray(0, -16)), vaultCipher.final()]).toString()) as
      {privateKeyPkcs8: string};
    const privateJwk = createPrivateKey({key: Buffer.from(vaultPlain.privateKeyPkcs8, 'base64'), type: 'pkcs8', format: 'der'})
      .export({format: 'jwk'});
    if (typeof privateJwk.d !== 'string') throw new Error('NATIVE_PACKAGE_FIXTURE_FAILED');
    const publisherPriv = decodeBase64Url(privateJwk.d);
    const publisherPub = await getPublicKeyAsync(publisherPriv);
    const publisherKeyDigest = await crypto.subtle.digest('SHA-256', publisherPub);
    const publisherKeyId = `sha256:${encodeBase64Url(new Uint8Array(publisherKeyDigest))}`;

    const rawToken = randomBytes(32);
    const tokenHash = createHash('sha256').update(rawToken).digest();
    const operationId = randomBytes(16);
    const inviteCodeHash = createHash('sha256').update(inviteCode).digest();

    const signedEnrollment = await createSignedEnrollment({
      publisherPrivateKey: publisherPriv,
      tokenHash: new Uint8Array(tokenHash),
      operationId: new Uint8Array(operationId),
      inviteCodeHash: new Uint8Array(inviteCodeHash)
    });

    const enrollRes = await fetch(`${apiOrigin}/v1/enroll`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: CONTROLLER_ORIGIN},
      body: JSON.stringify({
        jcsBytes: encodeBase64Url(signedEnrollment.jcsBytes),
        signature: encodeBase64Url(signedEnrollment.signature)
      })
    });
    expect(enrollRes.status).toBe(201);
    const enrollData = (await enrollRes.json()) as {ok: boolean; publisherKeyId: string};
    expect(enrollData.ok).toBe(true);
    expect(enrollData.publisherKeyId).toBe(publisherKeyId);

    // 3. Replaying exact same enrollment returns 200 idempotently
    const replayRes = await fetch(`${apiOrigin}/v1/enroll`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: CONTROLLER_ORIGIN},
      body: JSON.stringify({
        jcsBytes: encodeBase64Url(signedEnrollment.jcsBytes),
        signature: encodeBase64Url(signedEnrollment.signature)
      })
    });
    expect(replayRes.status).toBe(200);

    // 4. Upload package with Bearer auth
    const apiTokenBase64Url = encodeBase64Url(new Uint8Array(rawToken));
    const archivePath = join(packageStore, 'signed-package.zip');
    const packed = await native('pack', join(ROOT, 'examples/decision-board/package'), '--output', archivePath);
    const packageBytes = new Uint8Array(await readFile(archivePath));
    const expectedPkgDigest = String(packed.packageDigest);

    const packageOperation = randomBytes(16).toString('base64url');
    const pkgUploadRes = await fetch(`${apiOrigin}/v1/packages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiTokenBase64Url}`,
        'Idempotency-Key': packageOperation,
        'Content-Type': 'application/vnd.smallframe.package',
        Origin: CONTROLLER_ORIGIN
      },
      body: packageBytes
    });
    expect(pkgUploadRes.status).toBe(201);
    const pkgUploadData = (await pkgUploadRes.json()) as {ok: boolean; packageDigest: string};
    expect(pkgUploadData.packageDigest).toBe(expectedPkgDigest);
    const uploadReplay = (operation: string | null, declared = false) => {
      const headers = new Headers({Authorization: `Bearer ${apiTokenBase64Url}`,
        'Content-Type': 'application/vnd.smallframe.package'});
      if (operation !== null) headers.set('Idempotency-Key', operation);
      if (declared) headers.set('X-Smallframe-Package-Digest', expectedPkgDigest);
      return fetch(`${apiOrigin}/v1/packages`, {method: 'POST', headers, body: packageBytes});
    };
    expect((await uploadReplay(packageOperation)).status).toBe(200);
    const changedHeader = await uploadReplay(packageOperation, true);
    expect(changedHeader.status).toBe(409);
    expect((await changedHeader.json() as {title: string}).title).toBe('IDEMPOTENCY_MISMATCH');
    for (const invalid of [null, 'short', `${packageOperation}=`, randomBytes(32).toString('base64url')]) {
      expect((await uploadReplay(invalid)).status).toBe(400);
    }

    const limitSource = join(packageStore, 'limit-source');
    await cp(join(ROOT, 'examples/decision-board/package'), limitSource, {recursive: true});
    const limitWorker = join(limitSource, 'app.worker.js');
    const originalWorker = await readFile(limitWorker, 'utf8');
    await writeFile(limitWorker, `${originalWorker}\n/*${'x'.repeat(5_500 - Buffer.byteLength(originalWorker) - 5)}*/`);
    const limitArchive = join(packageStore, 'limit-package.zip');
    await native('pack', limitSource, '--output', limitArchive);
    const limitBytes = await readFile(limitArchive);
    expect(limitBytes.byteLength).toBe(8_192);
    const limitOperation = randomBytes(16).toString('base64url');
    const sendLimit = (body: Uint8Array) => fetch(`${apiOrigin}/v1/packages`, {method: 'POST', body,
      headers: {Origin: CONTROLLER_ORIGIN, Authorization: `Bearer ${apiTokenBase64Url}`,
        'Idempotency-Key': limitOperation,
        'Content-Type': 'application/vnd.smallframe.package'}});
    expect((await sendLimit(limitBytes)).status).toBe(201);
    expect((await sendLimit(new Uint8Array([...limitBytes, 0]))).status).toBe(413);
    expect((await sendLimit(limitBytes)).status).toBe(200);

    // 5. Publisher retrieval requires its authenticated token.
    expect((await fetch(`${apiOrigin}/v1/packages/${expectedPkgDigest}`)).status).toBe(401);
    expect((await fetch(`${apiOrigin}/v1/packages/${expectedPkgDigest}`, {headers: {Authorization: 'Bearer malformed'}})).status).toBe(401);
    const getPkgRes = await fetch(`${apiOrigin}/v1/packages/${expectedPkgDigest}`, {
      headers: {Origin: CONTROLLER_ORIGIN, Authorization: `Bearer ${apiTokenBase64Url}`}
    });
    expect(getPkgRes.status).toBe(200);
    const downloadedBytes = new Uint8Array(await getPkgRes.arrayBuffer());
    expect(downloadedBytes.byteLength).toBe(packageBytes.byteLength);
    expect(createHash('sha256').update(downloadedBytes).digest('hex')).toBe(createHash('sha256').update(packageBytes).digest('hex'));

    // 6. Create room saga
    const roomBytes = randomBytes(16);
    const roomId = encodeBase64Url(roomBytes);
    const writerPriv = utils.randomPrivateKey();
    const writerPub = await getPublicKeyAsync(writerPriv);
    const viewerCap = randomBytes(32);
    const editorCap = randomBytes(32);
    const roomExpiry = Date.now() + 86_400_000;

    const viewerDesc = await createSignedRoomDescriptor({
      publisherPrivateKey: publisherPriv,
      roomId,
      packageDigest: expectedPkgDigest,
      publisherKeyId,
      writerPublicKey: writerPub,
      capability: new Uint8Array(viewerCap),
      role: 'viewer',
      expiresAt: roomExpiry
    });

    const editorDesc = await createSignedRoomDescriptor({
      publisherPrivateKey: publisherPriv,
      roomId,
      packageDigest: expectedPkgDigest,
      publisherKeyId,
      writerPublicKey: writerPub,
      capability: new Uint8Array(editorCap),
      role: 'editor',
      expiresAt: roomExpiry
    });

    const roomOpId = encodeBase64Url(randomBytes(16));
    const roomKey = new Uint8Array(randomBytes(32));
    const genesis = await encryptSnapshot({roomKey, writerPrivateKey: writerPriv, roomId,
      appId: 'test.package', packageDigest: expectedPkgDigest, stateEpoch: 0, proposedRevision: 1,
      previousEnvelopeDigest: encodeBase64Url(new Uint8Array(32)), automergeBytes: Uint8Array.of(1, 2, 3)});

    const roomBody = {
      operationId: roomOpId,
      roomId,
      packageDigest: expectedPkgDigest,
      viewerDescriptorJcs: encodeBase64Url(viewerDesc.jcsBytes),
      viewerDescriptorSignature: encodeBase64Url(viewerDesc.signature),
      editorDescriptorJcs: encodeBase64Url(editorDesc.jcsBytes),
      editorDescriptorSignature: encodeBase64Url(editorDesc.signature),
      envelope: genesis.envelope
    };
    const createRoom = (body: unknown) => fetch(`${apiOrigin}/v1/rooms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiTokenBase64Url}`,
        'Content-Type': 'application/json',
        Origin: CONTROLLER_ORIGIN
      },
      body: JSON.stringify(body)
    });
    expect((await createRoom({...roomBody, packageDigest: encodeBase64Url(randomBytes(32))})).status).toBe(404);
    expect((await createRoom({...roomBody, envelope: {...genesis.envelope,
      writerPublicKey: encodeBase64Url(randomBytes(32))}})).status).toBe(400);
    expect((await createRoom({...roomBody, envelope: {...genesis.envelope,
      writerSignature: encodeBase64Url(randomBytes(64))}})).status).toBe(400);
    const db = await miniflare.getD1Database('DB');
    expect((await db.prepare('SELECT COUNT(*) AS count FROM publisher_room_operations WHERE operationId=?').bind(roomOpId).first<{count: number}>())?.count).toBe(0);
    const roomRes = await createRoom(roomBody);
    expect(roomRes.status).toBe(201);
    const roomData = (await roomRes.json()) as {ok: boolean; roomId: string};
    expect(roomData.ok).toBe(true);
    expect(roomData.roomId).toBe(roomId);
    expect((await createRoom(roomBody)).status).toBe(200);
    expect((await createRoom({...roomBody, envelope: {...genesis.envelope,
      writerSignature: encodeBase64Url(randomBytes(64))}})).status).toBe(409);

    // The old unauthenticated alias is no longer routable.
    const roomPkgRes = await fetch(`${apiOrigin}/v1/rooms/${roomId}/package`, {
      headers: {Origin: CONTROLLER_ORIGIN}
    });
    expect(roomPkgRes.status).toBe(404);
    const roomHeaders = {Origin: CONTROLLER_ORIGIN, Authorization: `SF-Cap ${encodeBase64Url(viewerCap)}`};
    const memberPackage = await fetch(`${apiOrigin}/v1/rooms/${roomId}/packages/${expectedPkgDigest}`, {headers: roomHeaders});
    expect(memberPackage.status).toBe(200);
    expect(new Uint8Array(await memberPackage.arrayBuffer())).toEqual(packageBytes);
    const encryptedState = await fetch(`${apiOrigin}/v1/rooms/${roomId}/state`, {headers: roomHeaders});
    expect(encryptedState.status).toBe(200);
    const restored = await decryptSnapshot({roomKey, expectedWriterPublicKey: writerPub, expectedAppId: 'test.package',
      roomId, packageDigest: expectedPkgDigest, envelope: await encryptedState.json()});
    expect(restored.automergeBytes).toEqual(Uint8Array.of(1, 2, 3));

    for (const action of ['rotate-links', 'revoke']) {
      const denied = await fetch(`${apiOrigin}/v1/rooms/${roomId}/${action}`, {method: 'POST', body: '{}',
        headers: {Origin: CONTROLLER_ORIGIN, Authorization: `SF-Cap ${encodeBase64Url(editorCap)}`, 'Content-Type': 'application/json'}});
      expect(denied.status).toBe(503);
      expect((await denied.json() as {title: string}).title).toBe('PUBLISHER_LIFECYCLE_NOT_IMPLEMENTED');
    }
    expect((await fetch(`${apiOrigin}/v1/rooms/${roomId}/state`, {headers: roomHeaders})).headers.get('ETag')).toBe(encryptedState.headers.get('ETag'));

    const next = await encryptSnapshot({roomKey, writerPrivateKey: writerPriv, roomId, appId: 'test.package',
      packageDigest: expectedPkgDigest, stateEpoch: 0, proposedRevision: 2,
      previousEnvelopeDigest: encodeBase64Url(genesis.envelopeDigest), automergeBytes: Uint8Array.of(1, 2, 3, 4)});
    expect((await fetch(`${apiOrigin}/v1/rooms/${roomId}/state`, {method: 'PUT', body: JSON.stringify(next.envelope),
      headers: {Origin: CONTROLLER_ORIGIN, Authorization: `SF-Cap ${encodeBase64Url(editorCap)}`,
        'Content-Type': 'application/json', 'If-Match': encryptedState.headers.get('ETag')!}})).status).toBe(204);
    const receipt = await db.prepare('SELECT initBody FROM publisher_room_operations WHERE operationId=?').bind(roomOpId).first<{initBody: string}>();
    const roomNamespace = await miniflare.getDurableObjectNamespace('ROOMS');
    const roomObject = roomNamespace.get(roomNamespace.idFromName(roomId));
    expect((await roomObject.fetch(`http://internal/__publisher/rooms/${roomId}/init-envelope`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: receipt!.initBody})).status).toBe(200);
    const advanced = await fetch(`${apiOrigin}/v1/rooms/${roomId}/state`, {headers: roomHeaders});
    expect(advanced.headers.get('ETag')).toBe(next.etag);
    expect((await advanced.json() as {revision: number}).revision).toBe(2);

    // Test-only encrypted genesis pins the package in authoritative DO state.
    const encryptedRoomId = encodeBase64Url(randomBytes(16));
    const fixtureGenesis = await encryptSnapshot({roomKey: new Uint8Array(randomBytes(32)), writerPrivateKey: writerPriv,
      roomId: encryptedRoomId, appId: 'test.package', packageDigest: expectedPkgDigest, stateEpoch: 0,
      proposedRevision: 1, previousEnvelopeDigest: encodeBase64Url(new Uint8Array(32)), automergeBytes: Uint8Array.of(1)});
    const init = await fetch(`${apiOrigin}/__phase0/rooms/${encryptedRoomId}/init-envelope`, {method: 'POST', body: JSON.stringify({
      viewerCapHash: viewerDesc.descriptor.capabilityHash, editorCapHash: editorDesc.descriptor.capabilityHash,
      expiresAtMs: Date.now() + 60_000, envelope: fixtureGenesis.envelope
    })});
    expect(init.status).toBe(201);
    const packageUrl = `${apiOrigin}/v1/rooms/${encryptedRoomId}/packages/${expectedPkgDigest}`;
    expect((await fetch(packageUrl, {method: 'POST', headers: roomHeaders})).status).toBe(405);
    expect((await fetch(packageUrl, {method: 'OPTIONS', headers: {Origin: CONTROLLER_ORIGIN,
      'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization'}})).status).toBe(204);
    expect((await fetch(packageUrl, {method: 'OPTIONS', headers: {Origin: CONTROLLER_ORIGIN,
      'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-untrusted'}})).status).toBe(403);
    expect((await fetch(packageUrl, {headers: {Origin: CONTROLLER_ORIGIN}})).status).toBe(403);
    expect((await fetch(packageUrl, {headers: {...roomHeaders, Origin: 'http://untrusted.localhost'}})).status).toBe(403);
    expect((await fetch(packageUrl, {headers: {...roomHeaders, Authorization: `SF-Cap ${encodeBase64Url(randomBytes(32))}`}})).status).toBe(403);
    expect((await fetch(packageUrl + '?cap=invalid', {headers: roomHeaders})).status).toBe(400);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alternateDigest = expectedPkgDigest.slice(0, -1) + alphabet[alphabet.indexOf(expectedPkgDigest.at(-1)!) + 1];
    expect((await fetch(`${apiOrigin}/v1/rooms/${encryptedRoomId}/packages/${alternateDigest}`, {headers: roomHeaders})).status).toBe(400);
    expect((await fetch(`${apiOrigin}/v1/rooms/${encryptedRoomId}/packages/${encodeBase64Url(randomBytes(32))}`, {headers: roomHeaders})).status).toBe(409);
    for (const cap of [viewerCap, editorCap]) {
      const memberPackage = await fetch(packageUrl, {headers: {...roomHeaders, Authorization: `SF-Cap ${encodeBase64Url(cap)}`}});
      expect(memberPackage.status).toBe(200);
      expect(memberPackage.headers.get('Cache-Control')).toBe('private, no-store');
      expect(memberPackage.headers.get('X-Smallframe-Package-Digest')).toBe(expectedPkgDigest);
      expect(new Uint8Array(await memberPackage.arrayBuffer()).byteLength).toBe(packageBytes.byteLength);
    }
    const storage = await miniflare.unsafeGetDurableObjectStorage(WORKER_NAME, DO_CLASS, {name: encryptedRoomId});
    await storage.exec("UPDATE room_state SET recovery_status = 'RECOVERY_REQUIRED'");
    expect((await fetch(packageUrl, {headers: roomHeaders})).status).toBe(200);
    await storage.exec('UPDATE room_state SET revoked_at_ms = ?', Date.now());
    expect((await fetch(packageUrl, {headers: roomHeaders})).status).toBe(403);
    await storage.exec('UPDATE room_state SET revoked_at_ms = NULL, expires_at_ms = ?', Date.now() - 1);
    expect((await fetch(packageUrl, {headers: roomHeaders})).status).toBe(403);
  });
});
