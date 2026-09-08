import {afterEach, describe, expect, it, vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import {readBoundedJson} from './bounded-json.js';

const stream = (chunks: Uint8Array[], finish = true, cancel = vi.fn()): Response => new Response(new ReadableStream({
  start(controller) { for (const chunk of chunks) controller.enqueue(chunk); if (finish) controller.close(); },
  cancel
}), {headers: {'Content-Length': '1'}});
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
afterEach(() => vi.useRealTimers());

describe('bounded remote JSON reader', () => {
  it('accepts exactly the byte ceiling and split UTF-8 regardless of claimed length', async () => {
    const encoded = bytes('{"x":"µ"}');
    const response = stream(Array.from(encoded, (byte) => Uint8Array.of(byte)));
    expect(await readBoundedJson(response, encoded.length)).toEqual({x: 'µ'});
    expect(response.body!.locked).toBe(false);
  });
  it('rejects one excess byte across chunks and cancels without consuming the tail', async () => {
    const cancel = vi.fn();
    const response = stream([bytes('{}'), bytes(' '), bytes('unread')], false, cancel);
    await expect(readBoundedJson(response, 2)).rejects.toThrow('REMOTE_STATE_INVALID');
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  });
  it('counts multibyte input as bytes, not string characters', async () => {
    await expect(readBoundedJson(stream([bytes('"µ"')]), 3)).rejects.toThrow('REMOTE_STATE_INVALID');
  });
  it.each([Uint8Array.of(0x22, 0xc3, 0x22), Uint8Array.of(0x22, 0xc3)])('rejects invalid or truncated UTF-8', async (input) => {
    await expect(readBoundedJson(stream([input]), 32)).rejects.toThrow('REMOTE_STATE_INVALID');
  });
  it('discards parser diagnostics and transport causes', async () => {
    const canary = randomBytes(32).toString('hex');
    const broken = new ReadableStream({start(controller) { controller.error(new Error(canary)); }});
    for (const response of [stream([bytes(canary)]), new Response(broken)]) {
      let caught: unknown;
      try { await readBoundedJson(response, 128); } catch (error) { caught = error; }
      expect(caught instanceof Error).toBe(true);
      const error = caught as Error;
      expect(error.message === 'REMOTE_STATE_INVALID').toBe(true);
      expect(error.cause === undefined).toBe(true);
      expect(String(error.stack).includes(canary)).toBe(false);
    }
  });
  it('times out a stalled body even when cancellation never resolves', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = stream([bytes('{')], false, cancel);
    const result = expect(readBoundedJson(response, 128, 10)).rejects.toThrow('REMOTE_STATE_INVALID');
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects an absent body', async () => {
    await expect(readBoundedJson(new Response(null), 32)).rejects.toThrow('REMOTE_STATE_INVALID');
  });
});
