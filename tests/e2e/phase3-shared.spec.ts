import {expect, test} from '@playwright/test';
import {gotoInvite} from './invite-navigation.js';
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

  test('failed invite navigation exposes only a generic diagnostic', async ({page, request}) => {
    const canary = encodeBase64Url(randomBytes(32));
    const networkControl = 'http://127.0.0.1:8787/__test__/controller-network';
    expect((await request.post(networkControl, {data: {online: false}})).status()).toBe(204);
    try {
      let caught: unknown;
      try { await gotoInvite(page, `/r/${activeRoomId}`, `v=1&k=${canary}`); }
      catch (error) { caught = error; }
      expect(caught instanceof Error).toBe(true);
      const error = caught as Error;
      expect(error.message === 'TEST_INVITE_NAVIGATION_FAILED').toBe(true);
      expect(error.cause === undefined).toBe(true);
      expect(String(error.stack).includes(canary)).toBe(false);
    } finally {
      expect((await request.post(networkControl, {data: {online: true}})).status()).toBe(204);
    }
  });

  for (const failure of ['abort', 'throw'] as const) {
    test(`initial remembered editor consent is atomic on approval ${failure}`, async ({page}) => {
      const signed = await createSignedRoomDescriptor({
        publisherPrivateKey: publisherPriv, roomId: activeRoomId,
        packageDigest: sharedFixture.packageDigest, publisherKeyId: sharedFixture.publisherKeyId,
        writerPublicKey: await getPublicKeyAsync(writerPriv), capability: editorCap,
        role: 'editor', expiresAt: activeExpiry
      });
      const fragment = formatInviteFragment({descriptorJcsBytes: signed.jcsBytes,
        descriptorSignature: signed.signature, roomKey, capability: editorCap, writerPrivateSeed: writerPriv});
      await gotoInvite(page, `/r/${activeRoomId}`, fragment);
      const approve = page.getByRole('button', {name: 'Open this exact version'});
      await expect(approve).toBeVisible();
      const counts = async () => page.evaluate(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('smallframe-shared-v1', 2);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(new Error('TEST_DB_OPEN_FAILED'));
        });
        try {
          return await Promise.all(['rooms', 'deviceKeys', 'approvals'].map(async (name) =>
            await new Promise<number>((resolve, reject) => {
              const request = database.transaction(name).objectStore(name).count();
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(new Error('TEST_DB_COUNT_FAILED'));
            })));
        } finally { database.close(); }
      });
      expect(await counts()).toEqual([0, 0, 0]);
      await page.evaluate((failure) => {
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(value, key) {
          if (this.name === 'approvals') {
            IDBObjectStore.prototype.put = original;
            if (failure === 'throw') throw new DOMException('TEST_ONLY', 'DataCloneError');
            const request = key === undefined ? original.call(this, value) : original.call(this, value, key);
            this.transaction.abort();
            return request;
          }
          return key === undefined ? original.call(this, value) : original.call(this, value, key);
        };
      }, failure);
      await approve.click();
      await expect(page.locator('#trust-description')).toContainText('SHARED_STORAGE_WRITE_');
      await expect(approve).toBeVisible();
      expect(await counts()).toEqual([0, 0, 0]);
      await expect(page.frameLocator('iframe').getByRole('button', {name: 'Add decision'})).toHaveCount(0);

      await approve.click();
      await expect(page.frameLocator('iframe').getByText('0 decisions')).toBeVisible();
      expect(await counts()).toEqual([1, 1, 1]);
      const rejectedContexts = await page.evaluate(async ({roomId, approvalId}) => {
        const api = (globalThis as typeof globalThis & {SmallframeSharedStore: {
          loadRoom: (id: string) => Promise<Record<string, unknown>>;
          loadApproval: (id: string) => Promise<Record<string, unknown>>;
          saveRoom: (room: Record<string, unknown>, approval: Record<string, unknown>) => Promise<void>;
        }}).SmallframeSharedStore;
        const room = await api.loadRoom(roomId);
        const approval = await api.loadApproval(approvalId);
        const results = [];
        for (const field of ['roomId', 'packageDigest', 'role']) {
          try { await api.saveRoom(room, {...approval, [field]: 'wrong-context'}); results.push(false); }
          catch (error) { results.push(error instanceof Error && error.message === 'LOCAL_APPROVAL_CONTEXT_INVALID'); }
        }
        return results;
      }, {roomId: activeRoomId, approvalId: `${activeRoomId}:${encodeBase64Url(signed.descriptorDigest)}`});
      expect(rejectedContexts).toEqual([true, true, true]);
      expect(await counts()).toEqual([1, 1, 1]);
      await gotoInvite(page, `/r/${activeRoomId}`, fragment);
      await expect(page.frameLocator('iframe').getByText('0 decisions')).toBeVisible();
    });
  }

  test('an aborted local commit cannot leak into sync and a later edit commits once', async ({page}) => {
    const signed = await createSignedRoomDescriptor({
      publisherPrivateKey: publisherPriv, roomId: activeRoomId,
      packageDigest: sharedFixture.packageDigest, publisherKeyId: sharedFixture.publisherKeyId,
      writerPublicKey: await getPublicKeyAsync(writerPriv), capability: editorCap,
      role: 'editor', expiresAt: activeExpiry
    });
    const fragment = formatInviteFragment({descriptorJcsBytes: signed.jcsBytes,
      descriptorSignature: signed.signature, roomKey, capability: editorCap, writerPrivateSeed: writerPriv});
    await gotoInvite(page, `/r/${activeRoomId}`, fragment);
    await page.getByRole('button', {name: 'Open this exact version'}).click();
    const app = page.frameLocator('iframe');
    await expect(app.getByText('0 decisions')).toBeVisible();

    let writes = 0;
    page.on('request', (request) => { if (request.method() === 'PUT') writes += 1; });
    // Abort after put has queued its request, before IndexedDB commits. No runtime
    // test hook is needed and the original method is restored on first injection.
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, key) {
        const request = key === undefined ? original.call(this, value) : original.call(this, value, key);
        if (this.name === 'rooms') {
          IDBObjectStore.prototype.put = original;
          this.transaction.abort();
        }
        return request;
      };
    });
    await app.getByRole('button', {name: 'Add decision'}).click();
    await expect(page.locator('#connectivity')).toHaveText('Local save failed');
    await expect(app.getByText('0 decisions')).toBeVisible();
    expect(writes).toBe(0);

    // A real sync must finish without resurrecting or publishing the rejected edit.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#connectivity')).toHaveText('Synced');
    await expect(app.getByText('0 decisions')).toBeVisible();
    expect(writes).toBe(0);

    await app.getByRole('button', {name: 'Add decision'}).click();
    await expect(app.getByText('1 decisions')).toBeVisible();
    await expect.poll(() => writes).toBe(1);
    await expect(page.locator('#connectivity')).toHaveText('Synced');
    await gotoInvite(page, `/r/${activeRoomId}`, fragment);
    await expect(page.frameLocator('iframe').getByText('1 decisions')).toBeVisible();
  });

  for (const failure of ['remote', 'acknowledgement'] as const) {
    test(`an aborted ${failure} commit preserves the durable replica and retries`, async ({page, browser, request}) => {
      const signed = await createSignedRoomDescriptor({publisherPrivateKey: publisherPriv, roomId: activeRoomId,
        packageDigest: sharedFixture.packageDigest, publisherKeyId: sharedFixture.publisherKeyId,
        writerPublicKey: await getPublicKeyAsync(writerPriv), capability: editorCap,
        role: 'editor', expiresAt: activeExpiry});
      const fragment = formatInviteFragment({descriptorJcsBytes: signed.jcsBytes, descriptorSignature: signed.signature,
        roomKey, capability: editorCap, writerPrivateSeed: writerPriv});
      await gotoInvite(page, `/r/${activeRoomId}`, fragment);
      await page.getByRole('button', {name: 'Open this exact version'}).click();
      const app = page.frameLocator('iframe');
      await expect(app.getByText('0 decisions')).toBeVisible();
      const peer = await browser.newContext();
      try {
        let writes = 0;
        page.on('request', (req) => { if (req.method() === 'PUT') writes += 1; });
        // Keep rejecting every candidate after the selected boundary, including
        // realtime retries. The fault changes no runtime code or plaintext record.
        await page.evaluate((failure) => {
          const scope = globalThis as any;
          let rejectWrites = failure === 'remote';
          const fetch = window.fetch;
          const put = IDBObjectStore.prototype.put;
          window.fetch = async (...args) => {
            const response = await fetch(...args);
            if (args[1]?.method === 'PUT' && response.ok) rejectWrites = true;
            return response;
          };
          IDBObjectStore.prototype.put = function(value, key) {
            const result = key === undefined ? put.call(this, value) : put.call(this, value, key);
            if (this.name === 'rooms' && rejectWrites) this.transaction.abort();
            return result;
          };
          scope.restoreCommitFault = () => { window.fetch = fetch; IDBObjectStore.prototype.put = put; };
        }, failure);
        if (failure === 'remote') {
          const other = await peer.newPage();
          await gotoInvite(other, `/r/${activeRoomId}`, fragment);
          await other.getByRole('button', {name: 'Open this exact version'}).click();
          await other.frameLocator('iframe').getByRole('button', {name: 'Add decision'}).click();
          await expect(other.locator('#connectivity')).toHaveText('Synced');
          await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        } else {
          await app.getByRole('button', {name: 'Add decision'}).click();
          await expect.poll(() => writes).toBe(1);
        }
        await expect(page.locator('#connectivity')).toHaveText('Sync paused · local copy retained');
        await expect(app.getByText(failure === 'remote' ? '0 decisions' : '1 decisions')).toBeVisible();
        // Return only coordination metadata; never return decrypted state or keys.
        const saved = await page.evaluate(async (roomId) => {
          const room = await (globalThis as any).SmallframeSharedStore.loadRoom(roomId);
          return {revision: room.revision, dirty: room.dirty};
        }, activeRoomId);
        expect(saved).toEqual({revision: 1, dirty: failure === 'acknowledgement'});
        await page.evaluate(() => { (globalThis as any).restoreCommitFault(); window.dispatchEvent(new Event('focus')); });
        await expect(page.locator('#connectivity')).toHaveText('Synced');
        await expect(app.getByText('1 decisions')).toBeVisible();
        // A rejected acknowledgement must retain dirty intent until a later
        // successful CAS and durable acknowledgement; a remote merge emits no PUT.
        expect(writes).toBe(failure === 'remote' ? 0 : 2);
        const committed = await page.evaluate(async (roomId) => {
          const room = await (globalThis as any).SmallframeSharedStore.loadRoom(roomId);
          return {revision: room.revision, dirty: room.dirty};
        }, activeRoomId);
        expect(committed).toEqual({revision: failure === 'remote' ? 2 : 3, dirty: false});
        await peer.close();
        // Drop real controller and relay transports. Browser offline emulation
        // also disables SW navigation in some engines and is not an outage proxy.
        expect((await request.post('http://127.0.0.1:8787/__test__/relay-network',
          {data: {online: false, disconnect: true}})).status()).toBe(204);
        expect((await request.post('http://127.0.0.1:8787/__test__/controller-network',
          {data: {online: false}})).status()).toBe(204);
        await gotoInvite(page, `/r/${activeRoomId}`, fragment);
        await expect(page.frameLocator('iframe').getByText('1 decisions')).toBeVisible();
      } finally {
        await request.post('http://127.0.0.1:8787/__test__/controller-network', {data: {online: true}});
        await request.post('http://127.0.0.1:8787/__test__/relay-network', {data: {online: true}});
        await peer.close();
      }
    });
  }

  for (const fault of ['oversized', 'stalled'] as const) {
    test(`bounds an ${fault} relay response and retains a usable replica`, async ({page}) => {
      const signed = await createSignedRoomDescriptor({publisherPrivateKey: publisherPriv, roomId: activeRoomId,
        packageDigest: sharedFixture.packageDigest, publisherKeyId: sharedFixture.publisherKeyId,
        writerPublicKey: await getPublicKeyAsync(writerPriv), capability: editorCap,
        role: 'editor', expiresAt: activeExpiry});
      const fragment = formatInviteFragment({descriptorJcsBytes: signed.jcsBytes, descriptorSignature: signed.signature,
        roomKey, capability: editorCap, writerPrivateSeed: writerPriv});
      await gotoInvite(page, `/r/${activeRoomId}`, fragment);
      await page.getByRole('button', {name: 'Open this exact version'}).click();
      const app = page.frameLocator('iframe');
      await expect(app.getByText('0 decisions')).toBeVisible();
      await page.evaluate((fault) => {
        const scope = globalThis as any;
        const fetch = window.fetch;
        const evidence = {chunks: 0, cancelled: false};
        scope.bodyFaultEvidence = evidence;
        scope.restoreBodyFault = () => { window.fetch = fetch; };
        window.fetch = async (...args) => {
          if (!String(args[0]).endsWith('/state')) return fetch(...args);
          return new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
              if (fault === 'stalled') return;
              evidence.chunks += 1;
              // Bounded pressure fixture even if the client limit regresses.
              if (evidence.chunks > 20) { controller.close(); return; }
              controller.enqueue(new Uint8Array(65_536).fill(32));
            },
            cancel() { evidence.cancelled = true; }
          }), {headers: {'Content-Type': 'application/json', 'Content-Length': '1'}});
        };
        window.dispatchEvent(new Event('focus'));
      }, fault);
      await expect(page.locator('#connectivity')).toHaveText('Sync paused · local copy retained', {timeout: 8000});
      const evidence = await page.evaluate(() => (globalThis as any).bodyFaultEvidence as {chunks: number; cancelled: boolean});
      expect(evidence.cancelled).toBe(true);
      expect(evidence.chunks).toBeLessThanOrEqual(13);
      await expect(app.getByText('0 decisions')).toBeVisible();
      const saved = await page.evaluate(async (roomId) => {
        const room = await (globalThis as any).SmallframeSharedStore.loadRoom(roomId);
        return {revision: room.revision, dirty: room.dirty};
      }, activeRoomId);
      expect(saved).toEqual({revision: 1, dirty: false});
      await page.evaluate(() => { (globalThis as any).restoreBodyFault(); window.dispatchEvent(new Event('focus')); });
      await expect(page.locator('#connectivity')).toHaveText('Synced');
      await app.getByRole('button', {name: 'Add decision'}).click();
      await expect(app.getByText('1 decisions')).toBeVisible();
      await expect(page.locator('#connectivity')).toHaveText('Synced');
    });
  }

  for (const field of ['revision', 'etag', 'actorId', 'dirty', 'automergeBase64'] as const) {
    test(`rejects authenticated local corruption in ${field} before state access`, async ({page}) => {
      const signed = await createSignedRoomDescriptor({publisherPrivateKey: publisherPriv, roomId: activeRoomId,
        packageDigest: sharedFixture.packageDigest, publisherKeyId: sharedFixture.publisherKeyId,
        writerPublicKey: await getPublicKeyAsync(writerPriv), capability: editorCap,
        role: 'editor', expiresAt: activeExpiry});
      const fragment = formatInviteFragment({descriptorJcsBytes: signed.jcsBytes, descriptorSignature: signed.signature,
        roomKey, capability: editorCap, writerPrivateSeed: writerPriv});
      await gotoInvite(page, `/r/${activeRoomId}`, fragment);
      await page.getByRole('button', {name: 'Open this exact version'}).click();
      await expect(page.frameLocator('iframe').getByText('0 decisions')).toBeVisible();
      // Exit the runtime before writing a legitimately wrapped but corrupt record.
      await page.goto('/icon.svg', {waitUntil: 'commit'});
      await page.evaluate(async ({roomId, field}) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('smallframe-shared-v1', 2);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(new Error('TEST_DATABASE_OPEN_FAILED'));
        });
        const read = (store: string): Promise<any> => new Promise((resolve, reject) => {
          const request = database.transaction(store).objectStore(store).get(roomId);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(new Error('TEST_DATABASE_READ_FAILED'));
        });
        const [wrapped, device] = await Promise.all([read('rooms'), read('deviceKeys')]);
        const aad = new TextEncoder().encode(`smallframe/local-room/v1:${roomId}`);
        const plaintext = await crypto.subtle.decrypt({name: 'AES-GCM', iv: wrapped.nonce, additionalData: aad}, device.key, wrapped.ciphertext);
        const room = JSON.parse(new TextDecoder().decode(plaintext));
        const invalid = {revision: 0, etag: '*', actorId: 'g'.repeat(32), dirty: 'false', automergeBase64: 'AB'};
        room[field] = invalid[field];
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce, additionalData: aad}, device.key,
          new TextEncoder().encode(JSON.stringify(room)));
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction('rooms', 'readwrite');
          transaction.objectStore('rooms').put({version: 1, roomId, nonce, ciphertext});
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(new Error('TEST_DATABASE_WRITE_FAILED'));
        });
        database.close();
      }, {roomId: activeRoomId, field});
      let stateRequests = 0;
      page.on('request', (request) => { if (request.url().endsWith('/state')) stateRequests += 1; });
      await gotoInvite(page, `/r/${activeRoomId}`, fragment);
      await expect(page.locator('#status')).toContainText('LOCAL_STATE_INVALID');
      await expect(page.locator('iframe')).toHaveCount(0);
      expect(stateRequests).toBe(0);
    });
  }

  test('rejects a relay ETag that differs from the authenticated envelope', async ({page}) => {
    const signed = await createSignedRoomDescriptor({publisherPrivateKey: publisherPriv, roomId: activeRoomId,
      packageDigest: sharedFixture.packageDigest, publisherKeyId: sharedFixture.publisherKeyId,
      writerPublicKey: await getPublicKeyAsync(writerPriv), capability: editorCap,
      role: 'editor', expiresAt: activeExpiry});
    const fragment = formatInviteFragment({descriptorJcsBytes: signed.jcsBytes, descriptorSignature: signed.signature,
      roomKey, capability: editorCap, writerPrivateSeed: writerPriv});
    await gotoInvite(page, `/r/${activeRoomId}`, fragment);
    await page.getByRole('button', {name: 'Open this exact version'}).click();
    const app = page.frameLocator('iframe');
    await expect(app.getByText('0 decisions')).toBeVisible();
    await page.evaluate(() => {
      const fetch = window.fetch;
      (globalThis as any).restoreEtagFault = () => { window.fetch = fetch; };
      window.fetch = async (...args) => {
        const response = await fetch(...args);
        if (!String(args[0]).endsWith('/state')) return response;
        const headers = new Headers(response.headers);
        headers.set('ETag', '*');
        return new Response(response.body, {status: response.status, headers});
      };
      window.dispatchEvent(new Event('focus'));
    });
    await expect(page.locator('#connectivity')).toHaveText('Sync paused · local copy retained');
    const intact = await page.evaluate(async (roomId) => {
      const room = await (globalThis as any).SmallframeSharedStore.loadRoom(roomId);
      return room.revision === 1 && room.dirty === false && room.etag !== '*';
    }, activeRoomId);
    expect(intact).toBe(true);
    await expect(app.getByText('0 decisions')).toBeVisible();
    await page.evaluate(() => { (globalThis as any).restoreEtagFault(); window.dispatchEvent(new Event('focus')); });
    await expect(page.locator('#connectivity')).toHaveText('Synced');
    await app.getByRole('button', {name: 'Add decision'}).click();
    await expect(app.getByText('1 decisions')).toBeVisible();
    await expect(page.locator('#connectivity')).toHaveText('Synced');
  });

  for (const fault of ['duplicate', 'escaped-duplicate', 'unknown-field', 'revision-zero'] as const) {
    test(`rejects a signed relay envelope with ${fault} before approval`, async ({page}) => {
      const signed = await createSignedRoomDescriptor({publisherPrivateKey: publisherPriv, roomId: activeRoomId,
        packageDigest: sharedFixture.packageDigest, publisherKeyId: sharedFixture.publisherKeyId,
        writerPublicKey: await getPublicKeyAsync(writerPriv), capability: editorCap,
        role: 'editor', expiresAt: activeExpiry});
      const fragment = formatInviteFragment({descriptorJcsBytes: signed.jcsBytes, descriptorSignature: signed.signature,
        roomKey, capability: editorCap, writerPrivateSeed: writerPriv});
      const encrypted = await encryptSnapshot({roomKey, writerPrivateKey: writerPriv, roomId: activeRoomId,
        appId: 'dev.example.decision-board', packageDigest: sharedFixture.packageDigest, stateEpoch: 0,
        proposedRevision: fault === 'revision-zero' ? 0 : 1, previousEnvelopeDigest: encodeBase64Url(new Uint8Array(32)),
        automergeBytes: new Uint8Array(readFileSync('target/phase1-wasm/phase3-genesis.bin'))});
      let body = JSON.stringify(encrypted.envelope);
      if (fault === 'duplicate') body = '{"version":1,' + body.slice(1);
      if (fault === 'escaped-duplicate') body = '{"\\u0076ersion":1,' + body.slice(1);
      if (fault === 'unknown-field') body = '{"ignored":true,' + body.slice(1);
      await gotoInvite(page, `/r/${activeRoomId}`, fragment);
      // The envelope is correctly signed; only the wire contract is malformed.
      // Transfer ciphertext only, never room keys or decrypted content.
      await page.evaluate((body) => {
        const fetch = window.fetch;
        (globalThis as any).restoreEnvelopeFault = () => { window.fetch = fetch; };
        window.fetch = async (...args) => String(args[0]).endsWith('/state')
          ? new Response(body, {headers: {'Content-Type': 'application/json'}}) : fetch(...args);
      }, body);
      await page.getByRole('button', {name: 'Open this exact version'}).click();
      await expect(page.locator('#trust-description')).toHaveText('REMOTE_STATE_INVALID');
      await expect(page.frameLocator('iframe').getByRole('button')).toHaveCount(0);
      const empty = await page.evaluate(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('smallframe-shared-v1', 2);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(new Error('TEST_DATABASE_OPEN_FAILED'));
        });
        const count = (name: string): Promise<number> => new Promise((resolve) => {
          const request = database.transaction(name).objectStore(name).count();
          request.onsuccess = () => resolve(request.result);
        });
        const counts = await Promise.all(['rooms', 'deviceKeys', 'approvals'].map(count));
        database.close();
        return counts.every((count) => count === 0);
      });
      expect(empty).toBe(true);
      await page.evaluate(() => (globalThis as any).restoreEnvelopeFault());
      await page.getByRole('button', {name: 'Open this exact version'}).click();
      await expect(page.frameLocator('iframe').getByText('0 decisions')).toBeVisible();
    });
  }

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
    await gotoInvite(page, `/r/${activeRoomId}`, editorFragment);

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
    await gotoInvite(viewerPage, `/r/${activeRoomId}`, viewerFragment);

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

    await gotoInvite(page, `/r/${activeRoomId}`, fragment);
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
    await gotoInvite(page, `/r/${activeRoomId}`, fragment);
    await page.getByRole('button', {name: 'Open this exact version'}).click();
    await expect(page.locator('#role')).toHaveText('editor');

    // Tab 2 in same browser profile opens same editor invite
    const tab2 = await context.newPage();
    await gotoInvite(tab2, `/r/${activeRoomId}`, fragment);
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
    await gotoInvite(pageA, `/r/${activeRoomId}`, fragment);
    await pageA.locator('#remember-approval').check();
    await pageA.getByRole('button', {name: 'Open this exact version'}).click();
    const appA = pageA.frameLocator('iframe');
    await expect(appA.getByText('0 decisions')).toBeVisible();

    // Profile B (Editor B in separate browser context/profile)
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await gotoInvite(pageB, `/r/${activeRoomId}`, fragment);
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

    await gotoInvite(page, `/r/${activeRoomId}`, fragment);
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
      await gotoInvite(page, `/r/${activeRoomId}`, fragment);
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

      await gotoInvite(page, `/r/${activeRoomId}`, fragment);
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
    await gotoInvite(page, `/r/${activeRoomId}`, fragment);
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
    await gotoInvite(page, `${path}`, fragment);
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
    await gotoInvite(page, `/r/${roomId}`, fragment);
    await page.getByRole('button', {name: 'Open this exact version'}).click();
    await expect(page.locator('#trust-description')).toHaveText('REMOTE_STATE_INVALID');
    await expect(page.locator('#runtime-panel')).toBeHidden();
  });
  }
});
