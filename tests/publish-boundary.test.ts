import {createHash, randomBytes} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {handlePublishRoute} from '../apps/api/src/publish-router.js';
import {handleAdminCreateInvite, handleEnrollment, handlePackageUpload, MAX_PACKAGE_UPLOAD_BYTES,
  globalPublishStore, type PublishStore} from '../apps/api/src/publish-api.js';
import {createSignedEnrollment, encodeBase64Url} from '../packages/protocol/src/index.js';
import {utils} from '@noble/ed25519';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('base64url');
const fixture = () => {
  const store: PublishStore = {invites: new Map(), publishers: new Map(), publishersByKeyId: new Map(),
    packages: new Map(), rooms: new Map(), operations: new Map()};
  const token = randomBytes(32);
  store.publishers.set(hash(token), {publisherKeyId: `sha256:${hash(randomBytes(32))}`, publisherPublicKey: randomBytes(32).toString('base64url'),
    tokenHash: hash(token), enrolledAt: Date.now()});
  const request = (body: Uint8Array | ReadableStream<Uint8Array>, authorization = `Bearer ${token.toString('base64url')}`) =>
    new Request('http://api.localhost/v1/packages', {method: 'POST', body, duplex: 'half',
      headers: {Authorization: authorization, 'Content-Length': '1'}} as RequestInit);
  return {store, request};
};
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('local publishing prototype boundary', () => {
  it('bounds and strictly parses invite and enrollment requests before any state change', async () => {
    const {store} = fixture();
    const request = (path: string, body: BodyInit) => new Request(`http://api.localhost${path}`,
      {method: 'POST', body, duplex: 'half', headers: {'Content-Type': 'application/json'}} as RequestInit);
    const counts = () => [store.invites.size, store.publishers.size, store.operations.size];
    const initial = counts();
    const code = randomBytes(24).toString('base64url');
    expect((await handleAdminCreateInvite(new Request('http://api.localhost/v1/admin/invite',
      {method: 'POST', body: JSON.stringify({code})}), store)).status).toBe(415);
    expect(counts()).toEqual(initial);
    for (const body of [
      JSON.stringify({code, expiresInMs: 0}),
      JSON.stringify({code, expiresInMs: 7 * 86_400_000 + 1}),
      JSON.stringify({code, extra: true}),
      `{"code":"${code}","co\\u0064e":"${code}"}`,
      JSON.stringify({code: 'short'}),
    ]) {
      expect((await handleAdminCreateInvite(request('/v1/admin/invite', body), store)).status).toBe(400);
      expect(counts()).toEqual(initial);
    }
    expect((await handleAdminCreateInvite(request('/v1/admin/invite', new Uint8Array(1_025)), store)).status).toBe(413);
    expect(counts()).toEqual(initial);
    const invite = await handleAdminCreateInvite(request('/v1/admin/invite', JSON.stringify({code})), store);
    expect(invite.status).toBe(201);
    const inviteHash = (await invite.json() as {codeHash: string}).codeHash;
    const inviteCount = counts();

    const publisherPrivateKey = utils.randomPrivateKey();
    const signed = await createSignedEnrollment({publisherPrivateKey,
      tokenHash: randomBytes(32), operationId: randomBytes(16), inviteCodeHash: createHash('sha256').update(code).digest()});
    const jcsBytes = encodeBase64Url(signed.jcsBytes);
    const signature = encodeBase64Url(signed.signature);
    expect((await handleEnrollment(new Request('http://api.localhost/v1/enroll',
      {method: 'POST', body: JSON.stringify({jcsBytes, signature})}), store)).status).toBe(415);
    expect(counts()).toEqual(inviteCount);
    for (const body of [
      `{"jcsBytes":"${jcsBytes}","signature":"${signature}","signature":"${signature}"}`,
      JSON.stringify({jcsBytes, signature, extra: true}),
      JSON.stringify({jcsBytes: `${jcsBytes}=`, signature}),
      JSON.stringify({jcsBytes, signature: `${signature}=`}),
      new Uint8Array([0xff]),
    ]) {
      expect((await handleEnrollment(request('/v1/enroll', body), store)).status).toBe(400);
      expect(counts()).toEqual(inviteCount);
    }
    expect((await handleEnrollment(request('/v1/enroll', new Uint8Array(2_049)), store)).status).toBe(413);
    expect(counts()).toEqual(inviteCount);
    const valid = request('/v1/enroll', JSON.stringify({jcsBytes, signature}));
    expect((await handleEnrollment(valid, store)).status).toBe(201);
    expect(store.operations.size).toBe(1);
    expect((await handleEnrollment(request('/v1/enroll', JSON.stringify({jcsBytes, signature})), store)).status).toBe(200);
    expect((await handleEnrollment(request('/v1/enroll', `{"signature":"${signature}","jcsBytes":"${jcsBytes}"}`), store)).status).toBe(409);
    expect(store.operations.size).toBe(1);
    const consumedAt = store.invites.get(inviteHash)?.usedAt;
    expect(consumedAt).toBeTypeOf('number');
    expect((await handleAdminCreateInvite(request('/v1/admin/invite', JSON.stringify({code})), store)).status).toBe(409);
    expect(store.invites.get(inviteHash)?.usedAt).toBe(consumedAt);
    const second = await createSignedEnrollment({publisherPrivateKey,
      tokenHash: randomBytes(32), operationId: randomBytes(16), inviteCodeHash: createHash('sha256').update(code).digest()});
    expect((await handleEnrollment(request('/v1/enroll', JSON.stringify({
      jcsBytes: encodeBase64Url(second.jcsBytes), signature: encodeBase64Url(second.signature),
    })), store)).status).toBe(403);
    expect(store.operations.size).toBe(1);
  });

  it('bounds a stalled enrollment body with one deadline and leaves the invite unconsumed', async () => {
    const {store} = fixture();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stalled = new Request('http://api.localhost/v1/enroll', {method: 'POST',
      body: new ReadableStream<Uint8Array>({cancel}), duplex: 'half',
      headers: {'Content-Type': 'application/json'}} as RequestInit);
    vi.useFakeTimers();
    const reader = vi.spyOn(stalled.body!, 'getReader');
    const pending = handleEnrollment(stalled, store);
    await vi.waitFor(() => expect(reader).toHaveBeenCalledOnce(), {interval: 1, timeout: 1_000});
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce();
    expect(store.invites.size).toBe(0);
    expect(store.operations.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['staging', 'production'] as const)('rejects every publisher prototype path in %s before touching credentials, bodies, stores or DOs', async (ENVIRONMENT) => {
    let touched = 0;
    const forbidden = (): never => { touched += 1; throw new Error('untrusted detail'); };
    const before = Object.values(globalPublishStore).map((map) => map.size);
    const env = {ENVIRONMENT, ROOMS: {get: forbidden, idFromName: forbidden}};
    for (const path of ['/v1/enroll', '/v1/admin/invite', '/v1/packages', '/v1/packages/public-digest', '/v1/rooms']) {
      for (const method of ['GET', 'POST', 'OPTIONS']) {
        const request = new Request(`http://api.localhost${path}`, {method});
        Object.defineProperty(request, 'headers', {get: forbidden});
        Object.defineProperty(request, 'body', {get: forbidden});
        Object.defineProperty(request, 'json', {value: forbidden});
        Object.defineProperty(request, 'arrayBuffer', {value: forbidden});
        const response = await handlePublishRoute(path, request, env);
        expect(response?.status).toBe(503);
        expect(response?.headers.get('Cache-Control')).toBe('no-store');
        expect(await response?.json()).toEqual({type: 'urn:smallframe:error:publishing_not_implemented', title: 'PUBLISHING_NOT_IMPLEMENTED', status: 503});
      }
    }
    expect(touched).toBe(0);
    expect(Object.values(globalPublishStore).map((map) => map.size)).toEqual(before);
    for (const path of ['/healthz', '/v1/rooms/public-room/state', '/v1/rooms/public-room/packages/public-digest']) {
      expect(await handlePublishRoute(path, new Request(`http://api.localhost${path}`), env)).toBeNull();
    }
  });

  it('accepts exactly 1 MiB across chunks, rejects one excess byte despite a false length, and never awaits cancellation', async () => {
    const {store, request} = fixture();
    const source = (extra: boolean, cancel = vi.fn()) => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PACKAGE_UPLOAD_BYTES - 1));
        controller.enqueue(Uint8Array.of(1));
        if (extra) controller.enqueue(Uint8Array.of(2));
        else controller.close();
      }, cancel,
    });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const rejected = await handlePackageUpload(request(source(true, cancel)), store);
    expect(rejected.status).toBe(413);
    expect((await rejected.json() as {title: string}).title).toBe('PACKAGE_SIZE_LIMIT');
    expect(cancel).toHaveBeenCalledOnce();
    expect(store.packages.size).toBe(0);
    const accepted = await handlePackageUpload(request(source(false)), store);
    expect(accepted.status).toBe(201);
    expect(store.packages.size).toBe(1);
    expect([...store.packages.values()][0]!.byteLength).toBe(MAX_PACKAGE_UPLOAD_BYTES);
    // This is a local byte-storage fixture, not ZIP/signature validation.
  });

  it('does not read unauthorized bodies and contains upload transport failures without storing bytes', async () => {
    const {store, request} = fixture();
    const unauthorized = request(new Uint8Array(100), 'Bearer malformed');
    let touched = 0;
    Object.defineProperty(unauthorized, 'body', {get: () => { touched += 1; throw new Error('untrusted detail'); }});
    expect((await handlePackageUpload(unauthorized, store)).status).toBe(401);
    expect(touched).toBe(0);
    const transport = request(new ReadableStream({start(controller) { controller.error(new Error('untrusted transport detail')); }}));
    const response = await handlePackageUpload(transport, store);
    expect(response.status).toBe(400);
    expect((await response.json() as {title: string}).title).toBe('PACKAGE_UPLOAD_INVALID');
    expect(store.packages.size).toBe(0);
    expect((await handlePackageUpload(request(new Uint8Array(99)), store)).status).toBe(400);
    expect(store.packages.size).toBe(0);
  });

  it('keeps one 5-second upload deadline despite late chunks and uncooperative cancellation, then permits a valid retry', async () => {
    const {store, request} = fixture();
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stalled = request(new ReadableStream({start(value) { controller = value; }, cancel}));
    const reader = vi.spyOn(stalled.body!, 'getReader');
    const pending = handlePackageUpload(stalled, store);
    await vi.waitFor(() => expect(reader).toHaveBeenCalledOnce(), {interval: 1, timeout: 1_000});
    await vi.advanceTimersByTimeAsync(4_000);
    controller.enqueue(Uint8Array.of(1));
    await vi.advanceTimersByTimeAsync(1_000);
    const response = await pending;
    expect(response.status).toBe(400);
    expect((await response.json() as {title: string}).title).toBe('PACKAGE_UPLOAD_INVALID');
    expect(cancel).toHaveBeenCalledOnce();
    expect(store.packages.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    expect((await handlePackageUpload(request(new Uint8Array(100)), store)).status).toBe(201);
    expect(store.packages.size).toBe(1);
  });
});
