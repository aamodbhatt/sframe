import canonicalize from 'canonicalize';

export * from './runtime-config.js';
export * from './crypto-envelope.js';
export * from './room-descriptor.js';
export * from './enrollment.js';

export const PROTOCOL_VERSION = 1 as const;
export const CAPABILITIES = ['clipboard.write', 'export.download'] as const;
export type Capability = typeof CAPABILITIES[number];
export type PackageMode = 'personal' | 'shared';
export type Manifest = {
  schemaVersion: '1.0'; id: string; name: string; version: string; description: string;
  runtime: 'smallframe-view/1'; state: {mode: PackageMode; maxPlaintextBytes: number; publicTemplate?: unknown; jsonSchema: Record<string, unknown>};
  capabilities: Capability[]; limits: {maxViewNodes: number; maxEventRate: number};
  publisher: {displayName: string; publicKey: string; keyId: string}; files: {'app.worker.js': {sha256: string; bytes: number}};
};
export const canonicalJson = (value: unknown): string => {
  const result = canonicalize(value);
  if (result === undefined) throw new Error('CANONICALIZATION_FAILED');
  return result;
};
export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
export const scalarLength = (value: string): number => [...value].length;
export const hasBidiOrControl = (value: string): boolean => /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
export const isSafeText = (value: unknown, max: number): value is string => typeof value === 'string' && scalarLength(value.normalize('NFC')) <= max && !hasBidiOrControl(value);
export const isCanonicalBase64Url = (value: unknown, byteLength: number): value is string => typeof value === 'string' && value.length === Math.ceil(byteLength * 8 / 6) && !/[+=/]/.test(value) && /^[A-Za-z0-9_-]+$/.test(value);

export type VerifierResult =
  | {ok: true; packageDigest: string; artifactDigest: string; publisherKeyId: string}
  | {ok: false; error: {code: string}};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
};

export const parseVerifierResult = (encoded: string): VerifierResult => {
  const value: unknown = JSON.parse(encoded);
  if (!isRecord(value) || typeof value.ok !== 'boolean') throw new Error('VERIFIER_RESULT_SCHEMA');
  if (value.ok) {
    if (!hasExactKeys(value, ['ok', 'packageDigest', 'artifactDigest', 'publisherKeyId'])
      || !isCanonicalBase64Url(value.packageDigest, 32)
      || !isCanonicalBase64Url(value.artifactDigest, 32)
      || typeof value.publisherKeyId !== 'string'
      || !/^sha256:[A-Za-z0-9_-]{43}$/u.test(value.publisherKeyId)) throw new Error('VERIFIER_RESULT_SCHEMA');
    return value as VerifierResult;
  }
  if (!hasExactKeys(value, ['ok', 'error']) || !isRecord(value.error) || !hasExactKeys(value.error, ['code']) || typeof value.error.code !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(value.error.code)) {
    throw new Error('VERIFIER_RESULT_SCHEMA');
  }
  return value as VerifierResult;
};
