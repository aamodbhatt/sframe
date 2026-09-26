import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {decodeBase64Url, encodeBase64Url} from '../packages/protocol/src/crypto-envelope.js';
import {recoveryTransitionDigest, snapshotSignedRecoveryTransition, verifyRecoveryTransition,
  type SignedRecoveryTransition} from '../packages/protocol/src/recovery.js';
import {verifyRecoveryTransitionChain, type RecoveryChainContext, type RecoveryEpochDigest} from '../packages/protocol/src/recovery-chain.js';

type Entry = SignedRecoveryTransition & {jcsBase64Url: string; transitionDigest: string};
const vector = JSON.parse(readFileSync(new URL('../packages/protocol/vectors/recovery-chain-v1.json', import.meta.url), 'utf8')) as {
  anchor: RecoveryChainContext; transitions: Entry[]; fork: Entry; rejectedRecords: Array<Entry & {kind: string}>;
};
const signed = (entry: Entry): SignedRecoveryTransition => ({record: entry.record, signature: entry.signature});
const entries = () => vector.transitions.map((entry) => structuredClone(signed(entry)));
const known = (): RecoveryEpochDigest[] => vector.transitions.map((entry) => ({stateEpoch: entry.record.newStateEpoch, transitionDigest: entry.transitionDigest}));
const anchorAt = (stateEpoch: number, targetStateEpoch = 16): RecoveryChainContext => ({...vector.anchor,
  stateEpoch, targetStateEpoch, transitionDigest: stateEpoch === 0 ? vector.anchor.transitionDigest : vector.transitions[stateEpoch - 1]!.transitionDigest});
const rejected = async (input: unknown, anchor: unknown = vector.anchor, accepted: unknown = []): Promise<void> => {
  await expect(verifyRecoveryTransitionChain(input, anchor, accepted)).rejects.toThrow('RECOVERY_TRANSITION_INVALID');
};

describe('bounded signed recovery record lineage', () => {
  it('matches all public native digest vectors and verifies every complete anchored suffix through epoch 16', async () => {
    for (const entry of vector.transitions) {
      expect(encodeBase64Url(await recoveryTransitionDigest(decodeBase64Url(entry.jcsBase64Url)))).toBe(entry.transitionDigest);
    }
    for (let epoch = 0; epoch <= 16; epoch += 1) {
      const result = await verifyRecoveryTransitionChain(entries().slice(epoch), anchorAt(epoch), known());
      expect(result.stateEpoch).toBe(16);
      expect(result.transitionDigest).toBe(vector.transitions[15]!.transitionDigest);
      expect(result.transitionDigests).toEqual(vector.transitions.slice(epoch).map((entry) => entry.transitionDigest));
      expect(result.transitions).toEqual(vector.transitions.slice(epoch).map(signed));
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.transitions)).toBe(true);
      expect(Object.isFrozen(result.transitionDigests)).toBe(true);
      expect(result.transitions.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.record))).toBe(true);
    }
  });

  it('requires an explicit complete target and rejects missing, reordered, duplicated, sparse and oversized chains', async () => {
    for (const input of [[], entries().slice(1), entries().slice(0, 15), entries().filter((_, index) => index !== 5),
      entries().reverse(), [entries()[0], ...entries()], [...entries().slice(0, 2), entries()[1], ...entries().slice(3)]]) await rejected(input);
    await rejected(new Array(16));
    await rejected(entries(), {...vector.anchor, targetStateEpoch: 17});
    await rejected(entries(), {...vector.anchor, targetStateEpoch: 15});
    await rejected([], {...anchorAt(2), targetStateEpoch: 1});
    await rejected(entries(), {...vector.anchor, targetStateEpoch: undefined});
    await rejected([], {...anchorAt(16), targetStateEpoch: 16.5});
    await rejected([], {...anchorAt(16), stateEpoch: Number.MAX_SAFE_INTEGER + 1});
  });

  it('rejects correctly signed context, predecessor and epoch-gap attacks plus altered signatures', async () => {
    for (const entry of vector.rejectedRecords) {
      const from = entry.kind === 'wrong-predecessor' || entry.kind === 'zero-predecessor-after-first' || entry.kind === 'epoch-gap' ? 1 : 0;
      await rejected([signed(entry)], anchorAt(from, from + 1));
    }
    const input = entries();
    input[0]!.signature = encodeBase64Url(new Uint8Array(64));
    await rejected(input);
    await rejected(entries(), {...vector.anchor, roomId: encodeBase64Url(new Uint8Array(16))});
    await rejected(entries(), {...vector.anchor, packageDigest: encodeBase64Url(new Uint8Array(32))});
    await rejected(entries(), {...vector.anchor, extra: true});
    await rejected(entries(), {...vector.anchor, roomId: vector.anchor.roomId + '='});
  });

  it('rejects same-epoch conflicts against accepted digests and never trusts invalid empty anchors', async () => {
    // A genuine writer-signed alternate record is valid alone but conflicts with
    // an already accepted epoch, even when no successor has exposed the fork.
    expect(await verifyRecoveryTransition(signed(vector.fork), decodeBase64Url(vector.anchor.writerPublicKey))).toBe(true);
    expect((await verifyRecoveryTransitionChain([signed(vector.fork)], anchorAt(1, 2))).stateEpoch).toBe(2);
    await rejected([signed(vector.fork)], anchorAt(1, 2), known());
    await rejected([], anchorAt(16), [{stateEpoch: 16, transitionDigest: vector.fork.transitionDigest}]);
    for (const accepted of [[known()[0], known()[0]], [...known(), known()[0]], [{stateEpoch: 0, transitionDigest: vector.anchor.transitionDigest}],
      [{stateEpoch: 17, transitionDigest: vector.fork.transitionDigest}], [{stateEpoch: 1, transitionDigest: vector.anchor.transitionDigest}],
      [{stateEpoch: 1, transitionDigest: vector.fork.transitionDigest, extra: true}]]) await rejected(entries(), vector.anchor, accepted);
    await rejected([], {...anchorAt(16), transitionDigest: vector.anchor.transitionDigest});
    await rejected([], {...anchorAt(0, 0), transitionDigest: vector.fork.transitionDigest});
    const points = JSON.parse(readFileSync(new URL('../packages/protocol/vectors/recovery-transition-v1.json', import.meta.url), 'utf8')) as {
      rejectedPointVectors: Array<{publicKey: string}>;
    };
    await rejected([], {...anchorAt(0, 0), writerPublicKey: points.rejectedPointVectors[2]!.publicKey});
    await rejected([], {...anchorAt(0, 0), writerPublicKey: encodeBase64Url(new Uint8Array(32))});
  });

  it('snapshots all inputs before the first await and returns no mutable caller aliases', async () => {
    const input = entries();
    const anchor = {...vector.anchor};
    const accepted = known();
    const pending = verifyRecoveryTransitionChain(input, anchor, accepted);
    input[15]!.record.roomId = encodeBase64Url(new Uint8Array(16));
    input[15]!.signature = encodeBase64Url(new Uint8Array(64));
    input.splice(0);
    anchor.targetStateEpoch = 0;
    anchor.writerPublicKey = encodeBase64Url(new Uint8Array(32));
    accepted[15]!.transitionDigest = vector.fork.transitionDigest;
    accepted.splice(0);
    const result = await pending;
    expect(result.transitions).toEqual(vector.transitions.map(signed));
    expect(result.stateEpoch).toBe(16);
    expect(result.transitionDigest).toBe(vector.transitions[15]!.transitionDigest);
  });

  it('rejects accessor and custom-prototype input without invoking application code', async () => {
    let calls = 0;
    const malicious = (input: object, field: string): object => {
      const result = {...input};
      Object.defineProperty(result, field, {enumerable: true, get: () => { calls += 1; throw new Error('sensitive application value'); }});
      return result;
    };
    await rejected([malicious(signed(vector.transitions[0]!), 'record')], anchorAt(0, 1));
    await rejected(entries(), malicious(vector.anchor, 'writerPublicKey'));
    await rejected(entries(), vector.anchor, [malicious(known()[0]!, 'transitionDigest')]);
    const array = entries();
    Object.defineProperty(array, '0', {enumerable: true, get: () => { calls += 1; throw new Error('sensitive application value'); }});
    await rejected(array);
    const prototype = {toJSON: () => { calls += 1; throw new Error('sensitive application value'); }};
    const record = Object.assign(Object.create(prototype), vector.transitions[0]!.record);
    expect(() => snapshotSignedRecoveryTransition({record, signature: vector.transitions[0]!.signature})).toThrow('RECOVERY_TRANSITION_INVALID');
    await rejected([{record, signature: vector.transitions[0]!.signature}], anchorAt(0, 1));
    expect(calls).toBe(0);
  });

  it('hashes copied exact canonical bytes and rejects alternate JSON representations or excessive input', async () => {
    const entry = vector.transitions[0]!;
    const bytes = decodeBase64Url(entry.jcsBase64Url);
    const pending = recoveryTransitionDigest(bytes);
    bytes.fill(0);
    expect(encodeBase64Url(await pending)).toBe(entry.transitionDigest);
    // Buffer.slice aliases its input even though Buffer is a Uint8Array.
    const buffer = Buffer.from(decodeBase64Url(entry.jcsBase64Url));
    const pendingBuffer = recoveryTransitionDigest(buffer);
    buffer.fill(0);
    expect(encodeBase64Url(await pendingBuffer)).toBe(entry.transitionDigest);
    for (const invalid of [new TextEncoder().encode(' ' + new TextDecoder().decode(decodeBase64Url(entry.jcsBase64Url))),
      new Uint8Array(2_049), new TextEncoder().encode(JSON.stringify({record: entry.record, signature: entry.signature}))]) {
      await expect(recoveryTransitionDigest(invalid)).rejects.toThrow('RECOVERY_TRANSITION_INVALID');
    }
  });
});
