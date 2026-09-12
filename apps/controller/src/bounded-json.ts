import {parseUniqueJson} from './strict-json.js';

// Bound bytes before decoding/parsing; Content-Length is untrusted and optional.
export const readBoundedJson = async (response: Response, maximumBytes: number, timeoutMs = 5000): Promise<unknown> => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || !Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error();
    reader = response.body?.getReader();
    if (!reader) throw new Error();
    const active = reader;
    const consume = async (): Promise<unknown> => {
      const decoder = new TextDecoder('utf-8', {fatal: true});
      let length = 0;
      let json = '';
      for (;;) {
        const {value, done} = await active.read();
        if (done) return parseUniqueJson(json + decoder.decode());
        if (value.byteLength > maximumBytes - length) throw new Error();
        length += value.byteLength;
        json += decoder.decode(value, {stream: true});
      }
    };
    return await Promise.race([consume(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error()), timeoutMs);
    })]);
  } catch {
    // JSON parser and transport errors can contain attacker-controlled text.
    throw new Error('REMOTE_STATE_INVALID');
  } finally {
    clearTimeout(timer);
    if (reader) {
      // Cleanup must not extend the deadline if the underlying source stalls.
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
};
