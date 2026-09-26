import {createHash, randomBytes} from 'node:crypto';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {describe, expect, it, beforeAll, afterAll} from 'vitest';
import {Miniflare} from 'miniflare';
import {build} from 'vite';
import {getPublicKeyAsync, utils} from '@noble/ed25519';
import {
  createSignedEnrollment,
  createSignedRoomDescriptor,
  encodeBase64Url,
  decodeBase64Url,
  encryptSnapshot,
} from '../packages/protocol/src/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const CONTROLLER_ORIGIN = 'http://app.localhost:4173';
const WORKER_NAME = 'smallframe-phase4-publish';
const DO_CLASS = 'RoomDurableObject';

let temporaryDirectory = '';
let miniflare: Miniflare;
let apiOrigin = '';

describe('Phase 4 signed publish API integration', () => {
  beforeAll(async () => {
    const testRoot = join(ROOT, '.wrangler');
    await mkdir(testRoot, {recursive: true});
    temporaryDirectory = await mkdtemp(join(testRoot, 'phase4-publish-'));
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
      unsafeInspectDurableObjects: true,
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
      durableObjects: {
        ROOMS: {className: DO_CLASS, useSQLite: true},
      },
    });

    const url = await miniflare.ready;
    apiOrigin = url.origin;
  });

  afterAll(async () => {
    if (miniflare) await miniflare.dispose();
    if (temporaryDirectory) await rm(temporaryDirectory, {recursive: true, force: true});
  });

  it('admin invite, publisher enrollment, package upload, and room creation saga', async () => {
    // 1. Admin creates an invite code
    const adminRes = await fetch(`${apiOrigin}/v1/admin/invite`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: CONTROLLER_ORIGIN},
      body: JSON.stringify({code: 'BETA_INVITE_TEST_123'})
    });
    expect(adminRes.status).toBe(201);
    const adminData = (await adminRes.json()) as {ok: boolean; codeHash: string};
    expect(adminData.ok).toBe(true);

    // 2. Publisher generates keypair, API token, operation ID, and signs enrollment
    const publisherPriv = utils.randomPrivateKey();
    const publisherPub = await getPublicKeyAsync(publisherPriv);
    const publisherKeyDigest = await crypto.subtle.digest('SHA-256', publisherPub);
    const publisherKeyId = `sha256:${encodeBase64Url(new Uint8Array(publisherKeyDigest))}`;

    const rawToken = randomBytes(32);
    const tokenHash = createHash('sha256').update(rawToken).digest();
    const operationId = randomBytes(16);
    const inviteCodeHash = createHash('sha256').update('BETA_INVITE_TEST_123').digest();

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
    const packageBytes = new Uint8Array(1024).fill(0x42);
    const expectedPkgDigest = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', packageBytes)));

    const pkgUploadRes = await fetch(`${apiOrigin}/v1/packages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiTokenBase64Url}`,
        'Content-Type': 'application/vnd.smallframe.package',
        Origin: CONTROLLER_ORIGIN
      },
      body: packageBytes
    });
    expect(pkgUploadRes.status).toBe(201);
    const pkgUploadData = (await pkgUploadRes.json()) as {ok: boolean; packageDigest: string};
    expect(pkgUploadData.packageDigest).toBe(expectedPkgDigest);

    // 5. Publisher retrieval requires its authenticated token.
    expect((await fetch(`${apiOrigin}/v1/packages/${expectedPkgDigest}`)).status).toBe(401);
    expect((await fetch(`${apiOrigin}/v1/packages/${expectedPkgDigest}`, {headers: {Authorization: 'Bearer malformed'}})).status).toBe(401);
    const getPkgRes = await fetch(`${apiOrigin}/v1/packages/${expectedPkgDigest}`, {
      headers: {Origin: CONTROLLER_ORIGIN, Authorization: `Bearer ${apiTokenBase64Url}`}
    });
    expect(getPkgRes.status).toBe(200);
    const downloadedBytes = new Uint8Array(await getPkgRes.arrayBuffer());
    expect(downloadedBytes.byteLength).toBe(1024);
    expect(downloadedBytes[0]).toBe(0x42);

    // 6. Create room saga
    const roomBytes = randomBytes(16);
    const roomId = encodeBase64Url(roomBytes);
    const writerPriv = utils.randomPrivateKey();
    const writerPub = await getPublicKeyAsync(writerPriv);
    const viewerCap = randomBytes(32);
    const editorCap = randomBytes(32);

    const viewerDesc = await createSignedRoomDescriptor({
      publisherPrivateKey: publisherPriv,
      roomId,
      packageDigest: expectedPkgDigest,
      publisherKeyId,
      writerPublicKey: writerPub,
      capability: new Uint8Array(viewerCap),
      role: 'viewer',
      expiresAt: Date.now() + 86_400_000
    });

    const editorDesc = await createSignedRoomDescriptor({
      publisherPrivateKey: publisherPriv,
      roomId,
      packageDigest: expectedPkgDigest,
      publisherKeyId,
      writerPublicKey: writerPub,
      capability: new Uint8Array(editorCap),
      role: 'editor',
      expiresAt: Date.now() + 86_400_000
    });

    const roomOpId = encodeBase64Url(randomBytes(16));
    const genesisBytes = encodeBase64Url(new Uint8Array(100).fill(0x01));

    const roomRes = await fetch(`${apiOrigin}/v1/rooms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiTokenBase64Url}`,
        'Content-Type': 'application/json',
        Origin: CONTROLLER_ORIGIN
      },
      body: JSON.stringify({
        operationId: roomOpId,
        roomId,
        packageDigest: expectedPkgDigest,
        viewerDescriptorJcs: encodeBase64Url(viewerDesc.jcsBytes),
        viewerDescriptorSignature: encodeBase64Url(viewerDesc.signature),
        editorDescriptorJcs: encodeBase64Url(editorDesc.jcsBytes),
        editorDescriptorSignature: encodeBase64Url(editorDesc.signature),
        genesisStateBytes: genesisBytes
      })
    });
    expect(roomRes.status).toBe(201);
    const roomData = (await roomRes.json()) as {ok: boolean; roomId: string};
    expect(roomData.ok).toBe(true);
    expect(roomData.roomId).toBe(roomId);

    // The old unauthenticated alias is no longer routable.
    const roomPkgRes = await fetch(`${apiOrigin}/v1/rooms/${roomId}/package`, {
      headers: {Origin: CONTROLLER_ORIGIN}
    });
    expect(roomPkgRes.status).toBe(404);
    const roomHeaders = {Origin: CONTROLLER_ORIGIN, Authorization: `SF-Cap ${encodeBase64Url(viewerCap)}`};
    // The unfinished raw publisher saga has no DO-pinned package context.
    expect((await fetch(`${apiOrigin}/v1/rooms/${roomId}/packages/${expectedPkgDigest}`, {headers: roomHeaders})).status).toBe(409);

    // Test-only encrypted genesis pins the package in authoritative DO state.
    const encryptedRoomId = encodeBase64Url(randomBytes(16));
    const genesis = await encryptSnapshot({roomKey: new Uint8Array(randomBytes(32)), writerPrivateKey: writerPriv,
      roomId: encryptedRoomId, appId: 'test.package', packageDigest: expectedPkgDigest, stateEpoch: 0,
      proposedRevision: 1, previousEnvelopeDigest: encodeBase64Url(new Uint8Array(32)), automergeBytes: Uint8Array.of(1)});
    const init = await fetch(`${apiOrigin}/__phase0/rooms/${encryptedRoomId}/init-envelope`, {method: 'POST', body: JSON.stringify({
      viewerCapHash: viewerDesc.descriptor.capabilityHash, editorCapHash: editorDesc.descriptor.capabilityHash,
      expiresAtMs: Date.now() + 60_000, envelope: genesis.envelope
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
      expect(new Uint8Array(await memberPackage.arrayBuffer()).byteLength).toBe(1024);
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
