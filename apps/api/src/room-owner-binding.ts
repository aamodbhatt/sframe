import type {SqlStorage} from 'cloudflare:workers';
import {decodeFixed32, encodeBase64Url, sha256} from './do-crypto.js';
import {parseUniqueJson} from '../../../packages/protocol/src/strict-json.js';
import canonicalize from 'canonicalize';

export type RoomOwnerBinding = {publisherPublicKey: string; viewerDescriptorDigest: string; editorDescriptorDigest: string};
export const initializeRoomOwnerBinding = (sql: SqlStorage): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS room_owner_binding (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    room_id TEXT NOT NULL, package_digest TEXT NOT NULL, publisher_key_id TEXT NOT NULL, publisher_public_key TEXT NOT NULL,
    viewer_descriptor_digest TEXT NOT NULL, editor_descriptor_digest TEXT NOT NULL, expires_at_ms INTEGER NOT NULL) STRICT`).toArray();
};
export const parseRoomOwnerBinding = (value: unknown): RoomOwnerBinding | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const owner = value as Record<string, unknown>;
  if (Object.keys(owner).sort().join() !== 'editorDescriptorDigest,publisherPublicKey,viewerDescriptorDigest') return null;
  if (![owner.publisherPublicKey, owner.viewerDescriptorDigest, owner.editorDescriptorDigest]
    .every((field) => typeof field === 'string' && decodeFixed32(field))) return null;
  return owner as RoomOwnerBinding;
};
export const roomOwnerKeyMatches = async (owner: RoomOwnerBinding, keyId: string): Promise<boolean> =>
  keyId === `sha256:${encodeBase64Url(await sha256(decodeFixed32(owner.publisherPublicKey)!))}`;

export const insertRoomOwnerBinding = (sql: SqlStorage, owner: RoomOwnerBinding, roomId: string,
  packageDigest: string, publisherKeyId: string, expiresAtMs: number): void => {
  sql.exec('INSERT INTO room_owner_binding VALUES(1,?,?,?,?,?,?,?)', roomId, packageDigest, publisherKeyId,
    owner.publisherPublicKey, owner.viewerDescriptorDigest, owner.editorDescriptorDigest, expiresAtMs).toArray();
};
export const roomOwnerBindingMatches = (sql: SqlStorage, owner: RoomOwnerBinding, roomId: string,
  packageDigest: string, publisherKeyId: string, expiresAtMs: number): boolean => {
  return sql.exec(`SELECT 1 FROM room_owner_binding WHERE singleton=1 AND room_id=? AND package_digest=?
    AND publisher_key_id=? AND publisher_public_key=? AND viewer_descriptor_digest=? AND editor_descriptor_digest=? AND expires_at_ms=?`,
  roomId, packageDigest, publisherKeyId, owner.publisherPublicKey, owner.viewerDescriptorDigest, owner.editorDescriptorDigest, expiresAtMs).toArray().length === 1;
};

// Retained pre-binding initialization is replayed as its original bytes. Permit
// only this additive private-field difference, never changed genesis or hashes.
export const compatibleLegacyRoomInitialization = (saved: string, supplied: string): boolean => {
  if (saved.length > 724_992 || supplied.length > 724_992) return false;
  try {
    const prior = parseUniqueJson(saved) as Record<string, unknown>;
    const next = parseUniqueJson(supplied) as Record<string, unknown>;
    if (!prior || !next || Object.hasOwn(prior, 'ownerBinding') || !parseRoomOwnerBinding(next.ownerBinding)) return false;
    if (Object.keys(prior).sort().join() !== 'editorCapHash,envelope,expiresAtMs,operationId,publisherKeyId,requestDigest,viewerCapHash') return false;
    const {ownerBinding: _owner, ...legacy} = next;
    return canonicalize(prior) === canonicalize(legacy);
  } catch { return false; }
};
