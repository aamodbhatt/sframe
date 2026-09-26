import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import canonicalize from 'canonicalize';
import {getPublicKeyAsync, signAsync, verifyAsync} from '@noble/ed25519';
import {describe, expect, it} from 'vitest';
import {decodeBase64Url, encodeBase64Url, sha256} from '../packages/protocol/src/crypto-envelope.js';
import {dssePae} from '../packages/protocol/src/room-descriptor.js';
import {MAX_REPAIR_RECORD_BYTES, POISONED_HEAD_PAYLOAD_TYPE, parsePoisonedHeadRepairRecord,
  signPoisonedHeadRepair, verifyPoisonedHeadRepair, type PoisonedHeadRepairRecord,
  MAX_RECOVERY_TRANSITION_BYTES, RECOVERY_TRANSITION_PAYLOAD_TYPE, parseRecoveryTransitionRecord,
  signRecoveryTransition, verifyRecoveryTransition, type RecoveryTransitionRecord} from '../packages/protocol/src/recovery.js';

const vector = JSON.parse(readFileSync(new URL('../packages/protocol/vectors/poisoned-head-repair-v1.json', import.meta.url), 'utf8')) as {
  record: PoisonedHeadRepairRecord; jcsBase64Url: string; paeSha256: string; publisherPublicKey: string; signature: string;
};
const bytes = (record: unknown): Uint8Array => new TextEncoder().encode(canonicalize(record)!);
const mutateEncoding = (value: string): string => {
  const decoded = decodeBase64Url(value);
  decoded[0] = decoded[0]! ^ 1;
  return encodeBase64Url(decoded);
};

describe('bounded exact-head publisher repair records', () => {
  it('matches the public native/TS JCS and DSSE verification vector and rejects mutation of every field', async () => {
    const canonical = decodeBase64Url(vector.jcsBase64Url);
    const publicKey = decodeBase64Url(vector.publisherPublicKey);
    expect(parsePoisonedHeadRepairRecord(canonical)).toEqual(vector.record);
    expect(encodeBase64Url(await sha256(dssePae(POISONED_HEAD_PAYLOAD_TYPE, canonical)))).toBe(vector.paeSha256);
    expect(await verifyPoisonedHeadRepair({record: vector.record, signature: vector.signature}, publicKey)).toBe(true);
    for (const [field, value] of Object.entries(vector.record)) {
      const changed = typeof value === 'number' ? value + 1
        : field === 'reason' ? 'OTHER' : field === 'publisherKeyId' ? `sha256:${mutateEncoding(value.slice(7))}` : mutateEncoding(value);
      expect(await verifyPoisonedHeadRepair({record: {...vector.record, [field]: changed}, signature: vector.signature}, publicKey)).toBe(false);
    }
    for (let index = 0; index < 64; index += 1) {
      const signature = decodeBase64Url(vector.signature);
      signature[index] = signature[index]! ^ 1;
      expect(await verifyPoisonedHeadRepair({record: vector.record, signature: encodeBase64Url(signature)}, publicKey)).toBe(false);
    }
    expect(await verifyPoisonedHeadRepair({record: vector.record, signature: vector.signature + '='}, publicKey)).toBe(false);
    expect(await verifyPoisonedHeadRepair({record: vector.record, signature: vector.signature, payloadType: 'other'}, publicKey)).toBe(false);
  });

  it('rejects duplicate, noncanonical, oversized and unsafe records before verification', () => {
    const canonical = new TextDecoder().decode(decodeBase64Url(vector.jcsBase64Url));
    for (const input of ['{"protocolVersion":1,' + canonical.slice(1), '{"\\u0070rotocolVersion":1,' + canonical.slice(1),
      ' ' + canonical, canonical.replace('"expectedStateEpoch":0', '"expectedStateEpoch":-0')]) {
      expect(() => parsePoisonedHeadRepairRecord(new TextEncoder().encode(input))).toThrow('REPAIR_RECORD_INVALID');
    }
    expect(() => parsePoisonedHeadRepairRecord(new Uint8Array(MAX_REPAIR_RECORD_BYTES + 1))).toThrow('REPAIR_RECORD_INVALID');
    expect(() => parsePoisonedHeadRepairRecord(Uint8Array.of(123, 255, 125))).toThrow('REPAIR_RECORD_INVALID');
    for (const changes of [{expectedStateEpoch: 17}, {expectedRevision: 0}, {expectedRevision: Number.MAX_SAFE_INTEGER + 1},
      {createdAt: -1}, {createdAt: Number.MAX_SAFE_INTEGER + 1}, {reason: 'OTHER'}, {operationId: vector.record.operationId + '='},
      {viewerDescriptorDigest: vector.record.viewerDescriptorDigest.slice(1)}, {unknown: true}]) {
      expect(() => parsePoisonedHeadRepairRecord(bytes({...vector.record, ...changes}))).toThrow('REPAIR_RECORD_INVALID');
    }
    expect(parsePoisonedHeadRepairRecord(bytes({...vector.record, expectedStateEpoch: 16,
      expectedRevision: Number.MAX_SAFE_INTEGER, createdAt: Number.MAX_SAFE_INTEGER})).expectedStateEpoch).toBe(16);
  });

  it('refuses malformed records even with a real signature and binds the signing key ID', async () => {
    const seed = new Uint8Array(randomBytes(32));
    const publicKey = await getPublicKeyAsync(seed);
    const record = {...vector.record, publisherKeyId: `sha256:${encodeBase64Url(await sha256(publicKey))}`};
    const signed = await signPoisonedHeadRepair(record, seed);
    expect(await verifyPoisonedHeadRepair(signed, publicKey)).toBe(true);
    const malformed = {...record, extra: true};
    const realSignature = encodeBase64Url(await signAsync(dssePae(POISONED_HEAD_PAYLOAD_TYPE, bytes(malformed)), seed));
    expect(await verifyPoisonedHeadRepair({record: malformed, signature: realSignature}, publicKey)).toBe(false);
    await expect(signPoisonedHeadRepair(malformed, seed)).rejects.toThrow('REPAIR_RECORD_INVALID');
    await expect(signPoisonedHeadRepair(vector.record, seed)).rejects.toThrow('REPAIR_PUBLISHER_MISMATCH');
    const wrongPayload = encodeBase64Url(await signAsync(dssePae('application/other', bytes(record)), seed));
    expect(await verifyPoisonedHeadRepair({record, signature: wrongPayload}, publicKey)).toBe(false);
    const pending = signPoisonedHeadRepair(record, seed);
    record.expectedRevision += 1;
    const immutable = await pending;
    expect(immutable.record.expectedRevision).toBe(vector.record.expectedRevision);
    expect(await verifyPoisonedHeadRepair(immutable, publicKey)).toBe(true);
    seed.fill(0);
  });
});

describe('ADR-0011 bounded recovery transition records', () => {
  const transitionVector = JSON.parse(readFileSync(new URL('../packages/protocol/vectors/recovery-transition-v1.json', import.meta.url), 'utf8')) as {
    record: RecoveryTransitionRecord; jcsBase64Url: string; paeSha256: string; writerPublicKey: string; signature: string;
  };
  const zero = encodeBase64Url(new Uint8Array(32));

  it('matches the shared native JCS/DSSE vector and rejects every field and signature mutation', async () => {
    const canonical = decodeBase64Url(transitionVector.jcsBase64Url);
    const publicKey = decodeBase64Url(transitionVector.writerPublicKey);
    expect(parseRecoveryTransitionRecord(canonical)).toEqual(transitionVector.record);
    expect(encodeBase64Url(await sha256(dssePae(RECOVERY_TRANSITION_PAYLOAD_TYPE, canonical)))).toBe(transitionVector.paeSha256);
    expect(await verifyRecoveryTransition({record: transitionVector.record, signature: transitionVector.signature}, publicKey)).toBe(true);
    for (const [field, value] of Object.entries(transitionVector.record)) {
      const changed = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value
        : field === 'reason' ? 'POISONED_HEAD' : mutateEncoding(value);
      expect(await verifyRecoveryTransition({record: {...transitionVector.record, [field]: changed}, signature: transitionVector.signature}, publicKey)).toBe(false);
    }
    for (let index = 0; index < 64; index += 1) {
      const signature = decodeBase64Url(transitionVector.signature);
      signature[index] = signature[index]! ^ 1;
      expect(await verifyRecoveryTransition({record: transitionVector.record, signature: encodeBase64Url(signature)}, publicKey)).toBe(false);
    }
    expect(await verifyRecoveryTransition({record: transitionVector.record, signature: transitionVector.signature + '='}, publicKey)).toBe(false);
    expect(await verifyRecoveryTransition({record: transitionVector.record, signature: transitionVector.signature, extra: true}, publicKey)).toBe(false);
    expect(await verifyRecoveryTransition(null, publicKey)).toBe(false);
    expect(await verifyRecoveryTransition({record: transitionVector.record, signature: transitionVector.signature}, new Uint8Array(32))).toBe(false);
  });

  it('rejects schema drift, duplicate/noncanonical JCS, invalid epoch relations and zero predecessor misuse', () => {
    const canonical = new TextDecoder().decode(decodeBase64Url(transitionVector.jcsBase64Url));
    for (const input of ['{"newStateEpoch":1,' + canonical.slice(1), '{"\\u006eewStateEpoch":1,' + canonical.slice(1),
      ' ' + canonical, canonical.replace('"candidateStateEpoch":0', '"candidateStateEpoch":-0')]) {
      expect(() => parseRecoveryTransitionRecord(new TextEncoder().encode(input))).toThrow('RECOVERY_TRANSITION_INVALID');
    }
    expect(() => parseRecoveryTransitionRecord(new Uint8Array(MAX_RECOVERY_TRANSITION_BYTES + 1))).toThrow('RECOVERY_TRANSITION_INVALID');
    expect(() => parseRecoveryTransitionRecord(Uint8Array.of(123, 255, 125))).toThrow('RECOVERY_TRANSITION_INVALID');
    for (const change of [{priorEpoch: 0}, {reason: 'DISASTER_RESTORE'}, {discardedKnownRevisions: 1},
      {newStateEpoch: 2}, {newStateEpoch: 0}, {candidateStateEpoch: 16, newStateEpoch: 17}, {highestObservedStateEpoch: 17},
      {candidateRevision: 0}, {highestObservedRevision: Number.MAX_SAFE_INTEGER + 1}, {createdAt: -1},
      {createdAt: Number.MAX_SAFE_INTEGER + 1}, {writerPublicKey: transitionVector.writerPublicKey + '='},
      {priorTransitionDigest: transitionVector.record.packageDigest}, {candidateStateEpoch: 1, newStateEpoch: 2}]) {
      expect(() => parseRecoveryTransitionRecord(bytes({...transitionVector.record, ...change}))).toThrow('RECOVERY_TRANSITION_INVALID');
    }
    for (const epochs of [{candidateStateEpoch: 15, highestObservedStateEpoch: 0}, {candidateStateEpoch: 0, highestObservedStateEpoch: 15}]) {
      const record = {...transitionVector.record, ...epochs, newStateEpoch: 16, priorTransitionDigest: transitionVector.record.packageDigest,
        candidateRevision: Number.MAX_SAFE_INTEGER, highestObservedRevision: Number.MAX_SAFE_INTEGER, createdAt: Number.MAX_SAFE_INTEGER};
      expect(parseRecoveryTransitionRecord(bytes(record)).newStateEpoch).toBe(16);
      expect(() => parseRecoveryTransitionRecord(bytes({...record, priorTransitionDigest: zero}))).toThrow('RECOVERY_TRANSITION_INVALID');
    }
  });

  it('rejects valid signatures over invalid transitions, binds the writer and snapshots signing inputs', async () => {
    const seed = new Uint8Array(randomBytes(32));
    try {
      const publicKey = await getPublicKeyAsync(seed);
      const record = {...transitionVector.record, writerPublicKey: encodeBase64Url(publicKey)};
      expect(await verifyRecoveryTransition(await signRecoveryTransition(record, seed), publicKey)).toBe(true);
      for (const change of [{newStateEpoch: 3}, {unknown: true}, {writerPublicKey: zero}]) {
        const invalid = {...record, ...change};
        const signature = encodeBase64Url(await signAsync(dssePae(RECOVERY_TRANSITION_PAYLOAD_TYPE, bytes(invalid)), seed));
        expect(await verifyRecoveryTransition({record: invalid, signature}, publicKey)).toBe(false);
        await expect(signRecoveryTransition(invalid, seed)).rejects.toThrow();
      }
      const wrongPayload = encodeBase64Url(await signAsync(dssePae(POISONED_HEAD_PAYLOAD_TYPE, bytes(record)), seed));
      expect(await verifyRecoveryTransition({record, signature: wrongPayload}, publicKey)).toBe(false);
      await expect(signRecoveryTransition(transitionVector.record, seed)).rejects.toThrow('RECOVERY_WRITER_MISMATCH');
      const pending = signRecoveryTransition(record, seed);
      record.highestObservedRevision += 1;
      const signed = await pending;
      expect(signed.record.highestObservedRevision).toBe(transitionVector.record.highestObservedRevision);
      expect(await verifyRecoveryTransition(signed, publicKey)).toBe(true);
    } finally { seed.fill(0); }
  });
});

it('rejects malicious signer point vectors that the JS cofactored verifier accepts', async () => {
  for (const [name, payloadType, verify] of [
    ['poisoned-head-repair-v1', POISONED_HEAD_PAYLOAD_TYPE, verifyPoisonedHeadRepair],
    ['recovery-transition-v1', RECOVERY_TRANSITION_PAYLOAD_TYPE, verifyRecoveryTransition],
  ] as const) {
    const fixture = JSON.parse(readFileSync(new URL(`../packages/protocol/vectors/${name}.json`, import.meta.url), 'utf8')) as {
      rejectedPointVectors: Array<{kind: string; record: unknown; jcsBase64Url: string; publicKey: string; signature: string}>;
    };
    expect(fixture.rejectedPointVectors.map((item) => item.kind)).toEqual(['small-order-R', 'mixed-order-R', 'mixed-order-public-key']);
    for (const item of fixture.rejectedPointVectors) {
      const publicKey = decodeBase64Url(item.publicKey);
      const signature = decodeBase64Url(item.signature);
      const pae = dssePae(payloadType, decodeBase64Url(item.jcsBase64Url));
      expect(await verifyAsync(signature, pae, publicKey, {zip215: false})).toBe(true);
      expect(await verify({record: item.record, signature: item.signature}, publicKey)).toBe(false);
    }
  }
});

it('rejects recovery/repair accessors and inherited serializers without invoking them', async () => {
  let calls = 0;
  for (const [name, verify, sign] of [
    ['poisoned-head-repair-v1', verifyPoisonedHeadRepair, signPoisonedHeadRepair],
    ['recovery-transition-v1', verifyRecoveryTransition, signRecoveryTransition],
  ] as const) {
    const fixture = JSON.parse(readFileSync(new URL(`../packages/protocol/vectors/${name}.json`, import.meta.url), 'utf8')) as {
      record: PoisonedHeadRepairRecord & RecoveryTransitionRecord; signature: string; publisherPublicKey?: string; writerPublicKey?: string;
    };
    const publicKey = decodeBase64Url((fixture.publisherPublicKey ?? fixture.writerPublicKey)!);
    const seed = new Uint8Array(randomBytes(32));
    try {
      const inherited = Object.assign(Object.create({toJSON: () => { calls += 1; throw new Error('sensitive'); }}), fixture.record);
      const accessor = {...fixture.record};
      Object.defineProperty(accessor, 'roomId', {enumerable: true, get: () => { calls += 1; throw new Error('sensitive'); }});
      for (const record of [inherited, accessor, {...fixture.record, [Symbol('unknown')]: true}]) {
        expect(await verify({record, signature: fixture.signature}, publicKey)).toBe(false);
        await expect(sign(record, seed)).rejects.toThrow(/REPAIR_RECORD_INVALID|RECOVERY_TRANSITION_INVALID/u);
      }
      const outer = {record: fixture.record, signature: fixture.signature};
      Object.defineProperty(outer, 'signature', {enumerable: true, get: () => { calls += 1; throw new Error('sensitive'); }});
      expect(await verify(outer, publicKey)).toBe(false);
    } finally { seed.fill(0); }
  }
  expect(calls).toBe(0);
});

it('copies Buffer key inputs before signing or verification can await', async () => {
  const seed = randomBytes(32);
  try {
    const publicKey = await getPublicKeyAsync(new Uint8Array(seed));
    const repairRecord = {...vector.record, publisherKeyId: `sha256:${encodeBase64Url(await sha256(publicKey))}`};
    const transitionVector = JSON.parse(readFileSync(new URL('../packages/protocol/vectors/recovery-transition-v1.json', import.meta.url), 'utf8')) as {
      record: RecoveryTransitionRecord;
    };
    const transitionRecord = {...transitionVector.record, writerPublicKey: encodeBase64Url(publicKey)};
    const repairSeed = Buffer.from(seed);
    const transitionSeed = Buffer.from(seed);
    const repairPending = signPoisonedHeadRepair(repairRecord, repairSeed);
    const transitionPending = signRecoveryTransition(transitionRecord, transitionSeed);
    repairSeed.fill(0);
    transitionSeed.fill(0);
    const [repair, transition] = await Promise.all([repairPending, transitionPending]);
    const repairKey = Buffer.from(publicKey);
    const transitionKey = Buffer.from(publicKey);
    const repairVerification = verifyPoisonedHeadRepair(repair, repairKey);
    const transitionVerification = verifyRecoveryTransition(transition, transitionKey);
    repairKey.fill(0);
    transitionKey.fill(0);
    expect(await repairVerification).toBe(true);
    expect(await transitionVerification).toBe(true);
  } finally { seed.fill(0); }
});
