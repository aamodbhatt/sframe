import {randomBytes} from 'node:crypto';
import {getPublicKeyAsync} from '@noble/ed25519';
import {beforeEach, describe, expect, it} from 'vitest';
import canonicalize from 'canonicalize';
import {encodeBase64Url, sha256} from './crypto-envelope.js';
import {authenticateInvite, createSignedRoomDescriptor, formatInviteFragment, parseInviteFragment, verifyInviteRelayContext} from './room-descriptor.js';

describe('strict invite authentication', () => {
  let fragment: string;
  let publicKey: string;
  let signed: Awaited<ReturnType<typeof createSignedRoomDescriptor>>;
  const now = 1_800_000_000_000;
  beforeEach(async () => {
    const publisher = new Uint8Array(randomBytes(32));
    const writer = new Uint8Array(randomBytes(32));
    const cap = new Uint8Array(randomBytes(32));
    const pub = await getPublicKeyAsync(publisher);
    publicKey = encodeBase64Url(pub);
    signed = await createSignedRoomDescriptor({publisherPrivateKey: publisher, writerPublicKey: await getPublicKeyAsync(writer),
      publisherKeyId: `sha256:${encodeBase64Url(await sha256(pub))}`, roomId: encodeBase64Url(randomBytes(16)),
      packageDigest: encodeBase64Url(randomBytes(32)), capability: cap, role: 'editor', expiresAt: now + 60_000});
    fragment = formatInviteFragment({descriptorJcsBytes: signed.jcsBytes, descriptorSignature: signed.signature,
      roomKey: randomBytes(32), capability: cap, writerPrivateSeed: writer});
  });
  const replace = (key: string, value: string): string => {
    const params = new URLSearchParams(fragment);
    params.set(key, value);
    return params.toString();
  };
  const metadata = () => ({packageDigest: signed.descriptor.packageDigest, publisherKeyId: signed.descriptor.publisherKeyId,
    publisherPublicKey: publicKey, declaredMode: 'shared'});

  it('authenticates package publisher, signature, path and immutable expiry', async () => {
    const invite = await parseInviteFragment(fragment);
    await expect(authenticateInvite(invite, metadata(), `/r/${signed.descriptor.roomId}`, now)).resolves.toBeUndefined();
  });

  it.each(['unknown', 'duplicate', 'empty', 'padding', 'percent', 'oversized', 'wrong-cap', 'wrong-writer', 'viewer-writer', 'missing-writer'])('rejects %s fragment', async (kind) => {
    let mutated = fragment;
    if (kind === 'unknown') mutated += '&other=1';
    if (kind === 'duplicate') mutated = fragment.replace('v=1', 'v=1&v=1');
    if (kind === 'empty') mutated = replace('c', '');
    if (kind === 'padding') mutated = fragment + '=';
    if (kind === 'percent') mutated = fragment.replace('v=1', 'v=%31');
    if (kind === 'oversized') mutated = 'd=' + 'A'.repeat(4096);
    if (kind === 'wrong-cap') mutated = replace('c', encodeBase64Url(randomBytes(32)));
    if (kind === 'wrong-writer') mutated = replace('w', encodeBase64Url(randomBytes(32)));
    if (kind === 'viewer-writer') mutated = replace('d', encodeBase64Url(new TextEncoder().encode(canonicalize({...signed.descriptor, role: 'viewer'})!)));
    if (kind === 'missing-writer') { const params = new URLSearchParams(fragment); params.delete('w'); mutated = params.toString(); }
    await expect(parseInviteFragment(mutated)).rejects.toThrow();
  });

  it.each(['unknown', 'duplicate', 'whitespace', 'unsafe-expiry', 'role', 'null', 'oversized', 'utf8', 'noncanonical-bits'])('rejects %s descriptor bytes', async (kind) => {
    let json = new TextDecoder().decode(signed.jcsBytes);
    if (kind === 'unknown') json = canonicalize({...signed.descriptor, extra: 1})!;
    if (kind === 'duplicate') json = json.replace('{', '{"role":"editor",');
    if (kind === 'whitespace') json = ' ' + json;
    if (kind === 'unsafe-expiry') json = canonicalize({...signed.descriptor, expiresAt: Number.MAX_SAFE_INTEGER + 1})!;
    if (kind === 'role') json = canonicalize({...signed.descriptor, role: 'owner'})!;
    if (kind === 'null') json = 'null';
    if (kind === 'oversized') json = '{"x":"' + 'a'.repeat(1024) + '"}';
    if (kind === 'noncanonical-bits') json = canonicalize({...signed.descriptor, roomId: 'AAAAAAAAAAAAAAAAAAAAAB'})!;
    const bytes = kind === 'utf8' ? Uint8Array.of(0xff) : new TextEncoder().encode(json);
    await expect(parseInviteFragment(replace('d', encodeBase64Url(bytes)))).rejects.toThrow();
  });

  it.each(['signature', 'path', 'expiry', 'digest', 'publisher', 'public-key', 'personal-mode', 'signed-field'])('rejects %s trust substitution', async (kind) => {
    const invite = await parseInviteFragment(fragment);
    const meta = metadata();
    let path = `/r/${signed.descriptor.roomId}`;
    let at = now;
    if (kind === 'signature') invite.descriptorSignature[0] = invite.descriptorSignature[0]! ^ 1;
    if (kind === 'path') path = '/r/' + encodeBase64Url(randomBytes(16));
    if (kind === 'expiry') at = signed.descriptor.expiresAt;
    if (kind === 'digest') meta.packageDigest = encodeBase64Url(randomBytes(32));
    if (kind === 'publisher') meta.publisherKeyId = 'sha256:' + encodeBase64Url(randomBytes(32));
    if (kind === 'public-key') meta.publisherPublicKey = encodeBase64Url(randomBytes(32));
    if (kind === 'personal-mode') meta.declaredMode = 'personal';
    if (kind === 'signed-field') invite.descriptor.expiresAt += 1;
    await expect(authenticateInvite(invite, meta, path, at)).rejects.toThrow();
  });

  it.each(['roomId', 'packageDigest', 'writerPublicKey', 'expiresAtMs', 'role', 'capabilityHash', 'isRevoked'])('rejects relay %s mismatch', async (field) => {
    const invite = await parseInviteFragment(fragment);
    const d = invite.descriptor;
    const envelopeDigest = encodeBase64Url(new Uint8Array(32));
    const meta = {roomId: d.roomId, stateEpoch: 0, revision: 1, envelopeDigest, etag: `"sf1.0.1.${envelopeDigest}"`,
      packageDigest: d.packageDigest, writerPublicKey: d.writerPublicKey,
      expiresAtMs: d.expiresAt, role: d.role, capabilityHash: d.capabilityHash, isRevoked: false};
    expect(() => verifyInviteRelayContext(invite, meta)).not.toThrow();
    expect(() => verifyInviteRelayContext(invite, {...meta, [field]: null})).toThrow('INVITE_RELAY_CONTEXT_MISMATCH');
  });
});
