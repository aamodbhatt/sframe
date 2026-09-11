import {computeEtag, decodeBase64Url, encodeBase64Url} from '../../../packages/protocol/src/crypto-envelope.js';

const boundedInteger = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

const canonicalBytes = (value: unknown, maximumBytes: number): Uint8Array => {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maximumBytes * 4 / 3)) throw new Error();
  const bytes = decodeBase64Url(value);
  if (bytes.byteLength > maximumBytes || encodeBase64Url(bytes) !== value) throw new Error();
  return bytes;
};

// Document/schema validation still runs separately inside the state Worker.
export const validateReplicaMetadata = (value: unknown): void => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const room = value as Record<string, unknown>;
    if (!boundedInteger(room.stateEpoch, 0, 16) || !boundedInteger(room.revision, 1, Number.MAX_SAFE_INTEGER)) throw new Error();
    const digest = canonicalBytes(room.envelopeDigest, 32);
    if (digest.byteLength !== 32 || room.etag !== computeEtag(room.stateEpoch, room.revision, digest)) throw new Error();
    if (typeof room.actorId !== 'string' || !/^[0-9a-f]{32}$/u.test(room.actorId)) throw new Error();
    if (typeof room.dirty !== 'boolean' || !boundedInteger(room.updatedAt, 0, Number.MAX_SAFE_INTEGER)) throw new Error();
    canonicalBytes(room.automergeBase64, 475_136);
  } catch {
    throw new Error('LOCAL_STATE_INVALID');
  }
};

export const verifiedRelayEtag = (received: string | null, verified: string): string => {
  if (received !== null && received !== verified) throw new Error('REMOTE_STATE_INVALID');
  return verified;
};
