import {ExtendedPoint} from '@noble/ed25519';
import canonicalize from 'canonicalize';
import {decodeBase64Url, encodeBase64Url} from './crypto-envelope.js';
import {recoveryTransitionDigest, snapshotSignedRecoveryTransition, verifyRecoveryTransition,
  type SignedRecoveryTransition} from './recovery.js';
import {recoveryDataArray, recoveryDataRecord} from './recovery-snapshot.js';

export const MAX_RECOVERY_TRANSITIONS = 16;
export type RecoveryChainContext = {
  roomId: string;
  packageDigest: string;
  writerPublicKey: string;
  stateEpoch: number;
  transitionDigest: string;
  targetStateEpoch: number;
};
export type RecoveryEpochDigest = {stateEpoch: number; transitionDigest: string};
export type VerifiedRecoveryChain = {
  stateEpoch: number;
  transitionDigest: string;
  transitions: readonly Readonly<{record: Readonly<SignedRecoveryTransition['record']>; signature: string}>[];
  transitionDigests: readonly string[];
};
const code = 'RECOVERY_TRANSITION_INVALID';
const invalid = (): never => { throw new Error(code); };
const zero = encodeBase64Url(new Uint8Array(32));
const epoch = (value: unknown): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RECOVERY_TRANSITIONS;
const encoding = (value: unknown, size: number): value is string => {
  if (typeof value !== 'string' || value.length !== Math.ceil(size * 4 / 3)) return false;
  try {
    const bytes = decodeBase64Url(value);
    return bytes.length === size && encodeBase64Url(bytes) === value;
  } catch { return false; }
};
const contextSnapshot = (input: unknown): RecoveryChainContext => {
  const context = recoveryDataRecord(input,
    ['roomId', 'packageDigest', 'writerPublicKey', 'stateEpoch', 'transitionDigest', 'targetStateEpoch'], code);
  if (!encoding(context.roomId, 16) || !['packageDigest', 'writerPublicKey', 'transitionDigest'].every((field) => encoding(context[field], 32))) return invalid();
  if (!epoch(context.stateEpoch) || !epoch(context.targetStateEpoch) || context.targetStateEpoch < context.stateEpoch) return invalid();
  if ((context.transitionDigest === zero) !== (context.stateEpoch === 0)) return invalid();
  const point = ExtendedPoint.fromHex(decodeBase64Url(context.writerPublicKey as string), false);
  if (point.isSmallOrder() || !point.isTorsionFree()) return invalid();
  return context as RecoveryChainContext;
};
const knownSnapshot = (input: unknown, context: RecoveryChainContext): Map<number, string> => {
  const known = new Map<number, string>();
  for (const entry of recoveryDataArray(input, MAX_RECOVERY_TRANSITIONS)) {
    const item = recoveryDataRecord(entry, ['stateEpoch', 'transitionDigest'], code);
    if (!epoch(item.stateEpoch) || item.stateEpoch === 0 || !encoding(item.transitionDigest, 32)
      || item.transitionDigest === zero || known.has(item.stateEpoch)) return invalid();
    known.set(item.stateEpoch, item.transitionDigest);
  }
  if (known.has(context.stateEpoch) && known.get(context.stateEpoch) !== context.transitionDigest) return invalid();
  return known;
};

// Verifies complete signed record lineage through an explicit target, not the
// replacement envelope, current relay head, rollback policy or storage commit.
// All caller-owned inputs are snapshotted before the first cryptographic await.
export const verifyRecoveryTransitionChain = async (
  input: unknown,
  anchor: unknown,
  acceptedEpochDigests: unknown = []
): Promise<VerifiedRecoveryChain> => {
  try {
    const context = contextSnapshot(anchor);
    const known = knownSnapshot(acceptedEpochDigests, context);
    const transitions = recoveryDataArray(input, MAX_RECOVERY_TRANSITIONS).map(snapshotSignedRecoveryTransition);
    if (transitions.length !== context.targetStateEpoch - context.stateEpoch) return invalid();
    const publicKey = decodeBase64Url(context.writerPublicKey);
    let stateEpoch = context.stateEpoch;
    let transitionDigest = context.transitionDigest;
    const transitionDigests: string[] = [];
    for (const signed of transitions) {
      const record = signed.record;
      if (record.roomId !== context.roomId || record.packageDigest !== context.packageDigest || record.writerPublicKey !== context.writerPublicKey
        || record.newStateEpoch !== stateEpoch + 1 || record.priorTransitionDigest !== transitionDigest) return invalid();
      if (!await verifyRecoveryTransition(signed, publicKey)) return invalid();
      const bytes = new TextEncoder().encode(canonicalize(record)!);
      transitionDigest = encodeBase64Url(await recoveryTransitionDigest(bytes));
      if (transitionDigest === zero || (known.has(record.newStateEpoch) && known.get(record.newStateEpoch) !== transitionDigest)) return invalid();
      stateEpoch = record.newStateEpoch;
      transitionDigests.push(transitionDigest);
      Object.freeze(record);
      Object.freeze(signed);
    }
    return Object.freeze({stateEpoch, transitionDigest, transitions: Object.freeze(transitions), transitionDigests: Object.freeze(transitionDigests)});
  } catch { return invalid(); }
};
