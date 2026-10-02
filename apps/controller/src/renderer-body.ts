export const MAX_RENDERER_BYTES = 2 * 1024 * 1024;

// Bound decoded bytes before allocating the contiguous verifier/hash input.
// Content-Length is deliberately not an authority for a Fetch-decoded body.
export const readRendererBody = async (response: Response): Promise<ArrayBuffer> => {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > MAX_RENDERER_BYTES - length) {
        void reader.cancel().catch(() => {});
        throw new Error('RENDERER_TOO_LARGE');
      }
      chunks.push(next.value); length += next.value.byteLength;
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body.buffer;
};
