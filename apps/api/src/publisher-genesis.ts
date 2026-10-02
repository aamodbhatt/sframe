import {verifyAsync} from '@noble/ed25519';
import canonicalize from 'canonicalize';
import {computeWriteMessage, type WireEnvelope} from '../../../packages/protocol/src/index.js';
import {strictEd25519Points} from '../../../packages/protocol/src/ed25519-points.js';
import {decodeBase64Url, decodeFixed32, encodeBase64Url} from './do-crypto.js';

const exactKeys = (value: unknown, fields: string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...fields].sort().join();
const validShape = (value: unknown): value is WireEnvelope => {
  if (!exactKeys(value, ['version', 'stateEpoch', 'revision', 'envelopeSalt', 'previousEnvelopeDigest',
    'ciphertext', 'writerPublicKey', 'writerSignature', 'aad'])) return false;
  return value.version === 1 && value.stateEpoch === 0 && value.revision === 1
    && ['envelopeSalt', 'previousEnvelopeDigest', 'ciphertext', 'writerPublicKey', 'writerSignature'].every((field) => typeof value[field] === 'string')
    && exactKeys(value.aad, ['protocolVersion', 'appId', 'roomId', 'packageDigest', 'stateEpoch', 'proposedRevision', 'previousEnvelopeDigest']);
};
const contextMatches = (envelope: WireEnvelope, roomId: string, digest: string, writer: string): boolean => {
  const aad = envelope.aad; const zero = encodeBase64Url(new Uint8Array(32));
  return envelope.writerPublicKey === writer && envelope.previousEnvelopeDigest === zero
    && aad.protocolVersion === 1 && aad.roomId === roomId && aad.packageDigest === digest
    && aad.stateEpoch === 0 && aad.proposedRevision === 1 && aad.previousEnvelopeDigest === zero
    && typeof aad.appId === 'string' && aad.appId.length > 0 && aad.appId.length <= 128;
};

// Validate the signed ciphertext before reserving an operation. Never decrypt
// publisher genesis or infer Automerge correctness at the server boundary.
export const validSignedGenesis = async (value: unknown, roomId: string, digest: string, writer: string): Promise<boolean> => {
  try {
    if (!validShape(value) || !contextMatches(value, roomId, digest, writer)) return false;
    const publicKey = decodeFixed32(value.writerPublicKey); const signature = decodeBase64Url(value.writerSignature, 64);
    const ciphertext = decodeBase64Url(value.ciphertext, 524_288); const salt = decodeBase64Url(value.envelopeSalt, 16);
    const rawRoomId = decodeBase64Url(roomId, 16); const rawDigest = decodeFixed32(digest);
    if (!publicKey || !signature || signature.byteLength !== 64 || !ciphertext || ciphertext.byteLength < 16
      || !salt || salt.byteLength !== 16 || !rawRoomId || rawRoomId.byteLength !== 16 || !rawDigest) return false;
    if (!strictEd25519Points(signature, publicKey)) return false;
    const message = await computeWriteMessage(rawRoomId, rawDigest, 0, 1, new Uint8Array(32), salt,
      new TextEncoder().encode(canonicalize(value.aad)!), ciphertext);
    return await verifyAsync(signature, message, publicKey);
  } catch { return false; }
};
