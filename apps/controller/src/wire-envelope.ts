import {STATE_CIPHERTEXT_LIMIT, type WireEnvelope} from '../../../packages/protocol/src/crypto-envelope.js';

const exactRecord = (value: unknown, fields: string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
const integer = (value: unknown, minimum: number, maximum: number): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const canonicalBinary = (value: unknown, minimum: number, maximum = minimum): boolean => {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3) || /[^A-Za-z0-9_-]/u.test(value)) return false;
  const remainder = value.length % 4;
  const bytes = Math.floor(value.length * 3 / 4);
  if (remainder === 1 || bytes < minimum || bytes > maximum) return false;
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(value.at(-1)!);
  return (remainder !== 2 || (last & 15) === 0) && (remainder !== 3 || (last & 3) === 0);
};

export const validateWireEnvelope = (value: unknown): WireEnvelope => {
  if (!exactRecord(value, ['version', 'stateEpoch', 'revision', 'envelopeSalt',
    'previousEnvelopeDigest', 'ciphertext', 'writerPublicKey', 'writerSignature', 'aad'])) throw new Error('REMOTE_STATE_INVALID');
  const aad = value.aad;
  if (!exactRecord(aad, ['protocolVersion', 'appId', 'roomId', 'packageDigest',
    'stateEpoch', 'proposedRevision', 'previousEnvelopeDigest'])) throw new Error('REMOTE_STATE_INVALID');
  validateContext(value, aad);
  validateBinary(value, aad);
  return value as unknown as WireEnvelope;
};

const validateContext = (value: Record<string, unknown>, aad: Record<string, unknown>): void => {
  if (value.version !== 1 || aad.protocolVersion !== 1 || !integer(value.stateEpoch, 0, 16)
    || !integer(value.revision, 1, Number.MAX_SAFE_INTEGER)
    || value.stateEpoch !== aad.stateEpoch || value.revision !== aad.proposedRevision
    || value.previousEnvelopeDigest !== aad.previousEnvelopeDigest
    || typeof aad.appId !== 'string' || aad.appId.length < 3 || aad.appId.length > 128) throw new Error('REMOTE_STATE_INVALID');
};
const validateBinary = (value: Record<string, unknown>, aad: Record<string, unknown>): void => {
  if (!canonicalBinary(value.envelopeSalt, 16) || !canonicalBinary(value.previousEnvelopeDigest, 32)
    || !canonicalBinary(value.writerPublicKey, 32) || !canonicalBinary(value.writerSignature, 64)
    || !canonicalBinary(value.ciphertext, 16, STATE_CIPHERTEXT_LIMIT)
    || !canonicalBinary(aad.roomId, 16) || !canonicalBinary(aad.packageDigest, 32)) throw new Error('REMOTE_STATE_INVALID');
};
