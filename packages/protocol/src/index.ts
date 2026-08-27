import canonicalize from 'canonicalize';

export * from './runtime-config.js';

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
