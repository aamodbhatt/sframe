import {getPublicKeyAsync, signAsync, verifyAsync} from '@noble/ed25519';
import canonicalize from 'canonicalize';
import {encodeBase64Url, decodeBase64Url, sha256} from './crypto-envelope.js';

export const POISONED_HEAD_PAYLOAD_TYPE = 'application/vnd.smallframe.poisoned-head-repair.v1+json';
export const RECOVERY_TRANSITION_PAYLOAD_TYPE = 'application/vnd.smallframe.recovery-transition.v1+json';

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
  priorEpoch: number;
  newEpoch: number;
  candidateEnvelopeDigest: string;
  highestObservedRevision: number;
  priorTransitionDigest: string;
  newEnvelopeDigest: string;
  reason: 'POISONED_HEAD_RECOVERY' | 'DISASTER_RESTORE' | 'OPERATOR_RESET';
  discardedRevisions: boolean;
  createdAt: number;
};

export type SignedRecoveryTransition = {
  record: RecoveryTransitionRecord;
  signature: string;
};

import {dssePae} from './room-descriptor.js';

export const signPoisonedHeadRepair = async (
  record: PoisonedHeadRepairRecord,
  publisherPrivateKey: Uint8Array
): Promise<SignedPoisonedHeadRepair> => {
  const canonical = new TextEncoder().encode(canonicalize(record)!);
  const pae = dssePae(POISONED_HEAD_PAYLOAD_TYPE, canonical);
  const sig = await signAsync(pae, publisherPrivateKey);
  return {
    record,
    signature: encodeBase64Url(sig)
  };
};

export const verifyPoisonedHeadRepair = async (
  signed: SignedPoisonedHeadRepair,
  publisherPublicKey: Uint8Array
): Promise<boolean> => {
  const canonical = new TextEncoder().encode(canonicalize(signed.record)!);
  const pae = dssePae(POISONED_HEAD_PAYLOAD_TYPE, canonical);
  const sigBytes = decodeBase64Url(signed.signature);
  return verifyAsync(sigBytes, pae, publisherPublicKey);
};

export const signRecoveryTransition = async (
  record: RecoveryTransitionRecord,
  writerPrivateKey: Uint8Array
): Promise<SignedRecoveryTransition> => {
  const canonical = new TextEncoder().encode(canonicalize(record)!);
  const pae = dssePae(RECOVERY_TRANSITION_PAYLOAD_TYPE, canonical);
  const sig = await signAsync(pae, writerPrivateKey);
  return {
    record,
    signature: encodeBase64Url(sig)
  };
};

export const verifyRecoveryTransition = async (
  signed: SignedRecoveryTransition,
  writerPublicKey: Uint8Array
): Promise<boolean> => {
  const canonical = new TextEncoder().encode(canonicalize(signed.record)!);
  const pae = dssePae(RECOVERY_TRANSITION_PAYLOAD_TYPE, canonical);
  const sigBytes = decodeBase64Url(signed.signature);
  return verifyAsync(sigBytes, pae, writerPublicKey);
};
