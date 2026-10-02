import {describe, expect, it} from 'vitest';
import {MAX_RENDERER_BYTES, readRendererBody} from '../apps/controller/src/renderer-body.js';

describe('decoded renderer body hard limit', () => {
  it('accepts exactly two MiB regardless of a misleading transfer length', async () => {
    const bytes = new Uint8Array(MAX_RENDERER_BYTES); bytes[0] = 17; bytes[bytes.length - 1] = 29;
    const body = await readRendererBody(new Response(bytes, {headers: {'Content-Length': '1', 'Content-Encoding': 'gzip'}}));
    expect(body.byteLength).toBe(MAX_RENDERER_BYTES);
    expect(new Uint8Array(body)[0]).toBe(17); expect(new Uint8Array(body).at(-1)).toBe(29);
  });
  it('cancels as soon as decoded chunks exceed the limit, without awaiting cancellation', async () => {
    let cancelled = false; let reads = 0;
    const stream = new ReadableStream<Uint8Array>({pull(controller) {
      reads++; controller.enqueue(new Uint8Array(reads === 1 ? MAX_RENDERER_BYTES : 1));
    }, cancel() { cancelled = true; return new Promise(() => {}); }}, {highWaterMark: 0});
    await expect(readRendererBody(new Response(stream))).rejects.toThrow('RENDERER_TOO_LARGE');
    expect(cancelled).toBe(true); expect(reads).toBe(2);
  });
});
