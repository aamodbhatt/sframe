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
  decodeBase64Url
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

    // 5. Retrieve package by digest
    const getPkgRes = await fetch(`${apiOrigin}/v1/packages/${expectedPkgDigest}`, {
      headers: {Origin: CONTROLLER_ORIGIN}
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

    // 7. Retrieve package via room endpoint
    const roomPkgRes = await fetch(`${apiOrigin}/v1/rooms/${roomId}/package`, {
      headers: {Origin: CONTROLLER_ORIGIN}
    });
    expect(roomPkgRes.status).toBe(200);
    const roomPkgBytes = new Uint8Array(await roomPkgRes.arrayBuffer());
    expect(roomPkgBytes.byteLength).toBe(1024);
  });
});
