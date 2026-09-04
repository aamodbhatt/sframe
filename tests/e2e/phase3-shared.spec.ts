import {expect, test} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {getPublicKeyAsync} from '@noble/ed25519';
import {
  createSignedRoomDescriptor,
  formatInviteFragment,
  encodeBase64Url,
  decodeBase64Url
  , encryptSnapshot, sha256
} from '../../packages/protocol/src/index.js';

// Invite fragments are bearer credentials even in tests. Do not retain them in traces.
test.use({trace: 'off'});
const sharedFixture = JSON.parse(readFileSync('target/phase1-wasm/shared-test-package.json', 'utf8')) as {packageDigest: string; publisherKeyId: string; hostileListBase64: string; invalidSchemaBase64: string};

test.describe('Phase 3 encrypted shared rooms & collaborative runtime', () => {
  // Existing TEST-ONLY package-vector signer; never a production identity.
  const publisherPriv = new Uint8Array(32).fill(7);
  let roomKey: Uint8Array;
  let writerPriv: Uint8Array;
  let viewerCap: Uint8Array;
  let editorCap: Uint8Array;
  const makeRoomId = () => encodeBase64Url(randomBytes(16));
  let activeRoomId: string;
  let activeExpiry: number;

  test.beforeEach(async ({request}) => {
    [roomKey, writerPriv, viewerCap, editorCap] = Array.from({length: 4}, () => new Uint8Array(randomBytes(32)));
    const res = await request.post('http://127.0.0.1:8787/__test__/evidence/reset');
    expect(res.status()).toBe(204);
    activeRoomId = makeRoomId();
    activeExpiry = Date.now() + 86_400_000;
    const genesis = await encryptSnapshot({roomKey, writerPrivateKey: writerPriv, roomId: activeRoomId, appId: 'dev.example.decision-board',
      packageDigest: sharedFixture.packageDigest, stateEpoch: 0, proposedRevision: 1,
      previousEnvelopeDigest: encodeBase64Url(new Uint8Array(32)),
      automergeBytes: new Uint8Array(readFileSync('target/phase1-wasm/phase3-genesis.bin'))});
    const init = await request.post(`http://127.0.0.1:8787/__phase0/rooms/${activeRoomId}/init-envelope`, {data: {
      viewerCapHash: encodeBase64Url(await sha256(viewerCap)), editorCapHash: encodeBase64Url(await sha256(editorCap)),
      expiresAtMs: activeExpiry, envelope: genesis.envelope
    }});
    expect(init.status(), (await init.text()).slice(0, 160)).toBe(201);
  });

  test.afterEach(async ({page}) => {
    try {
      await page.goto('about:blank');
    } catch {}
  });

  test('scrubs invite fragment synchronously, opens shared editor, edits state, and enforces viewer mode', async ({page, context}) => {
    const roomId = activeRoomId;
    const packageDigest = sharedFixture.packageDigest;
    const publisherKeyId = sharedFixture.publisherKeyId;
    const writerPub = await getPublicKeyAsync(writerPriv);

    // 1. Create Editor invite
    const editorDesc = await createSignedRoomDescriptor({
      publisherPrivateKey: publisherPriv,
      roomId,
      packageDigest,
      publisherKeyId,
      writerPublicKey: writerPub,
      capability: editorCap,
      role: 'editor',
      expiresAt: activeExpiry
    });

    const editorFragment = formatInviteFragment({
      descriptorJcsBytes: editorDesc.jcsBytes,
      descriptorSignature: editorDesc.signature,
      roomKey,
      capability: editorCap,
      writerPrivateSeed: writerPriv
    });

    // Navigate to invite URL with fragment
    await page.goto(`/r/${activeRoomId}#${editorFragment}`, {waitUntil: 'domcontentloaded'});

    // Verify fragment is scrubbed synchronously from address bar
    await expect(page).toHaveURL(`http://app.localhost:4173/r/${activeRoomId}`);
    expect(page.url().includes('#')).toBe(false);

    // Verify Trust panel
    await expect(page.getByRole('heading', {name: 'Decision Board', level: 2})).toBeVisible();
    await expect(page.locator('#trust-context')).toContainText('Encrypted shared room (editor)');

    // Approve
    await page.getByRole('button', {name: 'Open this exact version'}).click();
    const app = page.frameLocator('iframe');
    await expect(app.getByRole('button', {name: 'Add decision'})).toBeVisible();
    await expect(page.locator('#role')).toHaveText('editor');

    // Add a decision
    const putPromise1 = page.waitForResponse((res) => res.url().includes('/v1/rooms/') && res.request().method() === 'PUT');
    await app.getByRole('button', {name: 'Add decision'}).click();
    await expect(app.getByText('1 decisions')).toBeVisible();
    await putPromise1;
    await expect(page.locator('#connectivity')).toHaveText('Synced');

    // Verify workspace menu
    await page.getByRole('button', {name: 'Workspace'}).click();
    await expect(page.getByRole('button', {name: 'Export readable JSON'})).toBeVisible();

    // 2. Open Viewer invite in second page
    const viewerDesc = await createSignedRoomDescriptor({
      publisherPrivateKey: publisherPriv,
      roomId,
      packageDigest,
      publisherKeyId,
      writerPublicKey: writerPub,
      capability: viewerCap,
      role: 'viewer',
      expiresAt: activeExpiry
    });

    const viewerFragment = formatInviteFragment({
      descriptorJcsBytes: viewerDesc.jcsBytes,
      descriptorSignature: viewerDesc.signature,
      roomKey,
      capability: viewerCap
    });

    const viewerPage = await context.newPage();
    await viewerPage.goto(`/r/${activeRoomId}#${viewerFragment}`, {waitUntil: 'domcontentloaded'});

    // Verify fragment scrubbed
    expect(viewerPage.url().includes('#')).toBe(false);
    await expect(viewerPage.locator('#trust-context')).toContainText('Encrypted shared room (viewer)');

    // Approve viewer
    await viewerPage.getByRole('button', {name: 'Open this exact version'}).click();
    const viewerApp = viewerPage.frameLocator('iframe');
    await expect(viewerPage.locator('#role')).toHaveText('viewer');

    // Viewer receives synchronized editor state (1 decision)
    await expect(viewerApp.getByText('1 decisions')).toBeVisible();

    // Viewer cannot add decisions
    await viewerApp.getByRole('button', {name: 'Add decision'}).click();
    // Remains 1 decision
    await expect(viewerApp.getByText('1 decisions')).toBeVisible();

    await viewerPage.close();
  });

  test('verifies wire encryption: state sync sends encrypted WireEnvelope with valid signature and no plaintext state', async ({page}) => {
    const roomId = activeRoomId;
    const packageDigest = sharedFixture.packageDigest;
    const publisherKeyId = sharedFixture.publisherKeyId;
    const writerPub = await getPublicKeyAsync(writerPriv);

    const desc = await createSignedRoomDescriptor({
      publisherPrivateKey: publisherPriv,
      roomId,
      packageDigest,
      publisherKeyId,
      writerPublicKey: writerPub,
      capability: editorCap,
      role: 'editor',
      expiresAt: activeExpiry
    });

    const fragment = formatInviteFragment({
      descriptorJcsBytes: desc.jcsBytes,
      descriptorSignature: desc.signature,
      roomKey,
      capability: editorCap,
      writerPrivateSeed: writerPriv
    });

    let interceptedPutBody = '';
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes(`/v1/rooms/${roomId}/state`)) {
        interceptedPutBody = req.postData() ?? req.postDataBuffer()?.toString('utf8') ?? '';
      }
    });

    await page.goto(`/r/${activeRoomId}#${fragment}`, {waitUntil: 'domcontentloaded'});
    await page.getByRole('button', {name: 'Open this exact version'}).click();
    const app = page.frameLocator('iframe');
    await expect(app.getByRole('button', {name: 'Add decision'})).toBeVisible();

    const putPromise2 = page.waitForResponse((res) => res.url().includes('/v1/rooms/') && res.request().method() === 'PUT');
    await app.getByRole('button', {name: 'Add decision'}).click();
    await expect(app.getByText('1 decisions')).toBeVisible();
    await putPromise2;
    await expect(page.locator('#connectivity')).toHaveText('Synced');

    // Verify PUT occurred and inspect wire envelope
    expect(Boolean(interceptedPutBody)).toBe(true);
    const parsed = JSON.parse(interceptedPutBody);
    expect(parsed.version).toBe(1);
    expect(parsed.stateEpoch).toBe(0);
    expect(parsed.proposedRevision).toBe(2);
    expect(typeof parsed.envelopeSalt).toBe('string');
    expect(typeof parsed.ciphertext).toBe('string');
    expect(typeof parsed.writerSignature).toBe('string');
    expect(parsed.aad.roomId).toBe(roomId);
    expect(parsed.aad.packageDigest).toBe(packageDigest);

    // CRITICAL: Ensure NO plaintext appears on the wire!
    expect(interceptedPutBody.includes('decisions')).toBe(false);
    expect(interceptedPutBody.includes('Untitled')).toBe(false);
  });

  test('enforces single-editor web lock lease within the same profile', async ({page, context}) => {
    const roomId = activeRoomId;
    const packageDigest = sharedFixture.packageDigest;
    const publisherKeyId = sharedFixture.publisherKeyId;
    const writerPub = await getPublicKeyAsync(writerPriv);

    const desc = await createSignedRoomDescriptor({
      publisherPrivateKey: publisherPriv,
      roomId,
      packageDigest,
      publisherKeyId,
      writerPublicKey: writerPub,
      capability: editorCap,
      role: 'editor',
      expiresAt: activeExpiry
    });

    const fragment = formatInviteFragment({
      descriptorJcsBytes: desc.jcsBytes,
      descriptorSignature: desc.signature,
      roomKey,
      capability: editorCap,
      writerPrivateSeed: writerPriv
    });

    // Tab 1 opens as editor
    await page.goto(`/r/${activeRoomId}#${fragment}`, {waitUntil: 'domcontentloaded'});
    await page.getByRole('button', {name: 'Open this exact version'}).click();
    await expect(page.locator('#role')).toHaveText('editor');

    // Tab 2 in same browser profile opens same editor invite
    const tab2 = await context.newPage();
    await tab2.goto(`/r/${activeRoomId}#${fragment}`, {waitUntil: 'domcontentloaded'});
    const approveBtn = tab2.getByRole('button', {name: 'Open this exact version'});
    if (await approveBtn.isVisible()) {
      await approveBtn.click();
    }

    // Tab 2 cannot acquire exclusive lease lock
    await expect(tab2.locator('#role')).toHaveText('editor (read-only lease)');
    const secondApp = tab2.frameLocator('iframe');
    await secondApp.getByRole('button', {name: 'Add decision'}).click();
    await expect(secondApp.getByText('0 decisions')).toBeVisible();

    await tab2.close();
  });

  test('two editors share genesis, edit offline concurrently, and converge through the real relay', async ({browser, request}) => {
    const roomId = activeRoomId;
    const packageDigest = sharedFixture.packageDigest;
    const publisherKeyId = sharedFixture.publisherKeyId;
    const writerPub = await getPublicKeyAsync(writerPriv);

    const desc = await createSignedRoomDescriptor({
      publisherPrivateKey: publisherPriv,
      roomId,
      packageDigest,
      publisherKeyId,
      writerPublicKey: writerPub,
      capability: editorCap,
      role: 'editor',
      expiresAt: activeExpiry
    });

    const fragment = formatInviteFragment({
      descriptorJcsBytes: desc.jcsBytes,
      descriptorSignature: desc.signature,
      roomKey,
      capability: editorCap,
      writerPrivateSeed: writerPriv
    });

    // Profile A (Editor A)
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await pageA.goto(`/r/${activeRoomId}#${fragment}`, {waitUntil: 'domcontentloaded'});
    await pageA.locator('#remember-approval').check();
    await pageA.getByRole('button', {name: 'Open this exact version'}).click();
    const appA = pageA.frameLocator('iframe');
    await expect(appA.getByText('0 decisions')).toBeVisible();

    // Profile B (Editor B in separate browser context/profile)
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await pageB.goto(`/r/${activeRoomId}#${fragment}`, {waitUntil: 'domcontentloaded'});
    await pageB.getByRole('button', {name: 'Open this exact version'}).click();
    const appB = pageB.frameLocator('iframe');

    await expect(appB.getByText('0 decisions')).toBeVisible();
    const networkControl = 'http://127.0.0.1:8787/__test__/relay-network';
    expect((await request.post(networkControl, {data: {online: false}})).status()).toBe(204);
    try {
      await Promise.all([appA.getByRole('button', {name: 'Add decision'}).click(), appB.getByRole('button', {name: 'Add decision'}).click()]);
      await expect(appA.getByText('1 decisions')).toBeVisible();
      await expect(appB.getByText('1 decisions')).toBeVisible();
      expect((await request.post(networkControl, {data: {online: true}})).status()).toBe(204);
      await Promise.all([pageA.evaluate(() => window.dispatchEvent(new Event('online'))), pageB.evaluate(() => window.dispatchEvent(new Event('online')))]);
      await expect(appA.getByText('2 decisions')).toBeVisible({timeout: 10_000});
      await expect(appB.getByText('2 decisions')).toBeVisible({timeout: 10_000});
      await expect(pageA.locator('#connectivity')).toHaveText('Synced');
      await expect(pageB.locator('#connectivity')).toHaveText('Synced');
    } finally {
      await request.post(networkControl, {data: {online: true}});
      await contextA.close();
      await contextB.close();
    }
  });

  test('persists automerge document to IndexedDB and re-opens offline', async ({page, request}) => {
    const roomId = activeRoomId;
    const packageDigest = sharedFixture.packageDigest;
    const publisherKeyId = sharedFixture.publisherKeyId;
    const writerPub = await getPublicKeyAsync(writerPriv);

    const desc = await createSignedRoomDescriptor({
      publisherPrivateKey: publisherPriv,
      roomId,
      packageDigest,
      publisherKeyId,
      writerPublicKey: writerPub,
      capability: editorCap,
      role: 'editor',
      expiresAt: activeExpiry
    });

    const fragment = formatInviteFragment({
      descriptorJcsBytes: desc.jcsBytes,
      descriptorSignature: desc.signature,
      roomKey,
      capability: editorCap,
      writerPrivateSeed: writerPriv
    });

    await page.goto(`/r/${activeRoomId}#${fragment}`, {waitUntil: 'domcontentloaded'});
    await page.locator('#remember-approval').check();
    await page.getByRole('button', {name: 'Open this exact version'}).click();
    const app = page.frameLocator('iframe');
    await expect(app.getByRole('button', {name: 'Add decision'})).toBeVisible();
    await app.getByRole('button', {name: 'Add decision'}).click();
    await expect(app.getByText('1 decisions')).toBeVisible();
    await expect(page.locator('#connectivity')).toHaveText('Synced');

    // Verify workspace saved locally
    await page.getByRole('button', {name: 'Workspace'}).click();
    await expect(page.getByText(/Saved locally:/)).not.toContainText('not yet');
    const storageShape = await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open('smallframe-shared-v1', 2);
        request.onsuccess = () => resolve(request.result);
      });
      const read = (name: string): Promise<any[]> => new Promise((resolve) => {
        const request = database.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
      });
      const [rooms, keys] = await Promise.all([read('rooms'), read('deviceKeys')]);
      database.close();
      return {fields: Object.keys(rooms[0]).sort(), encrypted: rooms[0].ciphertext instanceof ArrayBuffer,
        keyExtractable: keys[0].key.extractable, algorithm: keys[0].key.algorithm.name};
    });
    expect(storageShape).toEqual({fields: ['ciphertext', 'nonce', 'roomId', 'version'], encrypted: true, keyExtractable: false, algorithm: 'AES-GCM'});

    // Turn off network on controller server
    const networkControl = 'http://127.0.0.1:8787/__test__/controller-network';
    expect((await request.post(networkControl, {data: {online: false}})).status()).toBe(204);
    try {
      await page.goto(`/r/${activeRoomId}#${fragment}`, {waitUntil: 'domcontentloaded'});
      const approveBtn = page.getByRole('button', {name: 'Open this exact version'});
      try {
        if (await approveBtn.isVisible({timeout: 1000})) {
          await approveBtn.click();
        }
      } catch {}
      const offlineApp = page.frameLocator('iframe');
      await expect(offlineApp.getByText('1 decisions')).toBeVisible();

      // Authenticated local storage can still contain output from an older or buggy
      // controller, so restored history must pass the current document and schema checks.
      // Leave the active runtime first so it cannot race the deliberate record rewrite.
      await page.goto('/icon.svg', {waitUntil: 'domcontentloaded'});
      await page.evaluate(async ({roomId: storedRoomId, invalidAutomergeBase64}) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('smallframe-shared-v1', 2);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const read = async <T>(storeName: string): Promise<T> => await new Promise((resolve, reject) => {
          const request = database.transaction(storeName).objectStore(storeName).get(storedRoomId);
          request.onsuccess = () => resolve(request.result as T);
          request.onerror = () => reject(request.error);
        });
        const wrapped = await read<{version: 1; roomId: string; nonce: Uint8Array; ciphertext: ArrayBuffer}>('rooms');
        const device = await read<{roomId: string; key: CryptoKey}>('deviceKeys');
        const aad = new TextEncoder().encode(`smallframe/local-room/v1:${storedRoomId}`);
        const plaintext = await crypto.subtle.decrypt(
          {name: 'AES-GCM', iv: wrapped.nonce, additionalData: aad}, device.key, wrapped.ciphertext
        );
        const room = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
        room.automergeBase64 = invalidAutomergeBase64;
        room.state = {decisions: 'schema-invalid'};
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt(
          {name: 'AES-GCM', iv: nonce, additionalData: aad}, device.key,
          new TextEncoder().encode(JSON.stringify(room))
        );
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction('rooms', 'readwrite');
          transaction.objectStore('rooms').put({version: 1, roomId: storedRoomId, nonce, ciphertext});
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
        database.close();
      }, {roomId, invalidAutomergeBase64: sharedFixture.invalidSchemaBase64});

      await page.goto(`/r/${activeRoomId}#${fragment}`, {waitUntil: 'domcontentloaded'});
      await expect(page.locator('#status')).toHaveText(
        'Controller stopped: LOCAL_STATE_INVALID. Local export remains available.'
      );
      await expect(page.locator('iframe')).toHaveCount(0);
    } finally {
      expect((await request.post(networkControl, {data: {online: true}})).status()).toBe(204);
    }
  });

  test('unchecked remember consent leaves no room secrets or state in IndexedDB', async ({page}) => {
    const signed = await createSignedRoomDescriptor({publisherPrivateKey: publisherPriv, roomId: activeRoomId,
      packageDigest: sharedFixture.packageDigest, publisherKeyId: sharedFixture.publisherKeyId,
      writerPublicKey: await getPublicKeyAsync(writerPriv), capability: editorCap, role: 'editor', expiresAt: activeExpiry});
    const fragment = formatInviteFragment({descriptorJcsBytes: signed.jcsBytes, descriptorSignature: signed.signature,
      roomKey, capability: editorCap, writerPrivateSeed: writerPriv});
    await page.goto(`/r/${activeRoomId}#${fragment}`, {waitUntil: 'domcontentloaded'});
    await page.locator('#remember-approval').uncheck();
    await page.getByRole('button', {name: 'Open this exact version'}).click();
    const put = page.waitForResponse((r) => r.request().method() === 'PUT');
    await page.frameLocator('iframe').getByRole('button', {name: 'Add decision'}).click();
    expect((await put).status()).toBe(204);
    const counts = await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open('smallframe-shared-v1', 2);
        request.onsuccess = () => resolve(request.result);
      });
      const results = await Promise.all(['rooms', 'deviceKeys', 'approvals'].map((name) => new Promise<number>((resolve) => {
        const request = database.transaction(name).objectStore(name).count();
        request.onsuccess = () => resolve(request.result);
      })));
      database.close();
      return results;
    });
    expect(counts).toEqual([0, 0, 0]);
  });

  for (const kind of ['signature', 'expiry', 'room-path', 'relay-expiry', 'relay-role'] as const) {
  test(`fails closed before state access on ${kind} mismatch`, async ({page}) => {
    const signed = await createSignedRoomDescriptor({publisherPrivateKey: publisherPriv, roomId: activeRoomId,
      packageDigest: sharedFixture.packageDigest, publisherKeyId: sharedFixture.publisherKeyId,
      writerPublicKey: await getPublicKeyAsync(writerPriv), capability: editorCap, role: 'editor',
      expiresAt: kind === 'expiry' ? Date.now() - 1 : activeExpiry});
    if (kind === 'signature') signed.signature[0] = signed.signature[0]! ^ 1;
    if (kind.startsWith('relay-')) {
      const response = await page.request.post('http://127.0.0.1:8787/__test__/relay-metadata-fault',
        {data: {fault: kind === 'relay-expiry' ? 'expiry' : 'role'}});
      expect(response.status()).toBe(204);
    }
    let stateRequests = 0;
    page.on('request', (request) => {
      if (request.url().endsWith(`/v1/rooms/${activeRoomId}/state`)) stateRequests += 1;
    });
    const fragment = formatInviteFragment({descriptorJcsBytes: signed.jcsBytes, descriptorSignature: signed.signature,
      roomKey, capability: editorCap, writerPrivateSeed: writerPriv});
    const path = kind === 'room-path' ? `/r/${encodeBase64Url(randomBytes(16))}` : `/r/${activeRoomId}`;
    await page.goto(`${path}#${fragment}`, {waitUntil: 'domcontentloaded'});
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'error');
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(stateRequests).toBe(0);
  });
  }

  for (const [name, fixture] of [
    ['unsupported Automerge object', () => sharedFixture.hostileListBase64],
    ['schema-invalid projection', () => sharedFixture.invalidSchemaBase64]
  ] as const) {
  test(`rejects a validly encrypted and signed ${name} before app approval`, async ({page, request}) => {
    const roomId = makeRoomId();
    const envelope = await encryptSnapshot({roomKey, writerPrivateKey: writerPriv, roomId,
      appId: 'dev.example.decision-board', packageDigest: sharedFixture.packageDigest,
      stateEpoch: 0, proposedRevision: 1, previousEnvelopeDigest: encodeBase64Url(new Uint8Array(32)),
      automergeBytes: new Uint8Array(Buffer.from(fixture(), 'base64'))});
    const init = await request.post(`http://127.0.0.1:8787/__phase0/rooms/${roomId}/init-envelope`, {data: {
      viewerCapHash: encodeBase64Url(await sha256(viewerCap)), editorCapHash: encodeBase64Url(await sha256(editorCap)),
      expiresAtMs: activeExpiry, envelope: envelope.envelope
    }});
    expect(init.status()).toBe(201);
    const signed = await createSignedRoomDescriptor({publisherPrivateKey: publisherPriv, roomId,
      packageDigest: sharedFixture.packageDigest, publisherKeyId: sharedFixture.publisherKeyId,
      writerPublicKey: await getPublicKeyAsync(writerPriv), capability: editorCap, role: 'editor', expiresAt: activeExpiry});
    const fragment = formatInviteFragment({descriptorJcsBytes: signed.jcsBytes, descriptorSignature: signed.signature,
      roomKey, capability: editorCap, writerPrivateSeed: writerPriv});
    await page.goto(`/r/${roomId}#${fragment}`, {waitUntil: 'domcontentloaded'});
    await page.getByRole('button', {name: 'Open this exact version'}).click();
    await expect(page.locator('#trust-description')).toHaveText('REMOTE_STATE_INVALID');
    await expect(page.locator('#runtime-panel')).toBeHidden();
  });
  }
});
