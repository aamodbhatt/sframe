import {computeEtag, decodeBase64Url, encodeBase64Url} from '../../../packages/protocol/src/crypto-envelope.js';

const boundedInteger = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

const canonicalBytes = (value: unknown, maximumBytes: number): Uint8Array => {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maximumBytes * 4 / 3)) throw new Error();
  const bytes = decodeBase64Url(value);
  if (bytes.byteLength > maximumBytes || encodeBase64Url(bytes) !== value) throw new Error();
  return bytes;
};

const validateActorMetadata = (room: Record<string, unknown>): void => {
  if ((room.actorSequence === undefined) !== (room.automergeHeads === undefined)) throw new Error();
  if (room.actorSequence === undefined) return;
  if (!boundedInteger(room.actorSequence, 0, 10_000) || !Array.isArray(room.automergeHeads)
    || room.automergeHeads.length > 128) throw new Error();
  let previous = '';
  for (const head of room.automergeHeads) {
    if (typeof head !== 'string' || !/^[0-9a-f]{64}$/u.test(head) || head <= previous) throw new Error();
    previous = head;
  }
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
    validateActorMetadata(room);
    if (typeof room.dirty !== 'boolean' || !boundedInteger(room.updatedAt, 0, Number.MAX_SAFE_INTEGER)) throw new Error();
    canonicalBytes(room.automergeBase64, 475_136);
    validateLineage(room.lineage, room.stateEpoch as number, room.revision as number, room.envelopeDigest as string);
  } catch {
    throw new Error('LOCAL_STATE_INVALID');
  }
};

export type LineageTuple = {stateEpoch: number; revision: number; envelopeDigest: string};
export type LineageEdge = {from: LineageTuple; to: LineageTuple};
export type ReplicaLineage = {version: 1; gaps: LineageEdge[]; lastVerifiedEdge: LineageEdge | null; unknownPriorHistory: boolean};
export const MAX_RECORDED_GAPS = 16;

const validTuple = (value: unknown): value is LineageTuple => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tuple = value as Record<string, unknown>;
  try {
    return Object.keys(tuple).sort().join(',') === 'envelopeDigest,revision,stateEpoch'
      && boundedInteger(tuple.stateEpoch, 0, 16)
      && boundedInteger(tuple.revision, 1, Number.MAX_SAFE_INTEGER)
      && canonicalBytes(tuple.envelopeDigest, 32).byteLength === 32;
  } catch { return false; }
};

const validEdge = (value: unknown, minimumDistance: number, head: LineageTuple): value is LineageEdge => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const edge = value as Record<string, unknown>;
  return Object.keys(edge).sort().join(',') === 'from,to' && validTuple(edge.from) && validTuple(edge.to)
    && edge.from.stateEpoch === edge.to.stateEpoch
    && edge.to.revision - edge.from.revision >= minimumDistance
    && edge.to.stateEpoch === head.stateEpoch && edge.to.revision <= head.revision;
};

const validateGaps = (gaps: unknown[], head: LineageTuple): void => {
  let priorRevision = 0;
  for (const gap of gaps) {
    if (!validEdge(gap, 2, head) || gap.from.revision < priorRevision) throw new Error('LOCAL_STATE_INVALID');
    priorRevision = gap.to.revision;
    if (gap.to.revision === head.revision && gap.to.envelopeDigest !== head.envelopeDigest) throw new Error('LOCAL_STATE_INVALID');
  }
};

export const validateLineage = (value: unknown, stateEpoch: number, revision: number, envelopeDigest: string): void => {
  if (value === undefined) return; // Older wrapped records acquire an explicit unknown-history marker on load.
  const head = {stateEpoch, revision, envelopeDigest};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LOCAL_STATE_INVALID');
  const lineage = value as Record<string, unknown>;
  if (Object.keys(lineage).sort().join(',') !== 'gaps,lastVerifiedEdge,unknownPriorHistory,version'
    || lineage.version !== 1 || typeof lineage.unknownPriorHistory !== 'boolean'
    || !Array.isArray(lineage.gaps) || lineage.gaps.length > MAX_RECORDED_GAPS) throw new Error('LOCAL_STATE_INVALID');
  validateGaps(lineage.gaps, head);
  if (lineage.lastVerifiedEdge !== null && !validEdge(lineage.lastVerifiedEdge, 1, head)) throw new Error('LOCAL_STATE_INVALID');
  if (lineage.lastVerifiedEdge && (lineage.lastVerifiedEdge as LineageEdge).to.revision - (lineage.lastVerifiedEdge as LineageEdge).from.revision !== 1) {
    throw new Error('LOCAL_STATE_INVALID');
  }
  if (lineage.lastVerifiedEdge && (lineage.lastVerifiedEdge as LineageEdge).to.revision === head.revision
    && (lineage.lastVerifiedEdge as LineageEdge).to.envelopeDigest !== head.envelopeDigest) throw new Error('LOCAL_STATE_INVALID');
};

export const verifiedRelayEtag = (received: string | null, verified: string): string => {
  if (received !== null && received !== verified) throw new Error('REMOTE_STATE_INVALID');
  return verified;
};
