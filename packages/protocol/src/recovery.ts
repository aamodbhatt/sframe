import {ExtendedPoint, getPublicKeyAsync, signAsync, verifyAsync} from '@noble/ed25519';
import canonicalize from 'canonicalize';
import {encodeBase64Url, decodeBase64Url, sha256} from './crypto-envelope.js';
import {parseUniqueJson} from './strict-json.js';
import {dssePae} from './room-descriptor.js';

export const POISONED_HEAD_PAYLOAD_TYPE = 'application/vnd.smallframe.poisoned-head-repair.v1+json';
export const RECOVERY_TRANSITION_PAYLOAD_TYPE = 'application/vnd.smallframe.recovery-transition.v1+json';
export const MAX_REPAIR_RECORD_BYTES = 2_048;
export const MAX_RECOVERY_TRANSITION_BYTES = 2_048;

export type PoisonedHeadRepairRecord = {
  protocolVersion: 1;
  roomId: string;
  packageDigest: string;
  publisherKeyId: string;
  expectedStateEpoch: number;
  expectedRevision: number;
  expectedEnvelopeDigest: string;
  viewerDescriptorDigest: string;
  editorDescriptorDigest: string;
  reason: 'POISONED_HEAD';
  operationId: string;
  createdAt: number;
};

export type SignedPoisonedHeadRepair = {
  record: PoisonedHeadRepairRecord;
  signature: string;
};

export type RecoveryTransitionRecord = {
  protocolVersion: 1;
  roomId: string;
  packageDigest: string;
  writerPublicKey: string;
  candidateStateEpoch: number;
  candidateRevision: number;
  candidateEnvelopeDigest: string;
  highestObservedStateEpoch: number;
  highestObservedRevision: number;
  highestObservedEnvelopeDigest: string;
  priorTransitionDigest: string;
  newStateEpoch: number;
  newEnvelopeDigest: string;
  reason: 'OPERATOR_RESTORE' | 'POISONED_HEAD';
  discardedKnownRevisions: boolean;
  createdAt: number;
};

export type SignedRecoveryTransition = {
  record: RecoveryTransitionRecord;
  signature: string;
};

const repairFields = ['protocolVersion', 'roomId', 'packageDigest', 'publisherKeyId', 'expectedStateEpoch',
  'expectedRevision', 'expectedEnvelopeDigest', 'viewerDescriptorDigest', 'editorDescriptorDigest', 'reason', 'operationId', 'createdAt'];
const fixedEncoding = (value: unknown, size: number): boolean => {
  if (typeof value !== 'string' || value.length !== Math.ceil(size * 4 / 3) || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  try {
    const bytes = decodeBase64Url(value);
    return bytes.length === size && encodeBase64Url(bytes) === value;
  } catch { return false; }
};
const boundedInteger = (value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const repairRecordBytes = (value: unknown): Uint8Array => {
  const invalid = (): never => { throw new Error('REPAIR_RECORD_INVALID'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== repairFields.length || !repairFields.every((field) => Object.hasOwn(record, field))) return invalid();
  if (record.protocolVersion !== 1 || record.reason !== 'POISONED_HEAD') return invalid();
  if (!boundedInteger(record.expectedStateEpoch, 0, 16) || !boundedInteger(record.expectedRevision, 1)
    || !boundedInteger(record.createdAt, 0)) return invalid();
  if (!['roomId', 'operationId'].every((field) => fixedEncoding(record[field], 16))
    || !['packageDigest', 'expectedEnvelopeDigest', 'viewerDescriptorDigest', 'editorDescriptorDigest'].every((field) => fixedEncoding(record[field], 32))) return invalid();
  if (typeof record.publisherKeyId !== 'string' || !record.publisherKeyId.startsWith('sha256:')
    || !fixedEncoding(record.publisherKeyId.slice(7), 32)) return invalid();
  const canonical = canonicalize(record);
  if (!canonical) return invalid();
  const bytes = new TextEncoder().encode(canonical);
  if (bytes.byteLength > MAX_REPAIR_RECORD_BYTES) return invalid();
  return bytes;
};

export const parsePoisonedHeadRepairRecord = (bytes: Uint8Array): PoisonedHeadRepairRecord => {
  try {
    if (bytes.byteLength > MAX_REPAIR_RECORD_BYTES) throw new Error();
    const record = parseUniqueJson(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes));
    const canonical = repairRecordBytes(record);
    if (canonical.length !== bytes.length || !canonical.every((byte, index) => byte === bytes[index])) throw new Error();
    return record as PoisonedHeadRepairRecord;
  } catch { throw new Error('REPAIR_RECORD_INVALID'); }
};

// RFC-mode in the JS library still uses a cofactored equation. Require
// canonical, non-small-order subgroup points so both runtimes verify the same
// equation and malicious signer points cannot create a runtime disagreement.
const strictRecoveryPoints = (signature: Uint8Array, publicKey: Uint8Array): boolean => {
  try {
    return [publicKey, signature.slice(0, 32)].every((bytes) => {
      const point = ExtendedPoint.fromHex(bytes, false);
      return !point.isSmallOrder() && point.isTorsionFree();
    });
  } catch { return false; }
};

const repairPublisherMatches = async (record: PoisonedHeadRepairRecord, publicKey: Uint8Array): Promise<boolean> =>
  publicKey.length === 32 && record.publisherKeyId === `sha256:${encodeBase64Url(await sha256(publicKey))}`;

export const signPoisonedHeadRepair = async (
  record: PoisonedHeadRepairRecord,
  publisherPrivateKey: Uint8Array
): Promise<SignedPoisonedHeadRepair> => {
  const canonical = repairRecordBytes(record);
  const snapshot = parsePoisonedHeadRepairRecord(canonical);
  if (publisherPrivateKey.length !== 32) throw new Error('REPAIR_PUBLISHER_MISMATCH');
  const seed = publisherPrivateKey.slice();
  try {
    if (!await repairPublisherMatches(snapshot, await getPublicKeyAsync(seed))) throw new Error('REPAIR_PUBLISHER_MISMATCH');
    const sig = await signAsync(dssePae(POISONED_HEAD_PAYLOAD_TYPE, canonical), seed);
    return {record: snapshot, signature: encodeBase64Url(sig)};
  } finally { seed.fill(0); }
};

export const verifyPoisonedHeadRepair = async (
  signed: unknown,
  publisherPublicKey: Uint8Array
): Promise<boolean> => {
  try {
    if (publisherPublicKey.length !== 32) return false;
    const publicKey = publisherPublicKey.slice();
    if (!signed || typeof signed !== 'object' || Array.isArray(signed)
      || Object.keys(signed).sort().join() !== 'record,signature') return false;
    const {record, signature} = signed as SignedPoisonedHeadRepair;
    const canonical = repairRecordBytes(record);
    if (!fixedEncoding(signature, 64) || !await repairPublisherMatches(parsePoisonedHeadRepairRecord(canonical), publicKey)) return false;
    const sigBytes = decodeBase64Url(signature);
    if (!strictRecoveryPoints(sigBytes, publicKey)) return false;
    const pae = dssePae(POISONED_HEAD_PAYLOAD_TYPE, canonical);
    return await verifyAsync(sigBytes, pae, publicKey, {zip215: false});
  } catch { return false; }
};

const transitionFields = ['protocolVersion', 'roomId', 'packageDigest', 'writerPublicKey', 'candidateStateEpoch',
  'candidateRevision', 'candidateEnvelopeDigest', 'highestObservedStateEpoch', 'highestObservedRevision',
  'highestObservedEnvelopeDigest', 'priorTransitionDigest', 'newStateEpoch', 'newEnvelopeDigest', 'reason',
  'discardedKnownRevisions', 'createdAt'];
const transitionNumbersValid = (record: Record<string, unknown>): boolean => {
  if (!['candidateStateEpoch', 'highestObservedStateEpoch'].every((field) => boundedInteger(record[field], 0, 16))
    || !boundedInteger(record.newStateEpoch, 1, 16)) return false;
  if (!['candidateRevision', 'highestObservedRevision'].every((field) => boundedInteger(record[field], 1))
    || !boundedInteger(record.createdAt, 0)) return false;
  return record.newStateEpoch === Math.max(record.candidateStateEpoch as number, record.highestObservedStateEpoch as number) + 1;
};
const transitionRecordBytes = (value: unknown): Uint8Array => {
  const invalid = (): never => { throw new Error('RECOVERY_TRANSITION_INVALID'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== transitionFields.length || !transitionFields.every((field) => Object.hasOwn(record, field))) return invalid();
  if (record.protocolVersion !== 1 || !['OPERATOR_RESTORE', 'POISONED_HEAD'].includes(record.reason as string)
    || typeof record.discardedKnownRevisions !== 'boolean' || !transitionNumbersValid(record)) return invalid();
  if (!fixedEncoding(record.roomId, 16) || !['packageDigest', 'writerPublicKey', 'candidateEnvelopeDigest',
    'highestObservedEnvelopeDigest', 'priorTransitionDigest', 'newEnvelopeDigest'].every((field) => fixedEncoding(record[field], 32))) return invalid();
  const firstTransition = record.newStateEpoch === 1;
  if ((record.priorTransitionDigest === encodeBase64Url(new Uint8Array(32))) !== firstTransition) return invalid();
  const canonical = canonicalize(record);
  if (!canonical) return invalid();
  const bytes = new TextEncoder().encode(canonical);
  if (bytes.byteLength > MAX_RECOVERY_TRANSITION_BYTES) return invalid();
  return bytes;
};

export const parseRecoveryTransitionRecord = (bytes: Uint8Array): RecoveryTransitionRecord => {
  try {
    if (bytes.byteLength > MAX_RECOVERY_TRANSITION_BYTES) throw new Error();
    const record = parseUniqueJson(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes));
    const canonical = transitionRecordBytes(record);
    if (canonical.length !== bytes.length || !canonical.every((byte, index) => byte === bytes[index])) throw new Error();
    return record as RecoveryTransitionRecord;
  } catch { throw new Error('RECOVERY_TRANSITION_INVALID'); }
};

export const signRecoveryTransition = async (
  record: RecoveryTransitionRecord,
  writerPrivateKey: Uint8Array
): Promise<SignedRecoveryTransition> => {
  const canonical = transitionRecordBytes(record);
  const snapshot = parseRecoveryTransitionRecord(canonical);
  if (writerPrivateKey.length !== 32) throw new Error('RECOVERY_WRITER_MISMATCH');
  const seed = writerPrivateKey.slice();
  try {
    if (snapshot.writerPublicKey !== encodeBase64Url(await getPublicKeyAsync(seed))) throw new Error('RECOVERY_WRITER_MISMATCH');
    const sig = await signAsync(dssePae(RECOVERY_TRANSITION_PAYLOAD_TYPE, canonical), seed);
    return {record: snapshot, signature: encodeBase64Url(sig)};
  } finally { seed.fill(0); }
};

export const verifyRecoveryTransition = async (
  signed: unknown,
  writerPublicKey: Uint8Array
): Promise<boolean> => {
  try {
    if (writerPublicKey.length !== 32) return false;
    const publicKey = writerPublicKey.slice();
    if (!signed || typeof signed !== 'object' || Array.isArray(signed)
      || Object.keys(signed).sort().join() !== 'record,signature') return false;
    const {record, signature} = signed as SignedRecoveryTransition;
    const canonical = transitionRecordBytes(record);
    if (!fixedEncoding(signature, 64) || parseRecoveryTransitionRecord(canonical).writerPublicKey !== encodeBase64Url(publicKey)) return false;
    const sigBytes = decodeBase64Url(signature);
    if (!strictRecoveryPoints(sigBytes, publicKey)) return false;
    return await verifyAsync(sigBytes, dssePae(RECOVERY_TRANSITION_PAYLOAD_TYPE, canonical), publicKey, {zip215: false});
  } catch { return false; }
};
