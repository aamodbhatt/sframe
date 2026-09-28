import {createHash, randomBytes} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {handlePublishRoute} from '../apps/api/src/publish-router.js';
import {handlePackageUpload, MAX_PACKAGE_UPLOAD_BYTES, globalPublishStore, type PublishStore} from '../apps/api/src/publish-api.js';

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
