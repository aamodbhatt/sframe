import canonicalize from 'canonicalize';
import {getPublicKeyAsync, signAsync, verifyAsync} from '@noble/ed25519';
import {encodeBase64Url, decodeBase64Url} from './crypto-envelope.js';
import {dssePae} from './room-descriptor.js';
import {parseUniqueJson} from './strict-json.js';
import {strictEd25519Points} from './ed25519-points.js';

export const ENROLLMENT_PAYLOAD_TYPE = 'application/vnd.smallframe.publisher-enrollment.v1+json';

export type PublisherEnrollmentRecord = {
  protocolVersion: 1;
  publisherPublicKey: string;
  publisherKeyId: string;
  tokenHash: string;
  operationId: string;
  inviteCodeHash: string;
  createdAt: number;
};

export type SignedPublisherEnrollment = {
  record: PublisherEnrollmentRecord;
  jcsBytes: Uint8Array;
  signature: Uint8Array;
};

export const createSignedEnrollment = async (options: {
  publisherPrivateKey: Uint8Array;
  tokenHash: Uint8Array;
  operationId: Uint8Array;
  inviteCodeHash: Uint8Array;
  createdAt?: number;
}): Promise<SignedPublisherEnrollment> => {
  const pubKey = await getPublicKeyAsync(options.publisherPrivateKey);
  const pubKeyBase64Url = encodeBase64Url(pubKey);

  const digest = await crypto.subtle.digest('SHA-256', pubKey);
  const publisherKeyId = `sha256:${encodeBase64Url(new Uint8Array(digest))}`;

  const record: PublisherEnrollmentRecord = {
    protocolVersion: 1,
    publisherPublicKey: pubKeyBase64Url,
    publisherKeyId,
    tokenHash: encodeBase64Url(options.tokenHash),
    operationId: encodeBase64Url(options.operationId),
    inviteCodeHash: encodeBase64Url(options.inviteCodeHash),
    createdAt: options.createdAt ?? Date.now()
  };

  const jcsString = canonicalize(record);
  if (!jcsString) throw new Error('ENROLLMENT_CANONICALIZE_FAILED');
  const jcsBytes = new TextEncoder().encode(jcsString);

  const pae = dssePae(ENROLLMENT_PAYLOAD_TYPE, jcsBytes);
  const signature = await signAsync(pae, options.publisherPrivateKey);

  return {record, jcsBytes, signature};
};

const fixedEnrollmentEncoding = (value: unknown, length: number): boolean => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  try { const bytes = decodeBase64Url(value); return bytes.length === length && encodeBase64Url(bytes) === value; } catch { return false; }
};

const enrollmentFieldsValid = (rec: Record<string, unknown>): boolean =>
  rec.protocolVersion === 1
  && typeof rec.publisherPublicKey === 'string' && typeof rec.publisherKeyId === 'string'
  && typeof rec.tokenHash === 'string' && typeof rec.operationId === 'string'
  && typeof rec.inviteCodeHash === 'string' && typeof rec.createdAt === 'number'
  && Number.isSafeInteger(rec.createdAt)
  && fixedEnrollmentEncoding(rec.publisherPublicKey, 32) && fixedEnrollmentEncoding(rec.tokenHash, 32)
  && fixedEnrollmentEncoding(rec.operationId, 16) && fixedEnrollmentEncoding(rec.inviteCodeHash, 32);

const parseEnrollmentRecord = (jcsBytes: Uint8Array, signature: Uint8Array): PublisherEnrollmentRecord => {
  if (jcsBytes.byteLength > 1_024 || signature.byteLength !== 64) throw new Error('ENROLLMENT_RECORD_INVALID');
  const jsonText = new TextDecoder('utf-8', {fatal: true}).decode(jcsBytes);
  let parsed: unknown;
  try {
    parsed = parseUniqueJson(jsonText);
  } catch {
    throw new Error('ENROLLMENT_JSON_INVALID');
  }

  if (typeof parsed !== 'object' || parsed === null) throw new Error('ENROLLMENT_RECORD_INVALID');
  const rec = parsed as Record<string, unknown>;
  const fields = ['protocolVersion', 'publisherPublicKey', 'publisherKeyId', 'tokenHash', 'operationId', 'inviteCodeHash', 'createdAt'];
  if (Object.keys(rec).length !== fields.length || !fields.every((field) => Object.hasOwn(rec, field))
    || canonicalize(rec) !== jsonText) throw new Error('ENROLLMENT_RECORD_INVALID');

  if (!enrollmentFieldsValid(rec)) throw new Error('ENROLLMENT_RECORD_INVALID');

  return rec as PublisherEnrollmentRecord;
};

export const verifyPublisherEnrollment = async (
  jcsBytes: Uint8Array,
  signature: Uint8Array,
  options?: {now?: number; maxClockSkewMs?: number}
): Promise<PublisherEnrollmentRecord> => {
  const rec = parseEnrollmentRecord(jcsBytes, signature);
  const pubKeyBytes = decodeBase64Url(rec.publisherPublicKey);

  const digest = await crypto.subtle.digest('SHA-256', pubKeyBytes);
  const expectedKeyId = `sha256:${encodeBase64Url(new Uint8Array(digest))}`;
  if (rec.publisherKeyId !== expectedKeyId) throw new Error('ENROLLMENT_KEY_ID_MISMATCH');

  // Verify signature
  const pae = dssePae(ENROLLMENT_PAYLOAD_TYPE, jcsBytes);
  const valid = strictEd25519Points(signature, pubKeyBytes)
    && await verifyAsync(signature, pae, pubKeyBytes, {zip215: false});
  if (!valid) throw new Error('ENROLLMENT_SIGNATURE_INVALID');

  // Verify clock freshness
  if (options?.now !== undefined) {
    const skew = options.maxClockSkewMs ?? 5 * 60 * 1000;
    if (Math.abs(options.now - rec.createdAt) > skew) {
      throw new Error('ENROLLMENT_TIMESTAMP_EXPIRED');
    }
  }

  return rec;
};
