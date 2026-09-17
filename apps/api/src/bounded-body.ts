type BoundedBodyResult =
  | {kind: 'ok'; body: Uint8Array}
  | {kind: 'too-large'}
  | {kind: 'invalid'};

// One deadline covers the entire upload; individual chunks do not renew it.
export const readBoundedBody = async (request: Request, maximumBytes: number, timeoutMs = 5000): Promise<BoundedBodyResult> => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) return {kind: 'invalid'};
    if (!request.body) return {kind: 'ok', body: new Uint8Array()};
    reader = request.body.getReader();
    const active = reader;
    const buffer = new Uint8Array(maximumBytes);
    const consume = async (): Promise<BoundedBodyResult> => {
      let length = 0;
      for (;;) {
        const {value, done} = await active.read();
        if (done) return {kind: 'ok', body: buffer.slice(0, length)};
        if (!(value instanceof Uint8Array)) return {kind: 'invalid'};
        if (value.byteLength > maximumBytes - length) return {kind: 'too-large'};
        buffer.set(value, length);
        length += value.byteLength;
      }
    };
    return await Promise.race([consume(), new Promise<BoundedBodyResult>((resolve) => {
      timer = setTimeout(() => resolve({kind: 'invalid'}), timeoutMs);
    })]);
  } catch {
    // Transport errors can contain attacker-controlled text.
    return {kind: 'invalid'};
  } finally {
    clearTimeout(timer);
    if (reader) {
      // An uncooperative cancellation must not extend the upload deadline.
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
};
