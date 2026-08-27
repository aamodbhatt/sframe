const BASE64URL_RE = /^[A-Za-z0-9_-]+$/u;

export const ROOM_ID_RE = /^[A-Za-z0-9_-]{22}$/u;
export const CAPABILITY_RE = /^[A-Za-z0-9_-]{43}$/u;

const encodeBinary = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const encodeBase64Url = (bytes: Uint8Array): string => encodeBinary(bytes)
  .replaceAll('+', '-')
  .replaceAll('/', '_')
  .replace(/=+$/u, '');

export const decodeBase64Url = (value: string, maximumBytes: number): Uint8Array | null => {
  if (value.length === 0 || value.length > Math.ceil(maximumBytes * 4 / 3) || !BASE64URL_RE.test(value)) return null;
  const remainder = value.length % 4;
  if (remainder === 1) return null;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - remainder) % 4);
  try {
    const binary = atob(padded);
    if (binary.length > maximumBytes) return null;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
};

export const decodeFixed32 = (value: string): Uint8Array | null => {
  if (!CAPABILITY_RE.test(value)) return null;
  const bytes = decodeBase64Url(value, 32);
  return bytes?.byteLength === 32 ? bytes : null;
};

export const exactArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(
  bytes.byteOffset,
  bytes.byteOffset + bytes.byteLength,
) as ArrayBuffer;

export const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> => new Uint8Array(
  await crypto.subtle.digest('SHA-256', exactArrayBuffer(bytes)),
);

export const constantTimeEqual32 = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.byteLength ^ right.byteLength;
  for (let index = 0; index < 32; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
};

export const random32 = (): Uint8Array => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
};
