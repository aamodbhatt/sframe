import {afterEach, describe, expect, it, vi} from 'vitest';
import {readBoundedBody} from './bounded-body.js';

const requestFor = (body: ReadableStream<Uint8Array> | null): Request => new Request('http://localhost/state', {
  method: 'PUT', body, duplex: 'half', headers: {'Content-Length': '1'}
} as RequestInit);
const source = (chunks: Uint8Array[], close = true, cancel = vi.fn()): Request => requestFor(new ReadableStream({
  start(controller) { for (const chunk of chunks) controller.enqueue(chunk); if (close) controller.close(); }, cancel
}));
afterEach(() => vi.useRealTimers());

describe('bounded relay body reader', () => {
  it('accepts exactly the byte limit across chunks regardless of claimed length', async () => {
    const request = source([Uint8Array.of(1), Uint8Array.of(2, 3)]);
    expect(await readBoundedBody(request, 3)).toEqual({kind: 'ok', body: Uint8Array.of(1, 2, 3)});
    expect(request.body!.locked).toBe(false);
  });
  it('rejects one excess byte without waiting for cancellation or reading the tail', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const request = source([Uint8Array.of(1, 2), Uint8Array.of(3), Uint8Array.of(4)], false, cancel);
    expect(await readBoundedBody(request, 2)).toEqual({kind: 'too-large'});
    expect(cancel).toHaveBeenCalledOnce();
    expect(request.body!.locked).toBe(false);
  });
  it('times out a stalled upload even when cancellation never resolves', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const request = source([Uint8Array.of(1)], false, cancel);
    const result = readBoundedBody(request, 8, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toEqual({kind: 'invalid'});
    expect(cancel).toHaveBeenCalledOnce();
    expect(request.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not renew the deadline when more bytes arrive', async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const request = requestFor(new ReadableStream({start(value) { controller = value; }}));
    const result = readBoundedBody(request, 8, 10);
    await vi.advanceTimersByTimeAsync(9);
    controller.enqueue(Uint8Array.of(1));
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({kind: 'invalid'});
    expect(request.body!.locked).toBe(false);
  });
  it('contains source errors and invalid chunk types', async () => {
    const broken = requestFor(new ReadableStream({start(controller) { controller.error(new Error('untrusted transport detail')); }}));
    const malformed = source(['not bytes' as unknown as Uint8Array], false, vi.fn(() => Promise.reject(new Error('untrusted cancellation detail'))));
    for (const request of [broken, malformed]) {
      expect(await readBoundedBody(request, 8)).toEqual({kind: 'invalid'});
      expect(request.body!.locked).toBe(false);
    }
  });
  it('rejects locked bodies without releasing another consumer lock', async () => {
    const request = source([Uint8Array.of(1)]);
    const reader = request.body!.getReader();
    expect(await readBoundedBody(request, 8)).toEqual({kind: 'invalid'});
    expect(request.body!.locked).toBe(true);
    reader.releaseLock();
  });
  it('accepts an absent body for the caller to apply endpoint rules', async () => {
    expect(await readBoundedBody(requestFor(null), 8)).toEqual({kind: 'ok', body: new Uint8Array()});
  });
  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid byte limits (%s)', async (limit) => {
    expect(await readBoundedBody(requestFor(null), limit)).toEqual({kind: 'invalid'});
  });
  it.each([0, -1, NaN, Infinity, 1.5, 2_147_483_648])('rejects invalid deadlines (%s)', async (timeout) => {
    expect(await readBoundedBody(requestFor(null), 8, timeout)).toEqual({kind: 'invalid'});
  });
});
