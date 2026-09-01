import canonicalize from 'canonicalize';
import {getPublicKeyAsync, signAsync, verifyAsync} from '@noble/ed25519';
import {encodeBase64Url, decodeBase64Url} from './crypto-envelope.js';
import {dssePae} from './room-descriptor.js';

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

export const verifyPublisherEnrollment = async (
  jcsBytes: Uint8Array,
  signature: Uint8Array,
  options?: {now?: number; maxClockSkewMs?: number}
): Promise<PublisherEnrollmentRecord> => {
  const jsonText = new TextDecoder('utf-8', {fatal: true}).decode(jcsBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('ENROLLMENT_JSON_INVALID');
  }

  if (typeof parsed !== 'object' || parsed === null) throw new Error('ENROLLMENT_RECORD_INVALID');
  const rec = parsed as Record<string, unknown>;

  if (rec.protocolVersion !== 1) throw new Error('ENROLLMENT_VERSION_INVALID');
  if (typeof rec.publisherPublicKey !== 'string') throw new Error('ENROLLMENT_PUBLIC_KEY_INVALID');
  if (typeof rec.publisherKeyId !== 'string') throw new Error('ENROLLMENT_KEY_ID_INVALID');
  if (typeof rec.tokenHash !== 'string') throw new Error('ENROLLMENT_TOKEN_HASH_INVALID');
  if (typeof rec.operationId !== 'string') throw new Error('ENROLLMENT_OPERATION_ID_INVALID');
  if (typeof rec.inviteCodeHash !== 'string') throw new Error('ENROLLMENT_INVITE_HASH_INVALID');
  if (typeof rec.createdAt !== 'number' || !Number.isSafeInteger(rec.createdAt)) throw new Error('ENROLLMENT_CREATED_AT_INVALID');

  const pubKeyBytes = decodeBase64Url(rec.publisherPublicKey);
  if (pubKeyBytes.byteLength !== 32) throw new Error('ENROLLMENT_PUBLIC_KEY_BYTES_INVALID');

  const digest = await crypto.subtle.digest('SHA-256', pubKeyBytes);
  const expectedKeyId = `sha256:${encodeBase64Url(new Uint8Array(digest))}`;
  if (rec.publisherKeyId !== expectedKeyId) throw new Error('ENROLLMENT_KEY_ID_MISMATCH');

  // Verify signature
  const pae = dssePae(ENROLLMENT_PAYLOAD_TYPE, jcsBytes);
  const valid = await verifyAsync(signature, pae, pubKeyBytes);
  if (!valid) throw new Error('ENROLLMENT_SIGNATURE_INVALID');

  // Verify clock freshness
  if (options?.now !== undefined) {
    const skew = options.maxClockSkewMs ?? 5 * 60 * 1000;
    if (Math.abs(options.now - rec.createdAt) > skew) {
      throw new Error('ENROLLMENT_TIMESTAMP_EXPIRED');
    }
  }

  return rec as PublisherEnrollmentRecord;
};
