import {describe, expect, it, vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import {readPersonalImport} from './personal-import.js';

describe('personal import input boundary', () => {
  it('rejects oversized files before reading their contents', async () => {
    const file = new Blob([' '.repeat(33)]);
    const read = vi.spyOn(file, 'arrayBuffer');
    await expect(readPersonalImport(file, 32)).rejects.toThrow('STATE_TOO_LARGE');
    expect(read).not.toHaveBeenCalled();
  });
  it('accepts a JSON object exactly at the byte limit', async () => {
    await expect(readPersonalImport(new Blob(['{}']), 2)).resolves.toEqual({});
  });
  it.each(['null', '[]', '0', 'true', '"text"'])('rejects non-object JSON', async (body) => {
    await expect(readPersonalImport(new Blob([body]), 32)).rejects.toThrow('STATE_INVALID');
  });
  it('rejects invalid UTF-8 even inside an otherwise valid JSON string', async () => {
    const bytes = Uint8Array.of(123, 34, 120, 34, 58, 34, 0xff, 34, 125);
    await expect(readPersonalImport(new Blob([bytes]), 32)).rejects.toThrow('STATE_INVALID');
  });
  it('discards parser and file-read diagnostic text', async () => {
    const canary = randomBytes(32).toString('hex');
    const unreadable = new Blob(['{}']);
    vi.spyOn(unreadable, 'arrayBuffer').mockRejectedValue(new Error(canary));
    for (const file of [new Blob([canary]), unreadable]) {
      let caught: unknown;
      try { await readPersonalImport(file, 128); } catch (error) { caught = error; }
      const error = caught as Error;
      expect(error.message === 'STATE_INVALID').toBe(true);
      expect(error.cause === undefined).toBe(true);
      expect(String(error.stack).includes(canary)).toBe(false);
    }
  });
});
